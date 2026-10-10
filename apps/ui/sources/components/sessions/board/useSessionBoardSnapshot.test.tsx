import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

const harness = vi.hoisted(() => ({
    renewAuthority: null as null | (() => Promise<unknown>),
    withRuntime: vi.fn(),
}));

// The real hook returns referentially stable resolutions; the observation
// lifetime is keyed on that identity, so the stub must be stable too.
const boundResolution = vi.hoisted(() => Object.freeze({
    kind: 'bound' as const,
    scope: Object.freeze({ serverId: 'home-1', accountId: 'account-1' }),
}));

vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeResolution: () => boundResolution,
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ withSessionSystemRecordRuntime: harness.withRuntime }),
}));

vi.mock('./observeSessionBoard', () => ({
    observeSessionBoard: (options: Readonly<{ renewAuthority: () => Promise<unknown> }>) => {
        harness.renewAuthority = options.renewAuthority;
        return vi.fn();
    },
}));

import { useSessionBoardSnapshot } from './useSessionBoardSnapshot';

describe('useSessionBoardSnapshot authority renewal', () => {
    it('reuses current Session state initially and requests one fresh Session hydration after record invalidation', async () => {
        const runtimeSession = {
            id: 'session-1',
            serverId: 'home-1',
            // The store row carries the published `access` projection, never a raw `effectiveAccess` payload.
            access: {
                role: 'owner' as const,
                level: 'owner' as const,
                capabilities: { readTranscript: true, editSessionRecords: true },
            },
        };
        const runtime = {
            scope: { serverId: 'home-1', accountId: 'account-1' },
            repository: {},
            session: runtimeSession,
            contentContext: { mode: 'plain' },
            readSession: () => runtimeSession,
            readContentContext: () => ({ mode: 'plain' }),
            isCurrent: () => true,
        };
        harness.withRuntime.mockImplementation(async (
            _address: unknown,
            operation: (current: typeof runtime) => Promise<unknown>,
        ) => ({ status: 'ok', value: await operation(runtime) }));

        const hook = await renderHook(() => useSessionBoardSnapshot({
            serverId: 'home-1',
            sessionId: 'session-1',
            boardFeatureEnabled: true,
        }));
        await flushHookEffects({ cycles: 10 });

        expect(harness.withRuntime).toHaveBeenCalledTimes(1);
        expect(harness.withRuntime.mock.calls[0]?.[2]).toBeUndefined();
        expect(harness.renewAuthority).not.toBeNull();

        await harness.renewAuthority?.();

        expect(harness.withRuntime).toHaveBeenCalledTimes(2);
        expect(harness.withRuntime.mock.calls[1]?.[2]).toEqual({ forceSessionRefresh: true });
        await hook.unmount();
    });
});
