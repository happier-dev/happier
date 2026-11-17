import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TaskResourceV1Schema, TaskResourcesListResponseV1Schema, TaskResourceMutateRequestV1Schema } from '@happier-dev/protocol/actions/internalTaskActions';

const homes = createHomeGovernanceHarness();
// The confirmation dialog is a platform boundary; Action admission and dispatch stay real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { vi.restoreAllMocks(); await homes.reset(); });

async function restoreHome(serverId: string, serverUrl: string) {
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
    if (!credentials) throw new Error('Home credentials unavailable');
    await restoreConnectionToActiveServer(credentials);
    homes.answer(serverId, 'GET /v1/tasks', { status: 404, body: { statusCode: 404, error: 'Not Found', message: 'Route GET:/v1/tasks not found' } });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId, accountId: 'owner' });
}

describe('internal Task Action captured Account authority', () => {
    it('lists shared tasks, edits their owner row, and keeps the legacy own TodoState free of collaborator rows', async () => {
        const serverId = await homes.addHome({ name: 'Shared Task Home', serverUrl: 'https://task-shared.test', accountId: 'owner', currentAccount: true });
        await restoreHome(serverId, 'https://task-shared.test');
        const scope = { serverId, accountId: 'owner' };
        const own = { id: 'same', title: 'Own task', done: false, createdAt: 1, updatedAt: 1 };
        let shared = TaskResourceV1Schema.parse({ ownerAccountId: 'other', taskId: 'same', access: 'edit', encryptionMode: 'plain',
            encryptedDataKey: null, version: 3, content: { t: 'plain', v: { ...own, title: 'Other task' } } });
        homes.answer(serverId, 'GET /v1/tasks', { select: () => ({ body: TaskResourcesListResponseV1Schema.parse({ tasks: [
            { ...shared, ownerAccountId: 'owner', access: 'owner', content: { t: 'plain', v: own }, version: 2 }, shared,
        ] }) }) });
        homes.answer(serverId, 'POST /v1/kv/bulk', { body: { values: [{ key: 'todo.index', version: 1,
            value: Buffer.from(JSON.stringify({ t: 'plain', v: { undoneOrder: ['same'], completedOrder: [] } })).toString('base64') }] } });
        homes.answer(serverId, 'GET /v1/tasks/other/same', { select: () => ({ body: shared }) });
        homes.answer(serverId, 'PUT /v1/tasks/other/same', { select: input => {
            const mutation = TaskResourceMutateRequestV1Schema.parse(input);
            expect(mutation.expectedVersion).toBe(3);
            shared = TaskResourceV1Schema.parse({ ...shared, content: mutation.content, version: 4 });
            return { body: shared };
        } });
        const { executeInternalTaskHostAction } = await import('./internalTaskAction');
        expect(await executeInternalTaskHostAction({ actionId: 'tasks.internal.list', input: {} })).toMatchObject({ status: 'ok',
            todos: [{ ownerAccountId: 'owner', title: 'Own task' }, { ownerAccountId: 'other', title: 'Other task' }] });
        expect(await executeInternalTaskHostAction({ actionId: 'tasks.internal.edit', input: { scope, ownerAccountId: 'other', taskId: 'same', fields: { title: 'Shared edit' } } }))
            .toMatchObject({ status: 'applied', todo: { title: 'Shared edit', ownerAccountId: 'other' } });
        const { sync } = await import('@/sync/sync');
        const { fetchTodos } = await import('@/sync/domains/todos/todoOps');
        const credentials = sync.getCredentials(); if (!credentials) throw new Error('Expected current Account');
        expect(await fetchTodos(credentials)).toMatchObject({ todos: { same: own }, undoneOrder: ['same'], versions: { 'todo.same': 2 } });
        expect(homes.requests.filter(request => request.method === 'POST' && new URL(request.path, request.serverUrl).pathname === '/v1/kv')).toHaveLength(0);
    });
    it('feeds acknowledged grant readiness through the loaded share controller without a census fan-out', async () => {
        const serverId = await homes.addHome({ name: 'Task Share Home', serverUrl: 'https://task-readiness.test', accountId: 'owner', currentAccount: true });
        await restoreHome(serverId, 'https://task-readiness.test');
        const { TaskAccessGrantsListResponseV1Schema } = await import('@happier-dev/protocol/actions/internalTaskActions');
        const readiness = { readyCount: 1, pendingCount: 2, unavailableCounts: {
            plain_account: 1, encryption_setup_required: 1, encryption_inconsistent: 1,
        } };
        const address = { ownerAccountId: 'other', taskId: 'shared' };
        homes.answer(serverId, 'GET /v1/tasks/other/shared/grants', { body: TaskAccessGrantsListResponseV1Schema.parse({
            ...address, access: 'view', grants: [{ principal: { kind: 'team', teamId: 'core' }, accessLevel: 'view',
                createdByAccountId: 'other', createdAt: 1, display: { name: 'Core' }, readiness }],
        }) });
        homes.answer(serverId, 'GET /v1/tasks/other/shared', { body: TaskResourceV1Schema.parse({ ...address,
            access: 'view', encryptionMode: 'plain', encryptedDataKey: null, version: 1,
            content: { t: 'plain', v: { id: 'shared', title: 'Shared task', done: false, createdAt: 1, updatedAt: 1 } },
        }) });
        const { useTaskShareController } = await import('@/components/sharing/tasks/useTaskShareController');
        const hook = await renderHook(() => useTaskShareController({ ...address, scope: { serverId, accountId: 'owner' } }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
            expect(hook.getCurrent().model.grants).toHaveLength(1);
            expect(hook.getCurrent().readiness.get('team:core')).toEqual(readiness);
            expect(homes.requests.filter(request => request.path.includes('/recipients/'))).toHaveLength(0);
            expect(homes.requests.filter(request => request.path === '/v1/tasks/other/shared/grants')).toHaveLength(1);
        } finally { await hook.unmount(); }
    });
    it.each([false, true])('publishes acknowledged Task readiness after Send keys (commit succeeds: %s)', async succeeds => {
        const { default: nacl } = await import('tweetnacl');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { createLegacyAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
        const { signAccountContentKeyBindingV1 } = await import('@happier-dev/protocol/crypto/accountContentKeyBindingV1');
        const { computeContentPublicKeyFingerprint } = await import('@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint');
        const { summarizeResourceRecipientReadinessV1 } = await import('@happier-dev/protocol/teams/resourceRecipientKeyPreparationV1');
        const { TaskAccessGrantsListResponseV1Schema, TaskAccessRecipientCensusResponseV1Schema,
            TaskRecipientKeyEnvelopeCommitInputV1Schema, TaskRecipientKeyEnvelopeCommitResponseV1Schema } = await import('@happier-dev/protocol/actions/internalTaskActions');
        const secret = new Uint8Array(32).fill(17);
        const credentials = { token: createAccountTokenForTests('owner', { currentAccount: true }), secret: encodeBase64(secret, 'base64url') };
        const url = `https://task-send-keys-${succeeds}.test`;
        const serverId = await homes.addHome({ name: 'Task keys', serverUrl: url, accountId: 'owner', currentAccount: true,
            accountEncryptionMode: 'e2ee', credentials });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createLegacyAccountEncryptionCurrentnessFixture({ secret }) });
        await restoreHome(serverId, url);
        const { sync } = await import('@/sync/sync');
        const encryption = sync.encryption;
        if (!encryption) throw new Error('Expected restored E2EE Account');
        const key = nacl.randomBytes(32);
        const ownerEnvelope = encodeBase64(await encryption.encryptEncryptionKey(key), 'base64');
        const signing = nacl.sign.keyPair();
        const peerKey = nacl.box.keyPair();
        const fingerprint = computeContentPublicKeyFingerprint(peerKey.publicKey);
        let peerEnvelope: string | null = null;
        const address = { ownerAccountId: 'owner', taskId: 'shared' };
        const recipients = () => TaskAccessRecipientCensusResponseV1Schema.parse({ ...address, access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey: ownerEnvelope, callerDataEncryptionKey: ownerEnvelope, recipients: [
                { recipientAccountId: 'peer', contentKey: { status: 'available', accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'),
                    contentPublicKey: encodeBase64(peerKey.publicKey, 'base64'), contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
                        accountSigningSecretKey: signing.secretKey, contentPublicKey: peerKey.publicKey }), 'base64') },
                    contentPublicKeyFingerprint: fingerprint, encryptedDataKey: peerEnvelope, recipientContentPublicKeyFingerprint: peerEnvelope ? fingerprint : null },
                { recipientAccountId: 'plain-peer', contentKey: { status: 'unavailable', reason: 'plain_account' }, contentPublicKeyFingerprint: null,
                    encryptedDataKey: null, recipientContentPublicKeyFingerprint: null },
            ] });
        const readiness = () => summarizeResourceRecipientReadinessV1('e2ee', recipients().recipients);
        homes.answer(serverId, 'GET /v1/tasks/owner/shared/grants', { select: () => ({ body: TaskAccessGrantsListResponseV1Schema.parse({
            ...address, access: 'owner', grants: [{ principal: { kind: 'team', teamId: 'core' }, accessLevel: 'view',
                createdByAccountId: 'owner', createdAt: 1, display: { name: 'Core' }, readiness: readiness() }],
        }) }) });
        const { createUiTaskResourceCrypto } = await import('@/sync/encryption/taskResourceCrypto');
        const crypto = createUiTaskResourceCrypto(encryption, { serverId, accountId: 'owner' });
        homes.answer(serverId, 'GET /v1/tasks/owner/shared', { body: TaskResourceV1Schema.parse({ ...address,
            access: 'owner', encryptionMode: 'e2ee', encryptedDataKey: ownerEnvelope, version: 1,
            content: { t: 'encrypted', k: 'task', c: await crypto.seal({ id: 'shared', title: 'Shared task', done: false, createdAt: 1, updatedAt: 1 }, key) },
        }) });
        homes.answer(serverId, 'POST /v1/tasks/owner/shared/recipients/census', { select: () => ({ body: recipients() }) });
        homes.answer(serverId, 'POST /v1/tasks/owner/shared/recipients/commit', { select: input => {
            const commit = TaskRecipientKeyEnvelopeCommitInputV1Schema.parse(input);
            if (!succeeds) return { status: 403, body: { error: 'task_access_forbidden' } };
            peerEnvelope = commit.recipientKeyEnvelopes.find(row => row.recipientAccountId === 'peer')?.encryptedDataKey ?? null;
            return { body: TaskRecipientKeyEnvelopeCommitResponseV1Schema.parse({ appliedRecipientAccountIds: ['peer'], skippedRecipientAccountIds: [] }) };
        } });
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { useTaskShareController } = await import('@/components/sharing/tasks/useTaskShareController');
        const { createTaskShareAdapter } = await import('@/components/sharing/tasks/taskShareAdapter');
        const hook = await renderHook(() => useTaskShareController({ ...address, scope: { serverId, accountId: 'owner' } }), {
            wrapper: props => React.createElement(InjectedAuthProvider, { credentials, children: props.children }),
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().sendKeys).toBeTypeOf('function'));
            expect(hook.getCurrent().readiness.get('team:core')).toMatchObject({ readyCount: 0, pendingCount: 1 });
            const grantReads = homes.requests.filter(request => request.path === '/v1/tasks/owner/shared/grants').length;
            await act(async () => { hook.getCurrent().sendKeys?.(); });
            await vi.waitFor(() => expect(homes.requests.filter(request => request.path === '/v1/tasks/owner/shared/recipients/commit')).toHaveLength(1));
            await vi.waitFor(() => expect(hook.getCurrent().sendingKeys).toBe(false));
            const current = hook.getCurrent();
            expect(current.readiness.get('team:core')).toEqual(readiness());
            expect(homes.requests.filter(request => request.path === '/v1/tasks/owner/shared/grants')).toHaveLength(grantReads + (succeeds ? 1 : 0));
            const adapter = createTaskShareAdapter({ ...current, readOnly: false });
            const { t } = await import('@/text');
            expect(adapter.principalTags?.(current.model.grants[0]!.principal)).toEqual(succeeds
                ? [t('status.ready'), t('shareSheet.tasks.readiness.homeManaged')]
                : [t('shareSheet.tasks.readiness.membersKeysPending', { count: 1 }), t('shareSheet.tasks.readiness.homeManaged')]);
        } finally { await hook.unmount(); }
    });
    it('captures credentials once rather than reevaluating the live bearer through an admitted read', async () => {
        const serverId = await homes.addHome({ name: 'Task Home', serverUrl: 'https://task-admission.test', accountId: 'owner', currentAccount: true });
        await restoreHome(serverId, 'https://task-admission.test');
        homes.answer(serverId, 'GET /v1/kv', { body: { items: [] } });
        homes.answer(serverId, 'POST /v1/kv/bulk', { body: { values: [] } });
        const { sync } = await import('@/sync/sync');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId, accountId: 'owner' });
        expect(sync.getCredentials()).not.toBeNull();
        // Call-through measurement: Sync, Account-mode admission, protocol and KV logic stay real.
        const captured = vi.spyOn(sync, 'getCredentials');
        const { executeInternalTaskHostAction } = await import('./internalTaskAction');
        const result = await executeInternalTaskHostAction({ actionId: 'tasks.internal.list', input: {} });
        expect(result).toEqual({ status: 'ok', scope: { serverId, accountId: 'owner' }, todos: [], undoneOrder: [], completedOrder: [], labelCatalog: [] });
        expect(homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v1/kv')).toHaveLength(1);
        expect(captured).toHaveBeenCalledTimes(1);
    });

    it.each(['caller', 'account', 'home'] as const)('keeps %s lifetime cancellation while the admitted response body is pending', async change => {
        const serverId = await homes.addHome({ name: 'Task Home', serverUrl: 'https://task-lifetime.test', accountId: 'owner', currentAccount: true });
        await restoreHome(serverId, 'https://task-lifetime.test');
        const otherHome = change === 'home' ? await homes.addHome({ name: 'Other Home', serverUrl: 'https://task-other.test', accountId: 'other', currentAccount: true, active: false }) : null;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let admit!: () => void;
        const entered = new Promise<void>(resolve => { admit = resolve; });
        homes.answer(serverId, 'GET /v1/kv', { select: () => { admit(); return { body: { items: [] }, bodyAfter: held }; } });
        const controller = new AbortController();
        const { executeInternalTaskHostAction } = await import('./internalTaskAction');
        const pending = executeInternalTaskHostAction({ actionId: 'tasks.internal.list', input: {}, signal: controller.signal });
        try {
            await entered;
            if (change === 'caller') controller.abort();
            else if (change === 'account') await homes.switchAccount(serverId, 'successor', { currentAccount: true });
            else {
                const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
                await setActiveServerId(otherHome!, { scope: 'device' });
            }
            release();
            expect(await pending).not.toHaveProperty('status', 'ok');
            expect(homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v1/kv')).toHaveLength(1);
        } finally { release(); await pending; }
    });
});
