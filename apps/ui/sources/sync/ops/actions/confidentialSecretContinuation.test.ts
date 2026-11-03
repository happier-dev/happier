import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateActionInputContinuationV1Schema } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SHARED_SAVED_SECRET_ACTION_PATHS_V1, SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

type ContinueInputs = typeof import('./confidentialSecretContinuation')['continueConfidentialActionInputs'];

// The real Account capture, Action front door, resource writer and schemas run;
// only the socket and HTTP peers are substituted.
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let deliveries: unknown[];
let effectResult: unknown;
let lostDelivery: boolean;
let saveMode: 'saved' | 'failed' | 'unknown';
let saves: ReturnType<typeof SharedSavedSecretCreateInputV1Schema.parse>[];
let current: boolean;
let retireAfterDelivery: boolean;
let vaultStores: unknown[];

installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object') throw new Error('invalid_network_request');
        if (Reflect.get(payload, 'method') === 'machine-1:daemon.secrets.source.invoke.v1') {
            const operand = Reflect.get(payload, 'params');
            vaultStores.push(operand);
            return { ok: true, result: { ok: true, account: 'vault-account', reference: 'op://vault/item/password' } };
        }
        expect(Reflect.get(payload, 'method')).toBe(`machine-1:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`);
        const continuation = PrivateActionInputContinuationV1Schema.parse(Reflect.get(payload, 'params'));
        deliveries.push(JSON.parse(JSON.stringify(continuation)));
        if (lostDelivery) throw new Error('private-value-must-not-escape');
        if (retireAfterDelivery) current = false;
        return { ok: true, result: effectResult };
    });
});

// Collect the real Sync/Action graph outside an individual operation's deadline.
await loadSyncSingletonForTests();

function continuation() {
    return PrivateActionInputContinuationV1Schema.parse({ v: 1, kind: 'action_inputs', artifactId: 'approval-1',
        requestId: 'request-1', actionId: 'secrets.create', request: { name: 'Requested credential' },
        serverId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), machineId: 'machine-1',
        accountEncryptionMode: 'plain', choices: [
            { path: 'value', choice: { kind: 'once', value: 'private-value-must-not-escape' } },
            { path: 'existing', choice: { kind: 'saved', ref: 'existing-ref', fingerprint: 'existing-fingerprint', revision: 1 } },
        ] });
}

async function invoke(value = continuation(), extra: Partial<Parameters<ContinueInputs>[0]> = {}) {
    const { continueConfidentialActionInputs } = await import('./confidentialSecretContinuation');
    return continueConfidentialActionInputs({ continuation: value,
        scope: { serverId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), accountId: 'account-a' },
        expectedServerIdentityId: 'srv_confidential-inputs', isCurrent: () => current, ...extra });
}

