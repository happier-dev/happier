import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import type {
    PluginPermissionGrant,
    PluginPermissionGrantApprovedResult,
    PluginPermissionGrantListInput,
    PluginPermissionGrantListResponse,
    PluginPermissionPendingGrantRequest,
} from './types';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

const targetScope = { kind: 'project', projectId: 'project-1' } as const;
const capability = 'reviews.comments.write.direct' as const;

function pendingRequest(
    overrides: Partial<PluginPermissionPendingGrantRequest> = {},
): PluginPermissionPendingGrantRequest {
    return {
        v: 1,
        id: 'request-1',
        accountId: 'account-1',
        pluginId: 'review-coderabbit',
        capability,
        targetScope,
        requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 'session-1' },
        authoritySource: { kind: 'bundled' },
        reason: 'Write approved review comments without another prompt.',
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

function grant(overrides: Partial<PluginPermissionGrant> = {}): PluginPermissionGrant {
    return {
        v: 1,
        id: 'grant-1',
        accountId: 'account-1',
        pluginId: 'review-coderabbit',
        capability,
        targetScope,
        status: 'active',
        requestId: 'request-1',
        authoritySource: { kind: 'bundled' },
        grantedByUserId: 'account-1',
        grantedAt: 2,
        createdAt: 2,
        updatedAt: 2,
        ...overrides,
    };
}

describe('usePluginPermissionGrants', () => {
    it('loads trusted grant state and preserves rows during refresh', async () => {
        const secondList = deferred<PluginPermissionGrantListResponse>();
        const actions = {
            list: vi.fn(async () => {
                if (actions.list.mock.calls.length === 1) {
                    return { grants: [grant()], pendingRequests: [pendingRequest()] };
                }
                return await secondList.promise;
            }),
            grant: vi.fn(),
            revoke: vi.fn(),
            dismissRequest: vi.fn(),
            request: vi.fn(),
        };
        const { usePluginPermissionGrants } = await import('./usePluginPermissionGrants');

        const hook = await renderHook(() => usePluginPermissionGrants({
            actions,
            enabled: true,
            listInput: { capability, targetScope },
        }));
        await flushHookEffects();

        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(true);
        expect(hook.getCurrent().pendingRequests).toHaveLength(1);

        await act(async () => {
            void hook.getCurrent().refresh();
        });
        await flushHookEffects({ cycles: 1 });
        expect(hook.getCurrent().state.status).toBe('refreshing');
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(true);
        expect(hook.getCurrent().pendingRequests).toHaveLength(1);

        await act(async () => {
            secondList.resolve({ grants: [], pendingRequests: [] });
        });
        await flushHookEffects();
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(false);
        expect(hook.getCurrent().pendingRequests).toHaveLength(0);
    });

    it('applies grant, revoke, and dismiss mutations from generic actions', async () => {
        const actions = {
            list: vi.fn(async () => ({ grants: [], pendingRequests: [pendingRequest()] })),
            grant: vi.fn(async () => ({
                grant: grant(),
                pendingRequest: pendingRequest({ status: 'granted', grantId: 'grant-1', decidedAt: 2 }),
            })),
            revoke: vi.fn(async () => ({ grant: grant({ status: 'revoked', revokedAt: 3 }) })),
            dismissRequest: vi.fn(async () => ({
                pendingRequest: pendingRequest({ id: 'request-2', status: 'dismissed', decidedAt: 4 }),
            })),
            request: vi.fn(),
        };
        const { usePluginPermissionGrants } = await import('./usePluginPermissionGrants');

        const hook = await renderHook(() => usePluginPermissionGrants({
            actions,
            enabled: true,
            listInput: { capability, targetScope },
        }));
        await flushHookEffects();

        await act(async () => {
            await hook.getCurrent().grant({ requestId: 'request-1' });
        });
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(true);
        expect(hook.getCurrent().pendingRequests).toHaveLength(0);

        await act(async () => {
            await hook.getCurrent().revoke({ grantId: 'grant-1' });
        });
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(false);

        await act(async () => {
            hook.getCurrent().upsertPendingRequest(pendingRequest({ id: 'request-2' }));
            await hook.getCurrent().dismissRequest({ requestId: 'request-2' });
        });
        expect(hook.getCurrent().pendingRequests).toHaveLength(0);
    });

    it('keeps disabled panes inert at the shared mutation boundary', async () => {
        const actions = {
            list: vi.fn(async () => ({ grants: [grant()], pendingRequests: [pendingRequest()] })),
            grant: vi.fn(async () => ({
                grant: grant(),
                pendingRequest: pendingRequest({ status: 'granted', grantId: 'grant-1', decidedAt: 2 }),
            })),
            revoke: vi.fn(async () => ({ grant: grant({ status: 'revoked', revokedAt: 3 }) })),
            dismissRequest: vi.fn(async () => ({
                pendingRequest: pendingRequest({ id: 'request-1', status: 'dismissed', decidedAt: 4 }),
            })),
            request: vi.fn(),
        };
        const { usePluginPermissionGrants } = await import('./usePluginPermissionGrants');

        const hook = await renderHook(() => usePluginPermissionGrants({
            actions,
            enabled: false,
            listInput: { capability, targetScope },
        }));
        await flushHookEffects();

        await act(async () => {
            hook.getCurrent().upsertPendingRequest(pendingRequest());
            await hook.getCurrent().grant({ requestId: 'request-1' });
            await hook.getCurrent().revoke({ grantId: 'grant-1' });
            await hook.getCurrent().dismissRequest({ requestId: 'request-1' });
        });

        expect(actions.list).not.toHaveBeenCalled();
        expect(actions.grant).not.toHaveBeenCalled();
        expect(actions.revoke).not.toHaveBeenCalled();
        expect(actions.dismissRequest).not.toHaveBeenCalled();
        expect(hook.getCurrent().pendingRequests).toHaveLength(0);
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(false);
    });

    it('fails closed across scope changes and ignores stale list and mutation results', async () => {
        const projectOneList = deferred<PluginPermissionGrantListResponse>();
        const projectTwoList = deferred<PluginPermissionGrantListResponse>();
        const staleGrant = deferred<PluginPermissionGrantApprovedResult>();
        const projectTwoScope = { kind: 'project', projectId: 'project-2' } as const;
        const actions = {
            list: vi.fn((input: PluginPermissionGrantListInput) => (
                input.targetScope?.kind === 'project' && input.targetScope.projectId === 'project-1'
                    ? projectOneList.promise
                    : projectTwoList.promise
            )),
            grant: vi.fn(() => staleGrant.promise),
            revoke: vi.fn(),
            dismissRequest: vi.fn(),
            request: vi.fn(),
        };
        const { usePluginPermissionGrants } = await import('./usePluginPermissionGrants');
        type HookProps = Readonly<{ targetScope: typeof targetScope | typeof projectTwoScope }>;
        const hook = await renderHook(
            (props: HookProps) => usePluginPermissionGrants({
                actions,
                enabled: true,
                listInput: { capability, targetScope: props.targetScope },
            }),
            { initialProps: { targetScope } as HookProps },
        );

        projectOneList.resolve({ grants: [grant()], pendingRequests: [pendingRequest()] });
        await flushHookEffects();
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(true);
        let staleMutation!: Promise<void>;
        await act(async () => {
            staleMutation = hook.getCurrent().grant({ requestId: 'request-1' });
        });

        await hook.rerender({ targetScope: projectTwoScope });
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(false);
        expect(hook.getCurrent().pendingRequests).toHaveLength(0);
        projectTwoList.resolve({
            grants: [grant({ id: 'grant-2', targetScope: projectTwoScope })],
            pendingRequests: [],
        });
        await flushHookEffects();
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope: projectTwoScope })).toBe(true);

        staleGrant.resolve({
            grant: grant(),
            pendingRequest: pendingRequest({ status: 'granted', grantId: 'grant-1', decidedAt: 3 }),
        });
        await act(async () => { await staleMutation; });
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope: projectTwoScope })).toBe(true);
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(false);
    });

    it('preserves trusted rows while offline and refreshes them after reconnect', async () => {
        const actions = {
            list: vi.fn()
                .mockResolvedValueOnce({ grants: [grant()], pendingRequests: [pendingRequest()] })
                .mockRejectedValueOnce(new Error('offline'))
                .mockResolvedValueOnce({ grants: [], pendingRequests: [] }),
            grant: vi.fn(),
            revoke: vi.fn(),
            dismissRequest: vi.fn(),
            request: vi.fn(),
        };
        const { usePluginPermissionGrants } = await import('./usePluginPermissionGrants');
        const hook = await renderHook(() => usePluginPermissionGrants({
            actions,
            enabled: true,
            listInput: { capability, targetScope },
        }));
        await flushHookEffects();

        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().state.status).toBe('error');
        expect(hook.getCurrent().state.error).toBe('offline');
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(true);

        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().state.status).toBe('ready');
        expect(hook.getCurrent().state.error).toBeNull();
        expect(hook.getCurrent().hasGrant({ pluginId: 'review-coderabbit', capability, targetScope })).toBe(false);
    });
});
