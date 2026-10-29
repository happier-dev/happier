import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup, flushHookEffects, createDeferred } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { OtherAccountFollowV1Schema, type OtherAccountFollowV1, type PersonalRunFollowOnceV1, type PersonalRunFollowOnceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { RunFollowOccurrenceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { OtherFollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/followSourceRefTransportV1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

// Only credential storage, HTTP, Socket.IO and native rendering are replaced.
const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { RunWorkNotifications, RunWorkNotifyOperation } = await import('./RunWorkNotifications');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } = await import('@happier-dev/protocol/sessions/follow/changes');
const { InboxExecutionRunSourceBoundary, useInboxExecutionRunCount, useInboxExecutionRunSource } = await import('@/hooks/inbox/useInboxExecutionRunSource');
const { notifyExecutionRunActivityFromUpdate } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
const original = storage.getState();
const executionRunCapabilities = { protocolVersion: 1, results: {
    'tool.executionRuns': { ok: true, checkedAt: 1, data: { protocolVersion: 2, features: { detachedScope: true } } },
} };

beforeEach(() => network.resetRequests());
afterEach(async () => { await standardCleanup(); storage.setState(original, true); });
afterAll(() => network.dispose());

async function setup(source: Extract<OtherFollowSourceRefV1, { kind: 'execution_run' | 'workflow_run' }>) {
    const home = await network.addHome(`https://run-follow-${source.runId}.test`, 'run-account');
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features:
        createRootLayoutFeaturesResponse({ features: { sessions: { following: { enabled: true } } } }) } });
    publishAppliedActiveServerRuntimeAvailability(false);
    setActiveServerId(home.id);
    storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
    storage.setState(state => ({ settings: { ...state.settings, experiments: true,
        featureToggles: { ...state.settings.featureToggles, 'execution.runs': true } } }));
    publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
    network.respond(RPC_METHODS.CAPABILITIES_DETECT, executionRunCapabilities);
    const path = '/v2/account/follows/sources';
    const writes: unknown[] = [];
    let once: PersonalRunFollowOnceV1[] = [];
    let onceDeliveries: PersonalRunFollowOnceOccurrenceV1[] = [];
    let persistent = true;
    let additionalFollows: readonly OtherAccountFollowV1[] = [];
    let failWrite = false;
    let writeGate: Promise<void> | undefined;
    const follow = () => OtherAccountFollowV1Schema.parse({ source, following: true, persistent,
        policy: { preset: 'quiet' }, once, onceDeliveries });
    const listPath = new URL(resolveSessionFollowActionRequest('follow.list', { receiver: { kind: 'account' }, direction: 'following' }).path,
        home.serverUrl).pathname;
    network.setHttpResponder(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === listPath) return Response.json({ follows: [follow(), ...additionalFollows] });
        if (url.pathname !== path) return null;
        expect(JSON.parse(url.searchParams.get('sourceRef') ?? 'null')).toEqual(source);
        if (init?.method === 'PUT') {
            const body: unknown = JSON.parse(String(init.body));
            writes.push(body);
            await writeGate;
            if (failWrite) return Response.json({ error: 'source_unavailable' }, { status: 503 });
            if (!body || typeof body !== 'object' || !('once' in body) || !Array.isArray(body.once)) throw new Error('Expected one-shot-only mutation');
            once = OtherAccountFollowV1Schema.parse({ source, following: true, persistent: true,
                policy: { preset: 'quiet' }, once: body.once }).once ?? [];
            if ('clearOnceDeliveries' in body && body.clearOnceDeliveries === true) onceDeliveries = [];
            return Response.json({ changed: true, follow: follow() });
        }
        return Response.json({ follow: follow() });
    });
    return { home, path, writes, follow, setOnce: (value: PersonalRunFollowOnceV1[]) => { once = value; },
        failWrite: () => { failWrite = true; },
        holdWrites: (gate: Promise<void>) => { writeGate = gate; },
        setDeliveries: (value: PersonalRunFollowOnceOccurrenceV1[]) => { onceDeliveries = value; },
        oneShotOnly: () => { persistent = false; },
        setAdditionalFollows: (value: readonly OtherAccountFollowV1[]) => { additionalFollows = value; },
        listReads: () => network.httpRequests.filter(request => new URL(request.url).pathname === listPath).length,
        reads: () => network.httpRequests.filter(request => new URL(request.url).pathname === path).length - writes.length };
}

