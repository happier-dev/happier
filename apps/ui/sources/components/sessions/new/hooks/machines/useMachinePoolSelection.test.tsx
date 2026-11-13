import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getStorage, storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const mintedRequestKeys = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => `fallback-request-key-${++mintedRequestKeys.count}`,
}));

const boundary = {
    serverId: '',
    backgroundServerId: '',
    requests: [] as Array<Readonly<{ url: string; body: string }>>,
    responders: [] as Array<() => Promise<Response>>,
};
const initialStorageState = getStorage().getState();
let localStorage: ReturnType<typeof installLocalStorageMock>;

function poolSelection() {
    return {
        serverId: boundary.serverId,
        accountId: 'account-a',
        pool: {
            pool: {
                id: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                name: 'Development',
                description: null,
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
                members: [],
            },
            availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
        },
    };
}

describe('useMachinePoolSelection', () => {
    beforeEach(async () => {
        // Browser persistence is the boundary; credential readers and mutation notifications stay real.
        localStorage = installLocalStorageMock();
        resetServerFeaturesClientForTests();
        getStorage().setState(initialStorageState, true);
        boundary.serverId = (await upsertAndActivateServer({
            serverUrl: 'https://machine-pool-selection.test',
            name: 'Machine Pool Selection Test',
        })).id;
        boundary.backgroundServerId = (await upsertServerProfile({
            serverUrl: 'https://machine-pool-selection-background.test',
            name: 'Machine Pool Selection Background Test',
        })).id;
        boundary.requests.length = 0;
        boundary.responders.length = 0;
        mintedRequestKeys.count = 0;
        expect(await TokenStorage.setCredentialsForServerUrl('https://machine-pool-selection.test',
            { serverId: boundary.serverId }, { token: createAccountTokenForTests('account-a') })).toBe(true);
        expect(await TokenStorage.setCredentialsForServerUrl('https://machine-pool-selection-background.test',
            { serverId: boundary.backgroundServerId }, { token: createAccountTokenForTests('account-b') })).toBe(true);
        const features = buildServerFeaturesResponse();
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            ...features,
            features: {
                ...features.features,
                machines: { ...features.features.machines, pools: { enabled: true } },
            },
        })));
        // Both Homes are primed: the cases that select a background Home's row
        // need that Home's own Pools capability, exactly as the sibling
        // Account-lifetime fixture primes both.
        await getServerFeaturesSnapshot({ serverId: boundary.serverId, force: true });
        await getServerFeaturesSnapshot({ serverId: boundary.backgroundServerId, force: true });
        setRuntimeFetch(async (url, init) => {
            if (String(url).endsWith('/v1/auth/ping')) {
                return Response.json({ ok: true });
            }
            if (String(url).endsWith('/v1/account/encryption')) {
                return Response.json({ mode: 'plain', updatedAt: 1 });
            }
            if (String(url).endsWith('/v2/account/settings')) {
                return Response.json({ content: null, version: 0 });
            }
            boundary.requests.push({ url: String(url), body: String(init?.body ?? '') });
            const respond = boundary.responders.shift();
            if (!respond) throw new Error('missing machine-pool test response');
            return await respond();
        });
        retireActiveServerAccountScopeLifetime();
        storage.setState({ profileScope: { serverId: boundary.serverId, accountId: 'account-a' } });
    });

    afterEach(() => {
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        localStorage.restore();
    });

    it('binds resolution to the captured Home and commits its exact Machine once', async () => {
        const selection = poolSelection();
        const onResolved = vi.fn();
        boundary.responders.push(async () => Response.json({
            kind: 'resolved',
            poolId: selection.pool.pool.id,
            machineId: 'machine-b',
            priorityTier: 0,
        }));
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(() => useMachinePoolSelection({
            requestKey: 'draft-7',
            onResolved,
        }));

        await act(async () => {
            await hook.getCurrent().selectPool(selection);
        });

        expect(boundary.requests).toEqual([{
            url: 'https://machine-pool-selection.test/v1/machines/pools/resolve',
            body: JSON.stringify({ poolId: selection.pool.pool.id, requestKey: 'draft-7' }),
        }]);
        expect(onResolved).toHaveBeenCalledTimes(1);
        expect(onResolved).toHaveBeenCalledWith({
            serverId: boundary.serverId,
            poolId: selection.pool.pool.id,
            machineId: 'machine-b',
        });
        expect(hook.getCurrent().status).toEqual({ kind: 'idle' });
        await hook.unmount();
    });

    it('does not admit a clicked row after that Home has already changed Account', async () => {
        const selection = { ...poolSelection(), accountId: 'account-before' };
        const onResolved = vi.fn();
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(() => useMachinePoolSelection({
            requestKey: 'draft-stale-row',
            onResolved,
        }));

        await act(async () => {
            await hook.getCurrent().selectPool(selection);
        });

        expect(boundary.requests).toHaveLength(0);
        expect(onResolved).not.toHaveBeenCalled();
        expect(hook.getCurrent().status).toEqual({ kind: 'idle' });
        await hook.unmount();
    });

    it('makes a late result inert after the picker is cancelled', async () => {
        const selection = poolSelection();
        let finishResolve!: (response: Response) => void;
        boundary.responders.push(async () => await new Promise<Response>((resolve) => {
            finishResolve = resolve;
        }));
        const onResolved = vi.fn();
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(() => useMachinePoolSelection({
            requestKey: 'draft-8',
            onResolved,
        }));

        let pending!: Promise<boolean>;
        await act(async () => {
            pending = hook.getCurrent().selectPool(selection);
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
        expect(hook.getCurrent().status.kind).toBe('resolving');

        act(() => hook.getCurrent().cancelPendingSelection());
        await act(async () => {
            finishResolve(Response.json({
                kind: 'resolved',
                poolId: selection.pool.pool.id,
                machineId: 'machine-late',
                priorityTier: 0,
            }));
            await pending;
        });

        expect(onResolved).not.toHaveBeenCalled();
        expect(hook.getCurrent().status).toEqual({ kind: 'idle' });
        await hook.unmount();
    });

    it('makes a late result inert when the captured draft request changes', async () => {
        const selection = poolSelection();
        let finishResolve!: (response: Response) => void;
        boundary.responders.push(async () => await new Promise<Response>((resolve) => {
            finishResolve = resolve;
        }));
        const onResolved = vi.fn();
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(
            (requestKey: string) => useMachinePoolSelection({
                requestKey,
                onResolved,
            }),
            { initialProps: 'draft-before' },
        );

        let pending!: Promise<boolean>;
        await act(async () => {
            pending = hook.getCurrent().selectPool(selection);
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
        expect(hook.getCurrent().status.kind).toBe('resolving');

        await hook.rerender('draft-after');
        expect(hook.getCurrent().status).toEqual({ kind: 'idle' });

        await act(async () => {
            finishResolve(Response.json({
                kind: 'resolved',
                poolId: selection.pool.pool.id,
                machineId: 'machine-late',
                priorityTier: 0,
            }));
            await pending;
        });

        expect(onResolved).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('keeps an unavailable result visible and retryable', async () => {
        const selection = poolSelection();
        boundary.responders.push(async () => Response.json({
            kind: 'unavailable',
            poolId: selection.pool.pool.id,
            reason: 'no_available_machine',
        }));
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(() => useMachinePoolSelection({
            requestKey: '',
            onResolved: vi.fn(),
        }));

        await act(async () => {
            await hook.getCurrent().selectPool(selection);
        });

        expect(JSON.parse(boundary.requests[0]?.body ?? '')).toEqual({
            poolId: selection.pool.pool.id,
            requestKey: 'fallback-request-key-1',
        });
        expect(hook.getCurrent().status).toEqual({
            kind: 'unavailable',
            serverId: boundary.serverId,
            accountId: 'account-a',
            poolId: selection.pool.pool.id,
            reason: 'no_available_machine',
        });
        await hook.unmount();
    });

    it('mints a fresh identity for each deliberate draft-less selection and reuses it only for retry', async () => {
        const first = poolSelection();
        const second = {
            ...poolSelection(),
            pool: { ...first.pool, pool: { ...first.pool.pool, id: '9a3f2b10-6d21-4a3f-8b52-71c0d5e9f3aa' } },
        };
        boundary.responders.push(
            async () => Response.json({ kind: 'unavailable', poolId: first.pool.pool.id, reason: 'presence_unavailable' }),
            async () => Response.json({ kind: 'unavailable', poolId: first.pool.pool.id, reason: 'presence_unavailable' }),
            async () => Response.json({ kind: 'unavailable', poolId: second.pool.pool.id, reason: 'presence_unavailable' }),
        );
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(() => useMachinePoolSelection({
            requestKey: '',
            onResolved: vi.fn(),
        }));

        await act(async () => { await hook.getCurrent().selectPool(first); });
        // Retrying the very same deliberate selection must keep one semantic identity.
        await act(async () => { await hook.getCurrent().selectPool(first); });
        // A different deliberate selection is a new intent, not a retry.
        await act(async () => { await hook.getCurrent().selectPool(second); });

        const requestKeys = boundary.requests.map((request) => JSON.parse(request.body).requestKey);
        expect(requestKeys[0]).toBe(requestKeys[1]);
        expect(requestKeys[2]).not.toBe(requestKeys[0]);
        await hook.unmount();
    });

    it('retires a pending resolve when the selected Home or target scope changes', async () => {
        const selection = poolSelection();
        let finishResolve!: (response: Response) => void;
        boundary.responders.push(async () => await new Promise<Response>((resolve) => {
            finishResolve = resolve;
        }));
        const onResolved = vi.fn();
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(
            (scopeKey: string) => useMachinePoolSelection({
                requestKey: 'draft-9',
                scopeKey,
                onResolved,
            }),
            { initialProps: 'home-a::machine-a' },
        );

        let pending!: Promise<boolean>;
        await act(async () => {
            pending = hook.getCurrent().selectPool(selection);
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));

        await hook.rerender('home-b::machine-a');
        expect(hook.getCurrent().status).toEqual({ kind: 'idle' });

        await act(async () => {
            finishResolve(Response.json({
                kind: 'resolved',
                poolId: selection.pool.pool.id,
                machineId: 'machine-late',
                priorityTier: 0,
            }));
            await pending;
        });

        expect(onResolved).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('uses the stable draft identity once, then mints a new identity after the resolved target changes scope', async () => {
        const selection = poolSelection();
        boundary.responders.push(
            async () => Response.json({
                kind: 'resolved',
                poolId: selection.pool.pool.id,
                machineId: 'machine-first',
                priorityTier: 0,
            }),
            async () => Response.json({
                kind: 'resolved',
                poolId: selection.pool.pool.id,
                machineId: 'machine-second',
                priorityTier: 0,
            }),
        );
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(
            (scopeKey: string) => useMachinePoolSelection({
                requestKey: 'stable-draft',
                scopeKey,
                onResolved: vi.fn(),
            }),
            { initialProps: 'unselected' },
        );

        await act(async () => { await hook.getCurrent().selectPool(selection); });
        // The real in-place host commits the exact Machine and Pool origin here, changing the
        // target scope before the author can deliberately choose the Pool again.
        await hook.rerender('machine\u0000machine-first\u0000pool');
        await act(async () => { await hook.getCurrent().selectPool(selection); });

        const requestKeys = boundary.requests.map((request) => JSON.parse(request.body).requestKey);
        expect(requestKeys).toEqual(['stable-draft', 'fallback-request-key-1']);
        await hook.unmount();
    });

    it('does not reuse a stable draft key when mounted over an already committed Pool target', async () => {
        const selection = poolSelection();
        boundary.responders.push(async () => Response.json({
            kind: 'resolved',
            poolId: selection.pool.pool.id,
            machineId: 'machine-selected-again',
            priorityTier: 0,
        }));
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(() => useMachinePoolSelection({
            requestKey: 'stable-restored-draft',
            requestKeyAlreadyConsumed: true,
            onResolved: vi.fn(),
        }));

        await act(async () => { await hook.getCurrent().selectPool(selection); });

        expect(JSON.parse(boundary.requests[0]?.body ?? '').requestKey).toBe('fallback-request-key-1');
        await hook.unmount();
    });

    it('allows a genuinely new draft to use its own stable first-attempt identity', async () => {
        const selection = poolSelection();
        boundary.responders.push(
            async () => Response.json({
                kind: 'resolved',
                poolId: selection.pool.pool.id,
                machineId: 'machine-draft-a',
                priorityTier: 0,
            }),
            async () => Response.json({
                kind: 'resolved',
                poolId: selection.pool.pool.id,
                machineId: 'machine-draft-b',
                priorityTier: 0,
            }),
        );
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(
            (requestKey: string) => useMachinePoolSelection({ requestKey, onResolved: vi.fn() }),
            { initialProps: 'draft-a' },
        );

        await act(async () => { await hook.getCurrent().selectPool(selection); });
        await hook.rerender('draft-b');
        await act(async () => { await hook.getCurrent().selectPool(selection); });

        expect(boundary.requests.map((request) => JSON.parse(request.body).requestKey))
            .toEqual(['draft-a', 'draft-b']);
        await hook.unmount();
    });

    it('keeps the stable draft identity when retrying the same unsettled attempt', async () => {
        const selection = poolSelection();
        boundary.responders.push(
            async () => Response.json({
                kind: 'unavailable',
                poolId: selection.pool.pool.id,
                reason: 'presence_unavailable',
            }),
            async () => Response.json({
                kind: 'resolved',
                poolId: selection.pool.pool.id,
                machineId: 'machine-after-retry',
                priorityTier: 0,
            }),
        );
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(() => useMachinePoolSelection({
            requestKey: 'stable-draft-retry',
            onResolved: vi.fn(),
        }));

        await act(async () => { await hook.getCurrent().selectPool(selection); });
        await act(async () => { await hook.getCurrent().selectPool(selection); });

        expect(boundary.requests.map((request) => JSON.parse(request.body).requestKey))
            .toEqual(['stable-draft-retry', 'stable-draft-retry']);
        await hook.unmount();
    });

    it('mints a new identity immediately for P to Q and ignores both late success and late error from P', async () => {
        const first = poolSelection();
        const second = {
            ...poolSelection(),
            pool: { ...first.pool, pool: { ...first.pool.pool, id: '9a3f2b10-6d21-4a3f-8b52-71c0d5e9f3aa' } },
        };
        let finishFirst!: (response: Response) => void;
        boundary.responders.push(
            async () => await new Promise<Response>((resolve) => { finishFirst = resolve; }),
            async () => Response.json({
                kind: 'resolved',
                poolId: second.pool.pool.id,
                machineId: 'machine-q',
                priorityTier: 0,
            }),
        );
        const onResolved = vi.fn();
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(() => useMachinePoolSelection({ requestKey: 'stable-draft', onResolved }));

        let pendingFirst!: Promise<boolean>;
        await act(async () => {
            pendingFirst = hook.getCurrent().selectPool(first);
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
        await act(async () => { await hook.getCurrent().selectPool(second); });
        expect(boundary.requests.map((request) => JSON.parse(request.body).requestKey))
            .toEqual(['stable-draft', 'fallback-request-key-1']);
        expect(onResolved).toHaveBeenCalledTimes(1);

        await act(async () => {
            finishFirst(Response.json({
                kind: 'resolved',
                poolId: first.pool.pool.id,
                machineId: 'machine-late-p',
                priorityTier: 0,
            }));
            await pendingFirst;
        });
        expect(onResolved).toHaveBeenCalledTimes(1);
        expect(onResolved).toHaveBeenLastCalledWith({
            serverId: boundary.serverId,
            poolId: second.pool.pool.id,
            machineId: 'machine-q',
        });

        // The rejected transport form is the same stale-result contract.
        let rejectOld!: (error: Error) => void;
        boundary.responders.push(
            async () => await new Promise<Response>((_resolve, reject) => { rejectOld = reject; }),
            async () => Response.json({
                kind: 'resolved',
                poolId: second.pool.pool.id,
                machineId: 'machine-q-again',
                priorityTier: 0,
            }),
        );
        let staleError!: Promise<boolean>;
        await act(async () => {
            staleError = hook.getCurrent().selectPool(first);
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(3));
        await act(async () => { await hook.getCurrent().selectPool(second); });
        await act(async () => {
            rejectOld(new Error('late old failure'));
            await staleError;
        });
        expect(hook.getCurrent().status).toEqual({ kind: 'idle' });
        expect(onResolved).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it('binds a Home B selection to its row Account while unrelated Home A changes', async () => {
        const selection = { ...poolSelection(), serverId: boundary.backgroundServerId, accountId: 'account-b' };
        let finishResolve!: (response: Response) => void;
        boundary.responders.push(async () => await new Promise<Response>((resolve) => {
            finishResolve = resolve;
        }));
        const onResolved = vi.fn();
        const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
        const hook = await renderHook(() => useMachinePoolSelection({
            requestKey: 'draft-account-switch',
            scopeKey: 'unchanged-authoring-target',
            onResolved,
        }));

        let pending!: Promise<boolean>;
        await act(async () => {
            pending = hook.getCurrent().selectPool(selection);
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));

        // An unrelated Home's Account replacement must not retire Home B's request.
        await act(async () => {
            expect(await TokenStorage.setCredentialsForServerUrl('https://machine-pool-selection.test',
                { serverId: boundary.serverId }, { token: createAccountTokenForTests('replacement-account-a') })).toBe(true);
        });
        expect(hook.getCurrent().status.kind).toBe('resolving');

        await act(async () => {
            finishResolve(Response.json({
                kind: 'resolved',
                poolId: selection.pool.pool.id,
                machineId: 'machine-from-home-b',
                priorityTier: 0,
            }));
            await pending;
        });

        expect(onResolved).toHaveBeenCalledWith({
            serverId: boundary.backgroundServerId,
            poolId: selection.pool.pool.id,
            machineId: 'machine-from-home-b',
        });
        expect(hook.getCurrent().status).toEqual({ kind: 'idle' });
        await hook.unmount();
    });

    it.each(['success', 'error'] as const)(
        'makes a late %s from Home B inert after Home B changes Account',
        async (settlement) => {
            const selection = { ...poolSelection(), serverId: boundary.backgroundServerId, accountId: 'account-b' };
            let finishResolve!: (response: Response) => void;
            let rejectResolve!: (error: Error) => void;
            boundary.responders.push(async () => await new Promise<Response>((resolve, reject) => {
                finishResolve = resolve;
                rejectResolve = reject;
            }));
            const onResolved = vi.fn();
            const { useMachinePoolSelection } = await import('./useMachinePoolSelection');
            const hook = await renderHook(() => useMachinePoolSelection({
                requestKey: 'draft-home-b-account-switch',
                onResolved,
            }));

            let pending!: Promise<boolean>;
            await act(async () => {
                pending = hook.getCurrent().selectPool(selection);
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));

            await act(async () => {
                expect(await TokenStorage.setCredentialsForServerUrl('https://machine-pool-selection-background.test',
                    { serverId: boundary.backgroundServerId }, { token: createAccountTokenForTests('replacement-account-b') })).toBe(true);
            });
            await act(async () => {
                if (settlement === 'success') {
                    finishResolve(Response.json({
                        kind: 'resolved',
                        poolId: selection.pool.pool.id,
                        machineId: 'machine-from-prior-account',
                        priorityTier: 0,
                    }));
                } else {
                    rejectResolve(new Error('late prior Account failure'));
                }
                await pending;
            });

            expect(onResolved).not.toHaveBeenCalled();
            expect(hook.getCurrent().status).toEqual({ kind: 'idle' });
            await hook.unmount();
        },
    );
});
