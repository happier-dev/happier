import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import type { SystemTaskBridgeListenerSet } from '@/components/systemTasks/types';
import { ApprovalRequestSchema } from '@happier-dev/protocol';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const bridge = vi.hoisted(() => ({ specs: [] as SystemTaskSpec[], cancelled: [] as string[], startError: undefined as unknown, responses: [] as { taskId: string; answer: unknown }[], listeners: new Map<string, SystemTaskBridgeListenerSet>() }));
// Native task transport is the external boundary; admission, Action policy,
// material resolution, task construction and runner remain real.
vi.mock('@/components/systemTasks/createNativeSshBridge', () => ({ createNativeSshBridge: () => ({
    start: async (spec: SystemTaskSpec) => { bridge.specs.push(spec); if (bridge.startError) throw bridge.startError; return `relay-${bridge.specs.length}`; },
    subscribe: async (id: string, listeners: SystemTaskBridgeListenerSet) => { bridge.listeners.set(id, listeners); return () => { bridge.listeners.delete(id); }; },
    cancel: async (id: string) => { bridge.cancelled.push(id); }, respond: async (taskId: string, answer: unknown) => { bridge.responses.push({ taskId, answer }); },
}) }));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'native');
const { storage } = await import('@/sync/domains/state/storage');
const [{ getActiveServerSnapshot }, { setActiveServerId },
    { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability }, { settingsParse },
    { getSystemTasksRunner }, { useRelayAccessControl }] = await Promise.all([
    import('@/sync/domains/server/serverRuntime'), import('@/sync/domains/server/serverProfiles'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime'), import('@/sync/domains/settings/settings'),
    import('@/components/systemTasks/systemTasksRuntime'), import('./useRelayAccessControl'),
]);

afterEach(async () => {
    await standardCleanup();
    publishAppliedActiveServerRuntimeAvailability(false);
    await home.reset();
    bridge.specs.length = 0;
    bridge.cancelled.length = 0;
    bridge.startError = undefined;
    bridge.responses.length = 0;
    bridge.listeners.clear();
});

async function openRelay(actionsSettingsV1: unknown) {
    const serverId = await home.addHome({ name: 'Issued Home', serverUrl: 'https://issued-relay-action.test', accountId: 'account' });
    const scope = { serverId, accountId: 'account' };
    const settings = { actionsSettingsV1 };
    storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse(settings) });
    const issued = getActiveServerSnapshot();
    publishAppliedActiveServerSnapshot(issued, true);
    home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: settings } } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
    home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
    home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
    const host = { id: 'issued-host', name: 'Issued host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
        ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
        content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
    const relay = await renderHook(() => useRelayAccessControl({ runner: getSystemTasksRunner(),
        target: { kind: 'ssh', ssh: { target: 'display-only@wrong.example', auth: 'agent' } }, upstreamUrl: 'https://wrong.test',
        remoteHost: { scope, hostId: host.id, expectedRevision: 4 } }));
    return { relay, host, serverId, issued };
}

it('policy denial prevents both actual relay Save and Disable from issuing a bridge task', async () => {
    const { relay } = await openRelay({ v: 1, actions: { 'remote_hosts.relay.configure': { enabled: false } } });
    await act(async () => {
        expect(await relay.getCurrent().configure({ providerId: 'lan', config: { providerId: 'lan', url: 'https://relay.test' } })).toBeNull();
        expect(await relay.getCurrent().disable()).toBeNull();
    });
    expect(bridge.specs.filter(spec => spec.kind !== 'relay.access.status.v1')).toEqual([]);
});