describe('confidential Action input continuation', () => {
    beforeEach(async () => {
        deliveries = []; saves = []; vaultStores = []; lostDelivery = false; saveMode = 'saved';
        current = true; retireAfterDelivery = false;
        effectResult = { ok: true, result: { consumed: true } };
        connection = await restoreServerAccountForTest({ serverUrl: 'https://confidential-inputs.example.test',
            serverIdentityId: 'srv_confidential-inputs', accountId: 'account-a', request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                    id => id === 'machine-1' ? createPlainMachineRowFixture({ id, accountId: 'account-a' }) : null);
                const bootstrap = createEmptyAccountBootstrapHttpResponse(path, init);
                if (bootstrap) return bootstrap;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({ features: { teams: { enabled: true } }, capabilities: {} });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                    actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'secrets.shared.create': ['ui'] } },
                } }, version: 1 });
                if (path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create']) {
                    expect(deliveries).toHaveLength(1);
                    const saved = SharedSavedSecretCreateInputV1Schema.parse(JSON.parse(String(init?.body)));
                    saves.push(saved);
                    if (saveMode === 'unknown') throw new TypeError('private-value-must-not-escape');
                    return saveMode === 'saved' ? Response.json({ resourceId: saved.resourceId, revision: 1 }) : new Response('{}', { status: 503 });
                }
                if (path === '/v1/account/saved-secrets/resources/materials' && saveMode === 'saved') return Response.json({
                    resources: saves.map(saved => ({ resourceId: saved.resourceId, encryptionMode: 'plain', recipientEnvelope: null,
                        entry: { ref: formatSharedSavedSecretRefV1(saved.resourceId), source: 'shared_resource', relationship: 'owner',
                            name: saved.displayName, kind: saved.kind, encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
                            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                        storedContent: saved.storedContent,
                    })),
                });
                return new Response('{}', { status: 503 });
            } });
    });
    afterEach(async () => { await connection?.dispose(); connection = undefined; });

    it('returns the ordinary Action result through keyless Plain transport and releases both copies of once values', async () => {
        const value = continuation();
        const result = await invoke(value);
        expect(result).toEqual({ execution: effectResult, remember: [
            { path: 'value', status: 'not_requested' }, { path: 'existing', status: 'not_requested' },
        ] });
        expect(deliveries).toEqual([expect.objectContaining({ request: { name: 'Requested credential' },
            choices: expect.arrayContaining([{ path: 'value', choice: { kind: 'once', value: 'private-value-must-not-escape' } }]) })]);
        expect(value.choices[0].choice).toEqual({ kind: 'once', value: '' });
        expect(JSON.stringify(result)).not.toContain('private-value-must-not-escape');
        expect(saves).toEqual([]);
    });

    it.each(['saved', 'failed', 'unknown'] as const)('keeps a %s Remember result separate from the successful effect', async mode => {
        saveMode = mode;
        const value = continuation();
        const result = await invoke(value, { remember: [{ path: 'value', name: ' Remembered input ' }, { path: 'existing', name: 'Do not resave' }] });
        expect(result.execution).toEqual(effectResult);
        expect(result.remember).toEqual([
            { path: 'value', status: mode, ...(mode === 'saved' ? { saved: {
                secretId: saves[0].resourceId, secretRef: formatSharedSavedSecretRefV1(saves[0].resourceId),
            } } : {}) }, { path: 'existing', status: 'not_requested' },
        ]);
        expect(deliveries).toHaveLength(1);
        expect(saves).toHaveLength(1);
        expect(saves[0].storedContent).toMatchObject({ t: 'plain', v: { value: 'private-value-must-not-escape' } });
        expect(value.choices[0].choice).toEqual({ kind: 'once', value: '' });
    });

    it('preserves producer refusal without attempting Remember', async () => {
        effectResult = { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied', effectAttempted: false };
        expect((await invoke(continuation(), { remember: [{ path: 'value', name: 'Not saved' }] })).execution).toEqual(effectResult);
        expect(saves).toEqual([]);
    });

    it('Remember Store-in writes the private value to the selected vault after the effect and retains only its reference', async () => {
        const storeIn = { contribution: { pluginId: 'happier.secret-source.onepassword', localId: 'onepassword' },
            account: 'vault-account', vaultId: 'vault', machineId: 'machine-1' };
        const result = await invoke(continuation(), { remember: [{ path: 'value', name: 'Vault remembered', storeIn }] });
        expect(result.execution).toEqual(effectResult);
        expect(result.remember[0]).toMatchObject({ status: 'saved' });
        expect(deliveries).toHaveLength(1);
        expect(vaultStores).toEqual([{ operation: 'store', target: { contribution: storeIn.contribution,
            account: storeIn.account, vaultId: storeIn.vaultId }, title: 'Vault remembered', value: 'private-value-must-not-escape',
            accountEncryptionMode: 'plain' }]);
        expect(saves[0].storedContent).toMatchObject({ t: 'plain', v: { v: 2, source: { kind: 'external',
            contribution: storeIn.contribution, account: 'vault-account', reference: 'op://vault/item/password' } } });
        expect(JSON.stringify(result)).not.toContain('private-value-must-not-escape');
    });

    it('retains successful consumption when the caller leaves and cancels only Remember', async () => {
        retireAfterDelivery = true;
        const result = await invoke(continuation(), { remember: [{ path: 'value', name: 'Not saved' }] });
        expect(result).toEqual({ execution: effectResult, remember: [
            { path: 'value', status: 'canceled' }, { path: 'existing', status: 'not_requested' },
        ] });
        expect(saves).toEqual([]);
    });

    it('does not mistake a native fill settlement for a successful Action effect', async () => {
        effectResult = { status: 'filled', code: 'filled' };
        const result = await invoke(continuation(), { remember: [{ path: 'value', name: 'Not saved' }] });
        expect(result.execution).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        expect(saves).toEqual([]);
    });

    it('settles a lost dispatch as unknown without replaying or exposing the exception', async () => {
        lostDelivery = true;
        const value = continuation();
        const result = await invoke(value, { remember: [{ path: 'value', name: 'Not saved' }] });
        expect(result.execution).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
        expect(deliveries).toHaveLength(1);
        expect(saves).toEqual([]);
        expect(JSON.stringify(result)).not.toContain('private-value-must-not-escape');
        expect(value.choices[0].choice).toEqual({ kind: 'once', value: '' });
    });

    it.each(['home', 'account', 'mode', 'canceled'] as const)('refuses changed %s before private dispatch and clears the operand', async changed => {
        const value = continuation();
        if (changed === 'mode') value.accountEncryptionMode = 'e2ee';
        const result = await invoke(value, {
            ...(changed === 'home' ? { expectedServerIdentityId: 'other-home' } : {}),
            ...(changed === 'account' ? { scope: { serverId: value.serverId, accountId: 'other-account' } } : {}),
            ...(changed === 'canceled' ? { isCurrent: () => false } : {}),
        });
        expect(result.execution).toMatchObject({ ok: false, errorCode: changed === 'canceled' ? 'approval_canceled' : 'approval_changed' });
        expect(deliveries).toEqual([]);
        expect(value.choices[0].choice).toEqual({ kind: 'once', value: '' });
    });
});