describe('Run Notify me through personal Follow', () => {
    it('reads the exact Workflow Follow rather than an authored Habit inventory', async () => {
        const home = await network.addHome('https://run-follow.test', 'run-account');
        primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features:
            createRootLayoutFeaturesResponse({ features: { sessions: { following: { enabled: true } } } }) } });
        publishAppliedActiveServerRuntimeAvailability(false);
        setActiveServerId(home.id);
        storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
        publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
        const path = '/v2/account/follows/sources';
        network.setHttpResponder(async input => new URL(String(input)).pathname === path
            ? Response.json({ follow: null }) : null);
        const screen = await renderScreen(<RunWorkNotifications source={{ kind: 'workflow_run', runId: 'workflow-one' }} serverId={home.id} />);
        expect(getActiveServerAccountScope()).toEqual({ serverId: home.id, accountId: home.accountId });
        expect(screen.root.findAllByType(RunWorkNotifyOperation)).toHaveLength(1);
        await vi.waitFor(() => expect(network.httpRequests.map(request => new URL(request.url).pathname)).toContain(path));
        expect(network.httpRequests.filter(request => new URL(request.url).pathname.includes('automation'))).toHaveLength(0);
        await screen.unmount();
    });

    it.each([
        { kind: 'execution_run', sessionId: 'source-session', runId: 'session-run' },
        { kind: 'execution_run', machineId: 'machine-one', runId: 'detached-run' },
        { kind: 'workflow_run', runId: 'workflow-run' },
    ] as const)('arms and cancels $runId without replacing its persistent policy', async source => {
        const owner = await setup(source);
        const screen = await renderScreen(<RunWorkNotifications source={source} serverId={owner.home.id} />);
        await vi.waitFor(() => expect(screen.findByTestId(`notify-run-terminal-switch:${source.runId}`)?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync(`notify-run-terminal:${source.runId}`);
        expect(owner.writes).toEqual([{ once: [{ kind: 'run_settled' }] }]);
        expect(screen.findByTestId(`notify-run-terminal-switch:${source.runId}`)?.props.value).toBe(true);
        await screen.pressByTestIdAsync(`notify-run-terminal-cancel:${source.runId}`);
        expect(owner.writes).toEqual([{ once: [{ kind: 'run_settled' }] }, { once: [] }]);
        expect(owner.follow()).toMatchObject({ persistent: true, policy: { preset: 'quiet' }, once: [] });
        expect(network.httpRequests.filter(request => new URL(request.url).pathname.includes('automation'))).toHaveLength(0);
    });

    it('keeps Workflow terminal and needs-you intents independent', async () => {
        const source = { kind: 'workflow_run', runId: 'independent' } as const;
        const owner = await setup(source);
        const screen = await renderScreen(<RunWorkNotifications source={source} serverId={owner.home.id} />);
        await vi.waitFor(() => expect(screen.findByTestId('notify-run-terminal-switch:independent')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('notify-run-terminal:independent');
        await screen.pressByTestIdAsync('notify-run-needs_attention:independent');
        expect(owner.writes).toEqual([{ once: [{ kind: 'run_settled' }] },
            { once: [{ kind: 'run_settled' }, { kind: 'first_needs_you' }] }]);
        await screen.pressByTestIdAsync('notify-run-terminal-cancel:independent');
        expect(owner.writes.at(-1)).toEqual({ once: [{ kind: 'first_needs_you' }] });
        expect(screen.findByTestId('notify-run-needs_attention-switch:independent')?.props.value).toBe(true);
    });

    it('acknowledges arming only after the Follow owner commits', async () => {
        const source = { kind: 'workflow_run', runId: 'commit-acknowledgement' } as const;
        const owner = await setup(source);
        const gate = createDeferred<void>();
        owner.holdWrites(gate.promise);
        const screen = await renderScreen(<RunWorkNotifications source={source} serverId={owner.home.id} />);
        await vi.waitFor(() => expect(screen.findByTestId(`notify-run-terminal-switch:${source.runId}`)?.props.disabled).toBe(false));
        await act(async () => { screen.pressByTestId(`notify-run-terminal:${source.runId}`); });
        await vi.waitFor(() => expect(owner.writes).toHaveLength(1));
        expect(screen.findByTestId(`notify-run-terminal-switch:${source.runId}`)?.props.value).toBe(false);
        expect(screen.findByTestId(`notify-run-needs_attention-switch:${source.runId}`)?.props.disabled).toBe(true);
        await act(async () => publishHomeAccountChange(owner.home.id, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
        expect(owner.reads()).toBe(2);
        await act(async () => gate.resolve());
        await vi.waitFor(() => expect(screen.findByTestId(`notify-run-terminal-switch:${source.runId}`)?.props.value).toBe(true));
        await vi.waitFor(() => expect(owner.reads()).toBe(3));
    });

    it.each(['commitPlan', 'walkthrough'] as const)('arms the exact detached %s output without reading a UI baseline', async output => {
        const source = { kind: 'execution_run', machineId: 'machine-one', runId: `output-${output}` } as const;
        const owner = await setup(source);
        const screen = await renderScreen(<RunWorkNotifications source={source} serverId={owner.home.id}
            selectedOutput={{ output, comparisonId: 'comparison-one', resultId: 'saved-one' }} />);
        await vi.waitFor(() => expect(screen.findByTestId(`notify-run-terminal-switch:${source.runId}`)?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync(`notify-run-terminal:${source.runId}`);
        expect(owner.writes).toEqual([{ once: [{ kind: 'output_ready', outputRef: {
            kind: 'scm_diff_summary', output, comparisonId: 'comparison-one', resultId: 'saved-one',
        } }] }]);
        expect(network.requests.filter(request => request.method.includes('execution.run'))).toHaveLength(0);
        // The source-owned captured baseline does not change which output is armed.
        owner.setOnce([{ kind: 'output_ready', outputRef: { kind: 'scm_diff_summary', output,
            comparisonId: 'comparison-one', resultId: 'saved-one' }, afterRevision: 4 }]);
        await act(async () => publishHomeAccountChange(owner.home.id, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
        await vi.waitFor(() => expect(owner.reads()).toBe(3));
        expect(screen.findByTestId(`notify-run-terminal-switch:${source.runId}`)?.props.value).toBe(true);
    });

    it('keeps another selected output armed when the Commit proposal is cancelled', async () => {
        const source = { kind: 'execution_run', machineId: 'machine-one', runId: 'two-outputs' } as const;
        const owner = await setup(source);
        const walkthrough = { kind: 'output_ready', outputRef: { kind: 'scm_diff_summary', output: 'walkthrough',
            comparisonId: 'comparison-one', resultId: 'saved-one' }, afterRevision: 4 } as const;
        owner.setOnce([walkthrough]);
        const screen = await renderScreen(<RunWorkNotifications source={source} serverId={owner.home.id}
            selectedOutput={{ output: 'commitPlan', comparisonId: 'comparison-one', resultId: 'saved-one' }} />);
        await vi.waitFor(() => expect(screen.findByTestId('notify-run-terminal-switch:two-outputs')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('notify-run-terminal:two-outputs');
        expect(owner.writes[0]).toEqual({ once: [walkthrough, { kind: 'output_ready', outputRef: {
            kind: 'scm_diff_summary', output: 'commitPlan', comparisonId: 'comparison-one', resultId: 'saved-one',
        } }] });
        await screen.pressByTestIdAsync('notify-run-terminal-cancel:two-outputs');
        expect(owner.writes.at(-1)).toEqual({ once: [walkthrough] });
        expect(owner.follow()).toMatchObject({ persistent: true, policy: { preset: 'quiet' }, once: [walkthrough] });
    });

    it('does not clear an unread output receipt when another intent is toggled', async () => {
        const source = { kind: 'execution_run', machineId: 'machine-one', runId: 'unread-output' } as const;
        const owner = await setup(source);
        const receipt = RunFollowOccurrenceV1Schema.parse({ original: { source, output: { outputRef: {
            kind: 'scm_diff_summary', output: 'walkthrough', comparisonId: 'comparison-one', resultId: 'saved-one',
        }, revision: 5, state: 'complete' } }, event: { kind: 'update_posted' } });
        owner.setDeliveries([receipt]);
        const screen = await renderScreen(<RunWorkNotifications source={source} serverId={owner.home.id} />);
        await vi.waitFor(() => expect(screen.findByTestId('notify-run-terminal-switch:unread-output')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('notify-run-terminal:unread-output');
        await screen.pressByTestIdAsync('notify-run-terminal-cancel:unread-output');
        expect(owner.writes).toEqual([{ once: [{ kind: 'run_settled' }] }, { once: [] }]);
        expect(owner.follow().onceDeliveries).toEqual([receipt]);
    });

    it('counts a source receipt without reading a Run body and clears it only on explicit open', async () => {
        const source = { kind: 'execution_run', machineId: 'machine-one', runId: 'receipt-demand' } as const;
        const owner = await setup(source);
        owner.oneShotOnly();
        owner.setOnce([{ kind: 'run_settled' }]);
        let count = -1;
        let detail: ReturnType<typeof useInboxExecutionRunSource> | null = null;
        const readDetail = (): ReturnType<typeof useInboxExecutionRunSource> | null => detail;
        function Count() { count = useInboxExecutionRunCount(); return null; }
        function Detail() { detail = useInboxExecutionRunSource(); return null; }
        const tree = (opened: boolean) => <InboxExecutionRunSourceBoundary><Count />{opened ? <Detail /> : null}</InboxExecutionRunSourceBoundary>;
        const screen = await renderScreen(tree(false));
        await vi.waitFor(() => expect(owner.listReads()).toBe(1));
        expect(count).toBe(0);
        expect(network.requests).toHaveLength(0);
        const receipt = RunFollowOccurrenceV1Schema.parse({ original: { source, terminalEventId: 'terminal-one' }, event: { kind: 'finished' } });
        const remaining = { kind: 'first_needs_you' } as const;
        owner.setOnce([remaining]);
        owner.setDeliveries([receipt]);
        await act(async () => publishHomeAccountChange(owner.home.id, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
        await vi.waitFor(() => expect(count).toBe(1));
        expect(network.requests).toHaveLength(0);
        const header = ExecutionRunGetResponseSchema.parse({ run: { runId: source.runId, callId: 'call', sidechainId: 'sidechain',
            intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
            retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 } });
        network.respond(SESSION_RPC_METHODS.EXECUTION_RUN_GET, header);
        await screen.update(tree(true));
        await vi.waitFor(() => expect(readDetail()?.entries).toHaveLength(1));
        expect(network.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toMatchObject([
            { targetId: source.machineId, payload: { runId: source.runId, includeStructured: false, includeLatestToolResult: false } },
        ]);
        const reads = owner.listReads();
        const runReads = network.requests.length;
        await act(async () => {
            for (let index = 0; index < 1_000; index++) publishHomeAccountChange(owner.home.id, [`unrelated-${index}`], { changeKinds: ['session'] });
            notifyExecutionRunActivityFromUpdate(owner.home.id, { type: 'execution-run-updated', machineId: source.machineId, runId: 'another-run' });
        });
        await flushHookEffects();
        expect(owner.listReads()).toBe(reads);
        expect(network.requests).toHaveLength(runReads);
        network.setRpcAckResponder(async request => request.method === RPC_METHODS.CAPABILITIES_DETECT
            ? { ok: true, result: executionRunCapabilities }
            : { ok: false, error: 'execution_run_not_found', errorCode: 'execution_run_not_found' });
        await act(async () => notifyExecutionRunActivityFromUpdate(owner.home.id,
            { type: 'execution-run-updated', machineId: source.machineId, runId: source.runId }));
        await vi.waitFor(() => expect(readDetail()?.failed).toBe(true));
        expect(count).toBe(0);
        expect(readDetail()?.entries).toEqual([]);
        expect(owner.follow().onceDeliveries).toEqual([receipt]);
        const unavailableReads = network.requests.length;
        await screen.update(tree(false));
        expect(count).toBe(0);
        expect(network.requests).toHaveLength(unavailableReads);
        await screen.update(tree(true));
        expect(count).toBe(0);
        expect(readDetail()?.entries).toEqual([]);
        network.setRpcAckResponder(async request => ({ ok: true,
            result: request.method === RPC_METHODS.CAPABILITIES_DETECT ? executionRunCapabilities : header }));
        await act(async () => notifyExecutionRunActivityFromUpdate(owner.home.id,
            { type: 'execution-run-updated', machineId: source.machineId, runId: source.runId }));
        await vi.waitFor(() => expect(count).toBe(1));
        expect(readDetail()?.failed).toBe(false);
        expect(readDetail()?.entries).toHaveLength(1);
        let currentHeader = header;
        network.setRpcAckResponder(async request => ({ ok: true,
            result: request.method === RPC_METHODS.CAPABILITIES_DETECT ? executionRunCapabilities : currentHeader }));
        await act(async () => readDetail()?.markOpened(source));
        expect(owner.writes).toEqual([{ once: [remaining], clearOnceDeliveries: true }]);
        expect(owner.follow()).toMatchObject({ policy: { preset: 'quiet' }, persistent: false, once: [remaining], onceDeliveries: [] });
        await vi.waitFor(() => expect(count).toBe(0));
        owner.setOnce([]);
        owner.setDeliveries([RunFollowOccurrenceV1Schema.parse({ original: { source,
            permissionRequests: [{ requestId: 'permission-one', createdAt: 3 }] }, event: { kind: 'needs_you', type: 'approval' } })]);
        currentHeader = ExecutionRunGetResponseSchema.parse({ run: { ...header.run, status: 'running',
            finishedAtMs: undefined, attention: { kind: 'permission_required', requestIds: ['permission-one'] } } });
        await act(async () => publishHomeAccountChange(owner.home.id, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
        await vi.waitFor(() => expect(readDetail()?.entries[0]?.run.attention?.requestIds).toEqual(['permission-one']));
        expect(count).toBe(1);
        const censusReads = owner.listReads();
        currentHeader = ExecutionRunGetResponseSchema.parse({ run: { ...header.run, status: 'running', finishedAtMs: undefined } });
        await act(async () => notifyExecutionRunActivityFromUpdate(owner.home.id,
            { type: 'execution-run-updated', machineId: source.machineId, runId: source.runId }));
        await vi.waitFor(() => expect(count).toBe(0));
        expect(readDetail()?.entries).toEqual([]);
        expect(owner.listReads()).toBe(censusReads);
    });

    it('does not refetch another demanded Machine header when one Run receipt changes', async () => {
        const source = { kind: 'execution_run', machineId: 'machine-a', runId: 'count-locality-a' } as const;
        const other = { kind: 'execution_run', machineId: 'machine-b', runId: 'count-locality-b' } as const;
        const owner = await setup(source);
        owner.oneShotOnly();
        owner.setOnce([{ kind: 'run_settled' }]);
        owner.setAdditionalFollows([OtherAccountFollowV1Schema.parse({ source: other, following: true, persistent: false,
            policy: { preset: 'quiet' }, once: [], onceDeliveries: [RunFollowOccurrenceV1Schema.parse({ original: { source: other,
                permissionRequests: [{ requestId: 'permission-b', createdAt: 1 }] }, event: { kind: 'needs_you', type: 'approval' } })] })]);
        network.setRpcResponder(async request => {
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return executionRunCapabilities;
            expect(request.method).toBe(SESSION_RPC_METHODS.EXECUTION_RUN_GET);
            expect(request.targetId).toBe(other.machineId);
            return ExecutionRunGetResponseSchema.parse({ run: { runId: other.runId, callId: 'call', sidechainId: 'sidechain',
                intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
                retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 1,
                attention: { kind: 'permission_required', requestIds: ['permission-b'] } } });
        });
        let count = -1;
        function Count() { count = useInboxExecutionRunCount(); return null; }
        const screen = await renderScreen(<InboxExecutionRunSourceBoundary><Count /></InboxExecutionRunSourceBoundary>);
        await vi.waitFor(() => expect(count).toBe(1));
        expect(network.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toHaveLength(1);
        const physicalReads = network.requests.length;
        owner.setOnce([]);
        owner.setDeliveries([RunFollowOccurrenceV1Schema.parse({ original: { source, terminalEventId: 'terminal-a' }, event: { kind: 'finished' } })]);
        await act(async () => publishHomeAccountChange(owner.home.id, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
        await vi.waitFor(() => expect(count).toBe(2));
        await act(async () => {
            for (let index = 0; index < 1_000; index++) publishHomeAccountChange(owner.home.id, [`unrelated-${index}`], { changeKinds: ['artifact'] });
        });
        await flushHookEffects();
        expect(network.requests).toHaveLength(physicalReads);
        expect(owner.listReads()).toBe(2);
        await screen.unmount();
    });

    it('keeps last committed state on refusal and refreshes fulfillment without unrelated reads', async () => {
        const source = { kind: 'execution_run', machineId: 'machine-one', runId: 'read-demand' } as const;
        const owner = await setup(source);
        owner.setOnce([{ kind: 'run_settled' }]);
        const screen = await renderScreen(<RunWorkNotifications source={source} serverId={owner.home.id} />);
        await vi.waitFor(() => expect(screen.findByTestId('notify-run-terminal-switch:read-demand')?.props.value).toBe(true));
        await act(async () => {
            for (let index = 0; index < 1_000; index++) publishHomeAccountChange(owner.home.id, [`unrelated-${index}`],
                { changeKinds: [index % 2 ? 'session' : 'artifact'] });
        });
        await flushHookEffects();
        expect(owner.reads()).toBe(1);
        owner.failWrite();
        await screen.pressByTestIdAsync('notify-run-terminal-cancel:read-demand');
        expect(screen.findByTestId('notify-run-terminal-switch:read-demand')?.props.value).toBe(true);
        expect(screen.findByTestId('notify-run-terminal-error:read-demand')).not.toBeNull();
        owner.setOnce([]);
        await act(async () => publishHomeAccountChange(owner.home.id, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
        await vi.waitFor(() => expect(screen.findByTestId('notify-run-terminal-switch:read-demand')?.props.value).toBe(false));
    });
});