it('a non-UI client runtime Action waits on its own native runner and returns the terminal failure', async () => {
    const { serverId } = await openRelay({ v: 1, approvalWaivedSurfaces: { 'relay.runtime.restart': ['mcp'] } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const execute = createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute;
    const context = { surface: 'mcp' as const, serverId, expectedAccountId: 'account' };
    let settled = false;
    const pending = execute('relay.runtime.restart', { runtimeTarget: { channel: 'preview', mode: 'user' } }, context)
        .then(outcome => { settled = true; return outcome; });
    await vi.waitFor(() => expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.restart.v1')).toBe(true));
    const taskId = `relay-${bridge.specs.findIndex(spec => spec.kind === 'relay.runtime.restart.v1') + 1}`;
    await vi.waitFor(() => expect(bridge.listeners.has(taskId)).toBe(true));
    expect(settled).toBe(false);
    const terminal = { protocolVersion: 1 as const, taskId, ok: false as const, error: { code: 'restart_failed', message: 'Runtime could not start' } };
    bridge.listeners.get(taskId)?.onResult(terminal);
    expect(await pending).toEqual({ ok: true, result: { status: 'completed', taskId, result: terminal } });
    expect(getSystemTasksRunner().getTaskSpec?.(taskId)).toMatchObject({ kind: 'relay.runtime.restart.v1', params: { channel: 'preview', mode: 'user' } });
});

it('a native restart Action preserves a dispatched start with a lost acknowledgement', async () => {
    const { serverId } = await openRelay({ v: 1, approvalWaivedSurfaces: { 'relay.runtime.restart': ['mcp'] } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    bridge.startError = markRpcRequestDisposition(new Error('Native acknowledgement lost'), 'outcomeUnknown');
    const outcome = await createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute(
        'relay.runtime.restart', {}, { surface: 'mcp', serverId, expectedAccountId: 'account' });
    expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.restart.v1')).toBe(true);
    expect(outcome).toEqual({ ok: true, result: { status: 'outcome_unknown' } });
});

it('an agent-started erase refuses an incomplete native preview rather than leaving the task unanswered', async () => {
    const { serverId } = await openRelay({ v: 1, approvalWaivedSurfaces: { 'relay.runtime.personal_home.erase': ['mcp'] } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const pending = createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute(
        'relay.runtime.personal_home.erase', {}, { surface: 'mcp', serverId, expectedAccountId: 'account' });
    await vi.waitFor(() => expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(true));
    const taskId = `relay-${bridge.specs.findIndex(spec => spec.kind === 'relay.runtime.personal_home.erase.v1') + 1}`;
    await vi.waitFor(() => expect(bridge.listeners.has(taskId)).toBe(true));
    bridge.listeners.get(taskId)?.onEvent({ protocolVersion: 1, taskId, type: 'prompt', tsMs: 1, stepId: 'erase', data: {
        kind: 'personal_home.confirm_erase.v1', canonicalServerUrl: 'https://erase.test', homeServerIdentityId: 'erase-home',
        paths: ['/owned/home'], estimatedBytes: 100, previewComplete: false, previewReason: 'inspection_failed',
    } });
    try {
        await vi.waitFor(() => expect(bridge.responses).toContainEqual({ taskId, answer: { confirmed: false } }));
    } finally {
        bridge.listeners.get(taskId)?.onResult({ protocolVersion: 1, taskId, ok: false, error: { code: 'not_confirmed', message: 'Erase refused' } });
        await pending;
    }
});

it('a non-UI remote relay configure Action observes its admitted native task to completion', async () => {
    const { serverId, host } = await openRelay({ v: 1,
        approvalWaivedSurfaces: { 'remote_hosts.relay.configure': ['mcp'] } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const pending = createDefaultActionExecutor().execute('remote_hosts.relay.configure', {
        hostId: host.id, expectedRevision: 4,
        operation: { kind: 'configure', config: { providerId: 'lan', url: 'https://relay.test' } },
    }, { surface: 'mcp', serverId, expectedAccountId: 'account' });
    await vi.waitFor(() => expect(bridge.specs.some(spec => spec.kind === 'relay.access.configure.v1')).toBe(true));
    const taskId = `relay-${bridge.specs.findIndex(spec => spec.kind === 'relay.access.configure.v1') + 1}`;
    await vi.waitFor(() => expect(bridge.listeners.has(taskId)).toBe(true));
    const terminal = { protocolVersion: 1 as const, taskId, ok: false as const,
        error: { code: 'configure_failed', message: 'Relay configuration failed' } };
    bridge.listeners.get(taskId)?.onResult(terminal);
    expect(await pending).toEqual({ ok: true, result: { status: 'completed', taskId, result: terminal } });
});

it('waived Save and Disable share the Action task owner and captured host/Home, ignoring staged focus', async () => {
    const { relay, host, serverId, issued } = await openRelay({ v: 1,
        approvalWaivedSurfaces: { 'remote_hosts.relay.configure': ['ui'] } });
    const focusedId = await home.addHome({ name: 'Staged Home', serverUrl: 'https://staged-relay-action.test', accountId: 'other', active: false });
    await act(async () => { await setActiveServerId(focusedId, { scope: 'device' }); });
    await act(async () => {
        expect(await relay.getCurrent().configure({ providerId: 'lan', config: { providerId: 'lan', url: 'https://relay.test' } })).not.toBeNull();
        expect(await relay.getCurrent().disable()).not.toBeNull();
    });
    expect(bridge.specs.find(spec => spec.kind === 'relay.access.configure.v1')).toMatchObject({ params: {
        upstreamUrl: issued.serverUrl, target: { kind: 'ssh', ssh: { target: host.ssh.target } },
        config: { providerId: 'lan', url: 'https://relay.test' },
    } });
    expect(bridge.specs.find(spec => spec.kind === 'relay.access.disable.v1')).toMatchObject({ params: {
        target: { kind: 'ssh', ssh: { target: host.ssh.target } },
    } });
    expect(home.requestsFor('/v1/account/entity-rows/remote-hosts').every(request => request.serverId === serverId)).toBe(true);
    expect(home.requestsFor('/v1/account/entity-rows/remote-hosts').length).toBeGreaterThan(0);
});

it.each(['configure', 'configureLan', 'configureLanCredentials', 'disable'] as const)('default Ask first renders the safe %s intent and holds it until the live user approval decision', async operation => {
    const { relay, serverId, host, issued } = await openRelay({ v: 1 });
    const operationKind = operation === 'disable' ? 'disable' : 'configure';
    const config = operation === 'configureLan' || operation === 'configureLanCredentials'
        ? { providerId: 'lan' as const, url: operation === 'configureLanCredentials'
            ? 'https://lan-user:lan-password@relay.example.test/relay?token=lan-query-secret#lan-fragment-secret'
            : 'http://localhost:3000' }
        : { providerId: 'cloudflareNamed' as const, hostname: 'relay.example.test', token: 'live-relay-token' };
    let pending!: Promise<string | null>;
    await act(async () => {
        pending = operationKind === 'configure'
            ? relay.getCurrent().configure({ providerId: config.providerId, config })
            : relay.getCurrent().disable();
    });
    const approval = await waitForHomeGovernance(() => {
        const row = home.artifacts(serverId).list().find(row => {
            const body = home.artifacts(serverId).readPlainBody(row.id);
            return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
        });
        expect(row).toBeDefined();
        return row!;
    });
    const request = ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(approval.id) ?? 'null'));
    expect(request).toMatchObject({ status: 'open', actionId: 'remote_hosts.relay.configure',
        approval: { flow: 'blocking', result: 'required' } });
    const { describeApprovalActionFields } = await import('@happier-dev/protocol/actions');
    const { ActionApprovalFieldsCard } = await import('@/components/approvals/ActionApprovalFieldsCard');
    const presentation = describeApprovalActionFields(request);
    const details = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} serverId={serverId} />);
    const text = details.getTextContent();
    expect(text).toContain(host.id);
    expect(text).toContain(operationKind);
    expect(presentation.unrepresentable).toBeNull();
    if (operationKind === 'configure') {
        expect(text).toContain(config.providerId);
        expect(text).toContain(operation === 'configureLanCredentials' ? 'https://relay.example.test/relay'
            : 'url' in config ? config.url : config.hostname);
    } else {
        expect(text).not.toContain('cloudflareNamed');
        expect(text).not.toContain('relay.example.test');
    }
    expect(text).not.toContain('live-relay-token');
    expect(JSON.stringify(request)).not.toContain('live-relay-token');
    for (const secret of ['lan-user', 'lan-password', 'lan-query-secret', 'lan-fragment-secret']) {
        expect(text).not.toContain(secret);
        expect(JSON.stringify(request)).not.toContain(secret);
    }
    expect(bridge.specs.filter(spec => spec.kind !== 'relay.access.status.v1')).toEqual([]);
    const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
    const decision = await renderHook(() => useApprovalDecisionHandler({ id: approval.id, header: null }, request, '', serverId));
    await act(async () => {
        expect(await decision.getCurrent()('approve')).toBe(true);
        expect(await pending).not.toBeNull();
    });
    const mutation = bridge.specs.find(spec => spec.kind === `relay.access.${operationKind}.v1`);
    expect(mutation).toMatchObject({ params: { target: { kind: 'ssh', ssh: { target: host.ssh.target } } } });
    if (operationKind === 'configure') expect(mutation).toMatchObject({ params: {
        upstreamUrl: issued.serverUrl, config,
    } });
});
