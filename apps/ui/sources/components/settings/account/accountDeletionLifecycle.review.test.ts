import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createManagedResourceDependencyFixture } from '@/dev/testkit/fixtures/managedResourceDependencyFixtures';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const modal = vi.hoisted(() => ({ reviews: [] as string[], onConfirm: null as null | (() => Promise<boolean>) }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
installApprovalCommonModuleMocks({ storage: original => original(), modal: async () => ({ Modal: {
    confirm: async (_title: string, body: string) => { modal.reviews.push(body); return modal.onConfirm ? modal.onConfirm() : true; },
} }) });
const { completeAccountDeletion } = await import('./accountDeletionLifecycle');
const { deleteCurrentAccount } = await import('@/sync/api/account/deleteCurrentAccount');
await loadSyncSingletonForTests();
const account = createProviderSettingsAccountHarness();
let target: ServerAccountScopeLifetime;
let credentials: { token: string };

beforeEach(async () => {
    modal.reviews = []; modal.onConfirm = null;
    await account.restore({ accountId: 'owner', currentAccount: true });
    const home = account.home.findByServerUrl('https://provider-settings-account.test');
    if (!home?.token) throw new Error('Account erasure fixture requires a current credential');
    credentials = { token: home.token };
    const captured = captureActiveServerAccountScopeLifetime();
    if (!captured) throw new Error('Expected the real active Account lifetime');
    target = captured;
});
afterEach(async () => { await account.reset(); retireActiveServerAccountScopeLifetime(); publishAppliedActiveServerRuntimeAvailability(false); resetRuntimeFetch(); vi.restoreAllMocks(); });

describe('ordinary Account erasure managed-resource review', () => {
    it('keeps credentials and the current screen after an upload-pending refusal', async () => {
        setRuntimeFetch(async url => new URL(String(url)).pathname === '/v1/auth/account/delete'
            ? Response.json({ error: 'account_erasure_upload_pending' }, { status: 409 })
            : new Response('{}', { status: 404 }));
        let credentialsRemoved = false;
        const replace = vi.fn();
        await expect(completeAccountDeletion({ target,
            deleteCurrentAccount: async options => await deleteCurrentAccount(credentials, options),
            logout: async options => { await options?.beforeMutation?.(); credentialsRemoved = true; return { kind: 'completed' }; }, replace,
        })).rejects.toMatchObject({ code: 'account_erasure_upload_pending', status: 409 });
        expect(credentialsRemoved).toBe(false);
        expect(replace).not.toHaveBeenCalled();
    });

    it('never sends the original token after its text-confirmation Account lifetime retired', async () => {
        const requests: unknown[] = [];
        setRuntimeFetch(async (url, init) => { if (new URL(String(url)).pathname !== '/v1/auth/account/delete') return new Response('{}', { status: 404 }); requests.push(JSON.parse(String(init?.body))); return Response.json({ status: 'deleted' }); });
        retireActiveServerAccountScopeLifetime();
        let credentialsRemoved = false;
        const replace = vi.fn();
        await completeAccountDeletion({ target,
            deleteCurrentAccount: async options => await deleteCurrentAccount(credentials, options),
            logout: async options => { await options?.beforeMutation?.(); credentialsRemoved = true; return { kind: 'completed' }; }, replace,
        }).catch(() => undefined);
        expect(requests).toEqual([]);
        expect(credentialsRemoved).toBe(false);
        expect(replace).not.toHaveBeenCalled();
    });

    it('requires fresh consent for renewed exact native review and completes local teardown only after deleted', async () => {
        const resources = [7, 8].map(revision => ({ ...createManagedResourceDependencyFixture(revision), homeId: target.scope.serverId, custodianAccountId: target.scope.accountId }));
        const requests: unknown[] = [];
        setRuntimeFetch(async (url, init) => {
            if (new URL(String(url)).pathname !== '/v1/auth/account/delete') return new Response('{}', { status: 404 });
            requests.push(JSON.parse(String(init?.body)));
            return requests.length <= resources.length
                ? Response.json({ error: 'account_erasure_managed_resources_review_required', resources: [resources[requests.length - 1]] }, { status: 409 })
                : Response.json({ status: 'deleted' });
        });
        let credentialsRemoved = false;
        const replace = vi.fn();
        const deletion = completeAccountDeletion({ target,
            deleteCurrentAccount: async options => await deleteCurrentAccount(credentials, options),
            logout: async options => { await options?.beforeMutation?.(); credentialsRemoved = true; return { kind: 'completed' }; }, replace,
        });
        await flushHookEffects();
        expect(requests).toHaveLength(3);
        await expect(deletion).resolves.toEqual({ kind: 'completed', erasure: { status: 'deleted' } });
        expect(modal.reviews).toHaveLength(2);
        expect(requests).toEqual([{ confirmation: 'DELETE' }, ...resources.map(resource => ({ confirmation: 'DELETE',
            managedResourceDispositions: [{ managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
                expectedAllocation: resource.allocation, expectedResource: resource.resource,
                expectedNativeOperationRef: resource.nativeOperationRef, expectedRecovery: resource.recovery, responsibility: 'manual' }],
        }))]);
        expect(credentialsRemoved).toBe(true);
        expect(replace).toHaveBeenCalledWith('/');
    });

    it.each(['cancel', 'retired', 'unknown'] as const)('retains local custody after %s without reusing earlier consent', async interruption => {
        const resource = { ...createManagedResourceDependencyFixture(), homeId: target.scope.serverId, custodianAccountId: target.scope.accountId };
        const requests: unknown[] = [];
        setRuntimeFetch(async (url, init) => {
            if (new URL(String(url)).pathname !== '/v1/auth/account/delete') return new Response('{}', { status: 404 });
            requests.push(JSON.parse(String(init?.body)));
            return requests.length === 1
                ? Response.json({ error: 'account_erasure_managed_resources_review_required', resources: [resource] }, { status: 409 })
                : Response.json({ error: 'account_erasure_transition_cleanup_pending' }, { status: 409 });
        });
        modal.onConfirm = async () => { if (interruption === 'retired') retireActiveServerAccountScopeLifetime(); return interruption !== 'cancel'; };
        let credentialsRemoved = false;
        const replace = vi.fn();
        await expect(completeAccountDeletion({ target,
            deleteCurrentAccount: async options => await deleteCurrentAccount(credentials, options),
            logout: async options => { await options?.beforeMutation?.(); credentialsRemoved = true; return { kind: 'completed' }; }, replace,
        })).rejects.toBeInstanceOf(Error);
        expect(modal.reviews).toHaveLength(1);
        expect(requests).toHaveLength(interruption === 'unknown' ? 2 : 1);
        expect(credentialsRemoved).toBe(false);
        expect(replace).not.toHaveBeenCalled();
    });
});
