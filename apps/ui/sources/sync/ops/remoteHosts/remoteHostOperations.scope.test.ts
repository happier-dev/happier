import { afterEach, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);

// Only Home HTTP and device credential storage are replaced. Load the real
// ownership graph after those boundaries, outside the operation's test body.
// Complete the consumed storage root before starting its importing Account owners.
// Concurrent cold roots previously stopped during collection, before either test body.
const { storage } = await import('@/sync/domains/state/storage');
const [{ getActiveServerSnapshot }, { setActiveServerId },
    { getActiveServerAccountScope }, { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability },
    { runRemoteHostRelayAccessTask, createUiRemoteHostActionExecuteV1 }, { settingsParse }] = await Promise.all([
    import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/server/serverProfiles'), import('@/sync/domains/scope/activeServerAccountScope'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime'), import('./remoteHostOperations'),
    import('@/sync/domains/settings/settings'),
]);

afterEach(async () => {
    await standardCleanup();
    publishAppliedActiveServerRuntimeAvailability(false);
    await home.reset();
});

it('removes the reviewed local trust pin and refuses to clear keys added after review', async () => {
    const { getRemoteHostTrustedHostKeyStore } = await import('@/sync/domains/remoteHosts/hostKeys/trustedHostKeyStore');
    const store = getRemoteHostTrustedHostKeyStore();
    store.clear();
    const record = store.trust({ host: 'private.example', port: 2222, algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:reviewed' });
    const serverId = await home.addHome({ name: 'Trust owner', serverUrl: 'https://trust-owner.test', accountId: 'account' });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    const execute = createUiRemoteHostActionExecuteV1(account);
    const key = { host: record.hostLower, port: record.port, algorithm: record.algorithm, fingerprintSha256: record.fingerprintSha256 };
    try {
        expect(await execute({ actionId: 'remote_hosts.trusted_keys.remove', input: { key } }, {}))
            .toMatchObject({ ok: true, result: { status: 'removed' } });
        expect(store.readAll()).toEqual([]);
        store.trust({ ...key, fingerprintSha256: 'SHA256:replacement' });
        expect(await execute({ actionId: 'remote_hosts.trusted_keys.remove', input: { key } }, {}))
            .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'trusted_host_key_changed' } });
        const keys = store.readAll().map(row => ({ host: row.hostLower, port: row.port, algorithm: row.algorithm, fingerprintSha256: row.fingerprintSha256 }));
        store.trust({ host: 'another.example', port: 22, algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:another' });
        expect(await execute({ actionId: 'remote_hosts.trusted_keys.clear', input: { keys } }, {}))
            .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'trusted_host_keys_changed' } });
        expect(store.readAll()).toHaveLength(2);
        const current = store.readAll().map(row => ({ host: row.hostLower, port: row.port, algorithm: row.algorithm, fingerprintSha256: row.fingerprintSha256 }));
        expect(await execute({ actionId: 'remote_hosts.trusted_keys.clear', input: { keys: current } }, {}))
            .toMatchObject({ ok: true, result: { status: 'removed' } });
        expect(store.readAll()).toEqual([]);
    } finally { store.clear(); account.dispose(); }
});

it('releases only the captured native lease through the real runtime and leaves the neighboring tunnel usable', async () => {
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'native');
    const { createNativeSshTunnelSupervisor } = await import('@/sync/runtime/nativeSshTunnels/supervisor');
    const { getNativeSshTunnelRuntime, disposeNativeSshTunnelRuntime } = await import('@/sync/runtime/nativeSshTunnels/runtime');
    await disposeNativeSshTunnelRuntime();
    const liveHandles = new Set<string>();
    // The adapter is the native OS/process boundary; both lease owners remain real.
    const runtime = getNativeSshTunnelRuntime({ createSupervisor: () => createNativeSshTunnelSupervisor({
        adapter: {
            startLoopbackTunnel: async request => {
                const nativeTunnelId = `native-${request.remoteHostId}`;
                liveHandles.add(nativeTunnelId);
                return { nativeTunnelId, localPort: request.remoteHostId === 'first' ? 49152 : 49153 };
            },
            stopLoopbackTunnel: async handle => { liveHandles.delete(handle); },
        },
        probe: async () => ({ ok: true }),
    }) });
    await runtime.markForeground();
    const request = (remoteHostId: string) => ({ remoteHostId, sshTarget: 'dev@private.example', destinationHost: '127.0.0.1' as const,
        destinationPort: 3005, purpose: 'server-http' as const,
        credentialsRef: { remoteHostId, credentialId: 'credential', storage: 'session-memory' as const } });
    const first = await runtime.ensureTunnel(request('first'));
    const second = await runtime.ensureTunnel(request('second'));
    const serverId = await home.addHome({ name: 'Tunnel owner', serverUrl: 'https://tunnel-owner.test', accountId: 'account' });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    try {
        expect(await createUiRemoteHostActionExecuteV1(account)({ actionId: 'remote_hosts.tunnel.stop',
            input: { target: { kind: 'native', leaseId: first.leaseId } } }, {}))
            .toMatchObject({ ok: true, result: { status: 'released' } });
        expect(runtime.listTunnels().leases.map(lease => lease.leaseId)).toEqual([second.leaseId]);
        expect([...liveHandles]).toEqual(['native-second']);
    } finally { account.dispose(); await disposeNativeSshTunnelRuntime(); vi.unstubAllEnvs(); }
});

