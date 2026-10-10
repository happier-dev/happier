import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);

// Keep the real selection, Account admission, material resolver, task builders
// and runner; only Home HTTP/device credentials and the native task bridge leave the process.
// Complete the consumed storage root before starting its importing Account owners.
// Concurrent cold roots previously stopped during collection, before either test body.
const { storage } = await import('@/sync/domains/state/storage');
const [{ getActiveServerSnapshot }, { setActiveServerId },
    { getActiveServerAccountScope }, { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability },
    { settingsParse }, { createSystemTaskRunner }, { useRemoteHostOutcomeActions }, { useRelayAccessControl }] = await Promise.all([
    import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/server/serverProfiles'), import('@/sync/domains/scope/activeServerAccountScope'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime'), import('@/sync/domains/settings/settings'),
    import('@/components/systemTasks/createSystemTaskRunner'), import('./useRemoteHostOutcomeActions'),
    import('@/components/settings/server/relayAccess/useRelayAccessControl'),
]);

afterEach(async () => {
    await standardCleanup();
    publishAppliedActiveServerRuntimeAvailability(false);
    await home.reset();
});

it('uses the admitted Home upstream in the actual relay task after another Home is staged into focus', async () => {
    const serverId = await home.addHome({ name: 'Issued Home', serverUrl: 'https://issued-relay-task.test', accountId: 'account' });
    const focusedId = await home.addHome({ name: 'Staged Home', serverUrl: 'https://staged-relay-task.test', accountId: 'other', active: false });
    const scope = { serverId, accountId: 'account' };
    storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse({}) });
    const issuedSnapshot = getActiveServerSnapshot();
    publishAppliedActiveServerSnapshot(issuedSnapshot, true);
    const host = { id: 'issued-host', name: 'Issued host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
        ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
    home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
    home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
    home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
        content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
    const acceptedSpecs: SystemTaskSpec[] = [];
    const runner = createSystemTaskRunner({ mode: 'native', bridge: {
        start: async spec => { acceptedSpecs.push(spec); return `native-relay-${acceptedSpecs.length}`; },
        subscribe: async () => () => {}, cancel: async () => {}, respond: async () => {},
    } });
    const outcomes = await renderHook(() => useRemoteHostOutcomeActions({ runner, remoteHosts: [host], scope,
        catalogRevision: 4, secretMaterialAllowed: false }));
    await act(async () => { await setActiveServerId(focusedId, { scope: 'device' }); });
    expect(getActiveServerSnapshot().serverId).toBe(focusedId);
    expect(getActiveServerAccountScope()).toEqual(scope);
    await act(async () => { outcomes.getCurrent().selectRelayAccess(host); });
    const selection = outcomes.getCurrent().relayAccessSelection;
    if (!selection) throw new Error('Expected an addressed relay selection');
    const relay = await renderHook(() => useRelayAccessControl({ runner, target: selection.target,
        upstreamUrl: selection.upstreamUrl, runWithTarget: outcomes.getCurrent().runRelayAccessTask }));
    let taskId: string | null = null;
    await act(async () => {
        taskId = await relay.getCurrent().configure({ providerId: 'lan', config: { providerId: 'lan', url: 'https://published-relay.test' } });
    });
    expect(taskId).not.toBeNull();
    expect(acceptedSpecs.find(spec => spec.kind === 'relay.access.configure.v1')).toMatchObject({
        params: { upstreamUrl: issuedSnapshot.serverUrl, target: { kind: 'ssh', ssh: { target: host.ssh.target } } },
    });
    expect(home.requestsFor('/v1/account/entity-rows/remote-hosts').length).toBeGreaterThan(0);
    expect(home.requestsFor('/v1/account/entity-rows/remote-hosts').every(request => request.serverId === serverId)).toBe(true);
});
