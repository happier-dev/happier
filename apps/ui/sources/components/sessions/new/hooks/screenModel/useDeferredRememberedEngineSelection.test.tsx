import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

import {
    REMEMBERED_ENGINE_SELECTION_WRITE_DELAY_MS,
    useDeferredRememberedEngineSelection,
} from './useDeferredRememberedEngineSelection';

const target = {
    kind: 'backend' as const,
    backendId: 'codex',
    sourceKind: 'built_in' as const,
};

const accountA: AccountSettingsScope = { serverId: 'server-a', accountId: 'account-a' };
const accountB: AccountSettingsScope = { serverId: 'server-a', accountId: 'account-b' };

function createLifetime(scope: AccountSettingsScope): Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    retire(): void;
}> {
    let retired = false;
    const callbacks = new Set<() => void>();
    return {
        lifetime: {
            scope,
            isCurrent: () => !retired,
            onRetire: (callback) => {
                callbacks.add(callback);
                return {
                    dispose: () => callbacks.delete(callback),
                };
            },
        },
        retire: () => {
            if (retired) return;
            retired = true;
            for (const callback of callbacks) callback();
            callbacks.clear();
        },
    };
}

describe('useDeferredRememberedEngineSelection', () => {
    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('cancels a pending Account A write instead of sending it through the Account B writer', async () => {
        vi.useFakeTimers();
        const commitA = vi.fn();
        const commitB = vi.fn();
        const lifetimeA = createLifetime(accountA);
        const lifetimeB = createLifetime(accountB);
        const hook = await renderHook((props: Readonly<{
            accountLifetime: ActiveServerAccountScopeLifetime;
            commit: (next: Record<string, unknown>) => void;
        }>) => {
            const params = {
                enabled: true,
                selectionsByScope: {},
                serverId: 'server-a',
                accountSettingsScope: props.accountLifetime.scope,
                accountLifetime: props.accountLifetime,
                commit: props.commit,
            };
            return useDeferredRememberedEngineSelection(params);
        }, {
            initialProps: {
                accountLifetime: lifetimeA.lifetime,
                commit: commitA,
            },
        });

        await act(async () => {
            hook.getCurrent()(target, {
                modelSelection: {
                    v: 1,
                    updatedAt: 1,
                    ref: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: null,
                        modelId: 'gpt-5.5',
                    },
                },
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
            });
        });

        lifetimeA.retire();
        await hook.rerender({
            accountLifetime: lifetimeB.lifetime,
            commit: commitB,
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(REMEMBERED_ENGINE_SELECTION_WRITE_DELAY_MS);
        });
        await hook.unmount();

        expect(commitA).not.toHaveBeenCalled();
        expect(commitB).not.toHaveBeenCalled();
    });
});