it.each(['list', 'read', 'duplicate'] as const)('serves the current destination %s Action without awaiting history maintenance', async operation => {
    const serverId = await home.addHome({ name: 'Admitted Home', serverUrl: 'https://admitted-host-actions.test', accountId: 'account' });
    const scope = { serverId, accountId: 'account' };
    storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse({}) });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    const host = { id: 'source-host', name: 'Host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
        ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
    home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
    home.answer(serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: [] } });
    home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
    const historyReady = createDeferred<void>();
    home.answer(serverId, '/v2/account/settings/history', { respondAfter: historyReady.promise, body: { snapshots: [] } });
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
        content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
    home.answer(serverId, 'POST /v1/account/entity-rows/remote-hosts', { body: { status: 'updated', revision: 5, cursor: 1 } });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    const execute = createUiRemoteHostActionExecuteV1(account);
    const request = operation === 'duplicate'
        ? { actionId: 'remote_hosts.duplicate' as const, input: { hostId: host.id, expectedRevision: 4, newHostId: 'copy-host', name: 'Copy' } }
        : operation === 'read' ? { actionId: 'remote_hosts.read' as const, input: { hostId: host.id } }
        : { actionId: 'remote_hosts.list' as const, input: {} };
    let outcome: Awaited<ReturnType<typeof execute>> | undefined;
    const pending = execute(request, {}).then(result => { outcome = result; });
    try {
        await vi.waitFor(() => { expect(outcome).toMatchObject({ ok: true, result: {
            status: operation === 'duplicate' ? 'updated' : operation === 'read' ? 'present' : 'listed',
        } }); });
        if (operation === 'duplicate') expect(outcome).toMatchObject({ result: { hostId: 'copy-host', revision: 5 } });
    } finally {
        historyReady.resolve();
        await pending;
        account.dispose();
    }
});

it.each(['agent', 'password', 'missing-password'] as const)('keeps the admitted relay destination useful while history is unavailable and another Home is focused (%s)', async credential => {
    const serverId = await home.addHome({ name: 'Issued Home', serverUrl: 'https://issued-remote-host.test', accountId: 'account' });
    const focusedId = await home.addHome({ name: 'Staged Home', serverUrl: 'https://staged-remote-host.test', accountId: 'other', active: false });
    const scope = { serverId, accountId: 'account' };
    const features = createRootLayoutFeaturesResponse({ features: {
        remoteHosts: { management: { enabled: true }, secretMaterial: { enabled: true } },
    } });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    home.answer(serverId, '/v1/features', { body: features });
    home.answer(serverId, '/v1/features/authenticated', { body: features });
    storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse({}) });
    const issuedSnapshot = getActiveServerSnapshot();
    publishAppliedActiveServerSnapshot(issuedSnapshot, true);
    const ref = formatSharedSavedSecretRefV1('issued-password');
    const host = { id: 'issued-host', name: 'Issued host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
        ssh: credential === 'agent' ? { target: 'dev@private.example', authMode: 'agent' as const }
            : { target: 'dev@private.example', authMode: 'password' as const, passwordSecretRef: ref } };
    const password = 'issued-private-password-fixture';
    const resource = SavedSecretResourceMaterialV1Schema.parse({ resourceId: 'issued-password', encryptionMode: 'plain', recipientEnvelope: null,
        storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: password } },
        entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'SSH password', kind: 'password',
            encryptionMode: 'plain', ownerAccountId: scope.accountId, revision: 3, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
    home.answer(serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: credential === 'password' ? [resource] : [] } });
    home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
    const historyReady = createDeferred<void>();
    home.answer(serverId, '/v2/account/settings/history', { status: 503, body: {},
        ...(credential === 'agent' ? { respondAfter: historyReady.promise } : {}) });
    home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
    const readReached = createDeferred<void>();
    const answerReady = createDeferred<void>();
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { select: () => {
        readReached.resolve();
        return { respondAfter: answerReady.promise, body: { status: 'present', revision: 4,
            content: { t: 'plain', v: { v: 1, hosts: [host] } } } };
    } });
    let issued = false;
    const result = runRemoteHostRelayAccessTask({ scope, hostId: host.id, expectedRevision: 4,
        run: async (target, upstreamUrl, assertCurrent) => {
            assertCurrent(); issued = true;
            expect(target).toMatchObject({ kind: 'ssh', ssh: { target: host.ssh.target } });
            if (credential === 'password') expect(target).toMatchObject({ ssh: { password } });
            return upstreamUrl;
        } });
    // Attach rejection handling while a genuine network response is held open.
    const settled = result.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
        await Promise.race([readReached.promise, settled.then(outcome => {
            if (!outcome.ok) throw outcome.error;
        })]);
        await setActiveServerId(focusedId, { scope: 'device' });
        expect(getActiveServerSnapshot().serverId).toBe(focusedId);
        expect(getActiveServerAccountScope()).toEqual(scope);
        answerReady.resolve();
        if (credential === 'agent') await vi.waitFor(() => { expect(issued).toBe(true); });
        if (credential === 'missing-password') {
            expect(await settled).toMatchObject({ ok: false, error: { reason: 'saved_secret_unavailable' } });
            expect(issued).toBe(false);
        } else expect(await settled).toEqual({ ok: true, value: issuedSnapshot.serverUrl });
        expect(home.requestsFor('/v1/account/entity-rows/remote-hosts').every(request => request.serverId === serverId)).toBe(true);
    } finally {
        answerReady.resolve();
        historyReady.resolve();
        await settled;
    }
});
