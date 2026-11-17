import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    type ManagedIdentityProviderOwnerV1,
} from '@happier-dev/protocol/identity/providers';
import { renderHook, standardCleanup } from '@/dev/testkit';

import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import { ManagedIdentityProvidersListResultV1Schema, ManagedIdentityProviderRemovePreflightResultV1Schema } from '@happier-dev/protocol/identity/providers';
import { managedIdentityProviderFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
const { storage } = await import('@/sync/domains/state/storage');
import { settingsDefaults } from '@/sync/domains/settings/settings';

const { createManagedIdentityProviderClient } = await import('./managedIdentityProviderClient');
const { useManagedIdentityProviders } = await import('./useManagedIdentityProviders');
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
// Collect the real executor graph after boundaries, before a test owns its first Action.
await import('@/sync/ops/actions/defaultActionExecutor');

async function readApprovalScope(actionId: 'identity.providers.list' | 'identity.providers.remove.preview' = 'identity.providers.list') {
    const serverId = await harness.addHome({ serverUrl: 'https://home-provider-read-approval.example', name: 'Read approval Home', accountId: 'account-1' });
    await harness.requireUiApproval(serverId, actionId);
    harness.answer(serverId, '/v1/identity/providers/list', { body: ManagedIdentityProvidersListResultV1Schema.parse({ items: [], unreadableCount: 0 }) });
    return createServerAccountScope(serverId, 'account-1')!;
}

beforeEach(async () => {
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
    await harness.reset();
    storage.setState({ settingsScope: null, settings: settingsDefaults });
    resetScopedHomeActionExecutorsForTests();
});

afterEach(() => {
    standardCleanup();
    resetScopedHomeActionExecutorsForTests();
    vi.clearAllMocks();
});

describe('createManagedIdentityProviderClient', () => {
    it('does not issue an Ask removal-preview read when its local confirmation is declined', async () => {
        const scope = await readApprovalScope('identity.providers.remove.preview');
        const onApprovalFailed = vi.fn();
        const result = await createManagedIdentityProviderClient(scope).execute(
            'identity.providers.remove.preview',
            { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 1 },
            { onApprovalFailed },
        );

        expect(result).toMatchObject({ kind: 'failed', failure: { code: 'approval_canceled' } });
        expect(onApprovalFailed).not.toHaveBeenCalled();
        expect(harness.requestsFor('/v1/identity/providers/remove/preflight')).toHaveLength(0);
    });

    it.each<ManagedIdentityProviderOwnerV1>([{ kind: 'home' }, { kind: 'team', teamId: 'team-1' }])(
        'confirms an Ask $kind provider read locally and displays the Home result',
        async (owner) => {
            const scope = await readApprovalScope();
            const { Modal } = await import('@/modal');
            vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
            const onApprovalPending = vi.fn<(registration: ActionApprovalRegistration) => void>();
            const hook = await renderHook(() => useManagedIdentityProviders(scope, owner, onApprovalPending));

            await vi.waitFor(() => expect(hook.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 0, refreshing: false, stale: false }));
            expect(Modal.confirm).toHaveBeenCalledOnce();
            expect(onApprovalPending).not.toHaveBeenCalled();
            expect(harness.requestsFor('/v1/identity/providers/list')).toHaveLength(1);
        },
    );

    it('allows a declined Ask read to be retried with local confirmation', async () => {
        const scope = await readApprovalScope();
        const owner = { kind: 'home' } as const;
        const onApprovalPending = vi.fn<(registration: ActionApprovalRegistration) => void>();
        const hook = await renderHook(() => useManagedIdentityProviders(scope, owner, onApprovalPending));
        await vi.waitFor(() => expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', failure: { code: 'approval_canceled' } }));
        expect(harness.requestsFor('/v1/identity/providers/list')).toHaveLength(0);
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await act(async () => hook.getCurrent().refresh());
        await vi.waitFor(() => expect(hook.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 0, stale: false }));
        expect(onApprovalPending).not.toHaveBeenCalled();
        expect(harness.requestsFor('/v1/identity/providers/list')).toHaveLength(1);
    });

    // Query-change isolation remains covered through the real immediate read below;
    // own-UI Ask reads no longer create deferred self-approval results.
    it('does not retain another owner’s projection when the mounted query changes Team', async () => {
        const serverId = await harness.addHome({ serverUrl: 'https://home-provider-scope.example', name: 'Scope Home', accountId: 'account-1' });
        const scope = createServerAccountScope(serverId, 'account-1')!;
        harness.answer(serverId, '/v1/identity/providers/list', { body: ManagedIdentityProvidersListResultV1Schema.parse({ items: [], unreadableCount: 3 }) });
        const hook = await renderHook((teamId: string) => useManagedIdentityProviders(scope, { kind: 'team', teamId }), { initialProps: 'team-1' });
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        harness.answer(serverId, '/v1/identity/providers/list', { status: 403, body: { error: 'forbidden' } });

        await hook.rerender('team-2');

        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('unavailable'));
    });
    it('lists Home-owned providers through the Action-declared exact Home route', async () => {
        const serverId = await harness.addHome({
            serverUrl: 'https://home-provider.example',
            name: 'Provider Home',
            accountId: 'account-1',
        });
        const scope = createServerAccountScope(serverId, 'account-1')!;
        harness.answer(serverId, '/v1/identity/providers/list', { body: ManagedIdentityProvidersListResultV1Schema.parse({ items: [], unreadableCount: 0 }) });

        const result = await createManagedIdentityProviderClient(scope).execute(
            'identity.providers.list',
            { owner: { kind: 'home' } },
        );

        expect(result).toEqual({ kind: 'succeeded', value: { items: [], unreadableCount: 0 } });
        const request = harness.requestsFor('/v1/identity/providers/list')[0];
        expect(request?.serverUrl + request?.path).toBe('https://home-provider.example/v1/identity/providers/list');
        expect(request?.method).toBe('POST');
        expect(request?.input).toEqual({ owner: { kind: 'home' } });
    });

    it('reads fresh removal impact through the canonical public Action', async () => {
        const serverId = await harness.addHome({
            serverUrl: 'https://home-provider-impact.example',
            name: 'Provider Home',
            accountId: 'account-1',
        });
        const scope = createServerAccountScope(serverId, 'account-1')!;
        harness.answer(serverId, '/v1/identity/providers/remove/preflight', { body: ManagedIdentityProviderRemovePreflightResultV1Schema.parse({
            provider: managedIdentityProviderFixture({ id: 'provider/1', revision: 2, updatedAt: 2 }),
            canRemove: false,
            blockers: { identityCount: 2, connectionCount: 1, affectedAccountIds: ['account-2'] },
        }) });

        const result = await createManagedIdentityProviderClient(scope).execute(
            'identity.providers.remove.preview',
            { owner: { kind: 'home' }, id: 'provider/1', expectedRevision: 2 },
        );

        expect(result.kind).toBe('succeeded');
        const request = harness.requestsFor('/v1/identity/providers/remove/preflight')[0];
        expect(request?.serverUrl + request?.path).toBe('https://home-provider-impact.example/v1/identity/providers/remove/preflight');
        expect(request?.method).toBe('POST');
        expect(request?.input).toEqual({
            owner: { kind: 'home' }, id: 'provider/1', expectedRevision: 2,
        });
    });

    it('surfaces an ambiguous managed-provider mutation response loss as outcome unknown', async () => {
        const serverId = await harness.addHome({
            serverUrl: 'https://home-provider-unknown.example',
            name: 'Provider Home',
            accountId: 'account-1',
        });
        const scope = createServerAccountScope(serverId, 'account-1')!;
        harness.answer(serverId, '/v1/identity/providers/disable', { dispatchThenFail: true });

        const result = await createManagedIdentityProviderClient(scope).execute(
            'identity.providers.disable',
            { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 2, expectedSecurityRevision: 1 },
        );

        expect(result).toEqual({
            kind: 'failed',
            failure: { code: 'outcome_unknown', retryable: false },
        });
    });
});
