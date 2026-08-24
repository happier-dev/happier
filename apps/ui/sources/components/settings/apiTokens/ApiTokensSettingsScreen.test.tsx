import * as React from 'react';
import { ScrollView } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import type { ApiTokenSettingsController, ApiTokenSettingsState } from './apiTokenSettingsController';

const runtime = vi.hoisted(() => ({
    logout: vi.fn(),
    announceAccessibilityMessage: vi.fn(),
    activeServerAccountScope: null as Readonly<{ serverId: string; accountId: string }> | null,
    activeServerAccountScopeListeners: new Set<() => void>(),
    hostActivelyViewed: true,
    hostActivelyViewedListeners: new Set<() => void>(),
}));

installSettingsViewCommonModuleMocks({
    storage: async () => {
        const React = await import('react');
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return {
            ...createStorageModuleStub({}),
            useActiveServerAccountScope: () => React.useSyncExternalStore(
                (listener) => {
                    runtime.activeServerAccountScopeListeners.add(listener);
                    return () => runtime.activeServerAccountScopeListeners.delete(listener);
                },
                () => runtime.activeServerAccountScope,
                () => runtime.activeServerAccountScope,
            ),
        };
    },
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return {
        ...createReanimatedModuleMock(),
        measure: () => null,
    };
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ logout: runtime.logout }),
}));

vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: runtime.announceAccessibilityMessage,
}));

vi.mock('@/utils/runtime/useHostActivelyViewed', async () => {
    const { useSyncExternalStore } = await import('react');
    return {
        useHostActivelyViewed: () => useSyncExternalStore(
            (listener) => {
                runtime.hostActivelyViewedListeners.add(listener);
                return () => runtime.hostActivelyViewedListeners.delete(listener);
            },
            () => runtime.hostActivelyViewed,
            () => true,
        ),
    };
});

function setHostActivelyViewed(next: boolean): void {
    runtime.hostActivelyViewed = next;
    for (const listener of runtime.hostActivelyViewedListeners) listener();
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    return typeof style === 'object' ? style as Record<string, unknown> : {};
}

function createController(state: ApiTokenSettingsState) {
    const refresh = vi.fn(async () => {});
    return {
        controller: {
            getState: () => state,
            subscribe: () => () => {},
            refresh,
            setCreateDraft: () => {},
            resetCreateDraft: () => {},
            createToken: async () => {},
            acknowledgeReveal: () => {},
            clearReveal: () => {},
            requestRevealDismiss: async () => true,
            revokeToken: async () => true,
            revokeAllTokens: async () => 0,
            signOutEverywhere: async () => true,
            clearOperationFeedback: () => {},
            retire: () => {},
        } satisfies ApiTokenSettingsController,
        refresh,
    };
}

function createObservableController(initialState: ApiTokenSettingsState) {
    let state = initialState;
    const listeners = new Set<() => void>();
    const refresh = vi.fn(async () => {});
    const controller: ApiTokenSettingsController = {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        refresh,
        setCreateDraft: () => {},
        resetCreateDraft: () => {},
        createToken: async () => {},
        acknowledgeReveal: () => {},
        clearReveal: () => {},
        requestRevealDismiss: async () => true,
        revokeToken: async () => true,
        revokeAllTokens: async () => 0,
        signOutEverywhere: async () => true,
        clearOperationFeedback: () => {},
        retire: () => {},
    };
    return {
        controller,
        setState(nextState: ApiTokenSettingsState, notify = true) {
            state = nextState;
            if (notify) {
                for (const listener of listeners) listener();
            }
        },
    };
}

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
    runtime.logout.mockClear();
    runtime.announceAccessibilityMessage.mockClear();
    runtime.activeServerAccountScope = null;
    runtime.activeServerAccountScopeListeners.clear();
    runtime.hostActivelyViewed = true;
    runtime.hostActivelyViewedListeners.clear();
});

describe('ApiTokensSettingsScreen', () => {
    it('refreshes again when the authenticated Account scope becomes available after mount', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller, refresh } = createController({
            phase: 'idle',
            tokens: [],
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        expect(refresh).toHaveBeenCalledOnce();

        await act(async () => {
            runtime.activeServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
            for (const listener of runtime.activeServerAccountScopeListeners) listener();
        });

        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('keeps the last known token list visible and offers a non-destructive retry after refresh failure', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller, refresh } = createController({
            phase: 'ready',
            tokens: [{
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_11111111',
                createdAt: '2026-08-22T12:00:00.000Z',
                lastUsedAt: null,
                expiresAt: null,
            }],
            isRefreshing: false,
            listError: 'auth_unavailable',
            createDraft: { label: '', expiryPreset: '90d' },
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        refresh.mockClear();

        expect(screen.findByTestId('settings-api-tokens-row:11111111-1111-4111-8111-111111111111')).toBeTruthy();
        expect(screen.findByTestId('settings-api-tokens-refresh-error')).toBeTruthy();

        await act(async () => {
            screen.pressByTestId('settings-api-tokens-refresh-retry');
        });
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('keeps the empty state visible and offers the same retry after refresh failure', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller, refresh } = createController({
            phase: 'ready',
            tokens: [],
            isRefreshing: false,
            listError: 'auth_unavailable',
            createDraft: { label: '', expiryPreset: '90d' },
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        refresh.mockClear();

        expect(screen.findByTestId('settings-api-tokens-empty')).toBeTruthy();
        expect(screen.findByTestId('settings-api-tokens-refresh-error')).toBeTruthy();

        await act(async () => {
            screen.pressByTestId('settings-api-tokens-refresh-retry');
        });
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('marks a rendered token-list failure as an assertive alert', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller } = createController({
            phase: 'error',
            tokens: [],
            isRefreshing: false,
            listError: 'auth_unavailable',
            createDraft: { label: '', expiryPreset: '90d' },
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        const alert = screen.findHostByTestId('settings-api-tokens-list-error');

        expect(alert?.props).toMatchObject({
            accessibilityRole: 'alert',
            accessibilityLiveRegion: 'assertive',
        });
    });

    it('marks an operation failure as an assertive alert', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller } = createController({
            phase: 'ready',
            tokens: [],
            isRefreshing: false,
            listError: 'auth_unavailable',
            createDraft: { label: '', expiryPreset: '90d' },
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: 'auth_unavailable',
            operationNotice: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        const [alert] = screen.findAll((node) => (
            node.props?.title === 'settingsApiTokens.errors.offline'
            && node.props?.mode === 'info'
        ));

        expect(alert?.props).toMatchObject({
            accessibilityRole: 'alert',
            accessibilityLiveRegion: 'assertive',
        });
    });

    it('uses the final Item row geometry for loading skeletons instead of a fixed-height imitation', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller } = createController({
            phase: 'loading',
            tokens: [],
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        const skeleton = screen.findHostByTestId('settings-api-tokens-skeleton:0');
        const finalMetricRow = screen.findHostByTestId('settings-api-tokens-skeleton-row:0');
        const sharedMetricNode = finalMetricRow?.findAll((node) => (
            typeof node.type === 'string'
            && typeof flattenStyle(node.props.style).minHeight === 'number'
        )).at(0);

        expect(flattenStyle(skeleton?.props.style).height).toBeUndefined();
        expect(sharedMetricNode).toBeTruthy();
    });

    it('pauses its single relative-time/expiry clock while hidden and refreshes both states when visible again', async () => {
        vi.useFakeTimers();
        const now = Date.parse('2026-08-22T12:00:00.000Z');
        vi.setSystemTime(now);
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller } = createController({
            phase: 'ready',
            tokens: [{
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_11111111',
                createdAt: new Date(now - 30_000).toISOString(),
                lastUsedAt: null,
                expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000 + 30_000).toISOString(),
            }],
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        const relativeTimeNow = () => screen.findAll((node) => node.props?.atMs === now - 30_000)[0]?.props.nowMs;

        expect(relativeTimeNow()).toBe(now);
        expect(screen.findByTestId('settings-api-tokens-status:11111111-1111-4111-8111-111111111111')).toBeNull();

        await act(async () => {
            setHostActivelyViewed(false);
        });
        await act(async () => {
            vi.advanceTimersByTime(30_001);
        });

        expect(relativeTimeNow()).toBe(now);
        expect(screen.findByTestId('settings-api-tokens-status:11111111-1111-4111-8111-111111111111')).toBeNull();

        await act(async () => {
            setHostActivelyViewed(true);
        });

        expect(relativeTimeNow()).toBe(now + 30_001);
        expect(screen.findByTestId('settings-api-tokens-status:11111111-1111-4111-8111-111111111111')).toBeTruthy();
    });

    it('keeps a revoked token row mounted briefly while the remaining list reflows', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const tokenA = {
            tokenId: '11111111-1111-4111-8111-111111111111',
            label: 'CI',
            displayPrefix: 'hap_11111111',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
        } as const;
        const tokenB = {
            tokenId: '22222222-2222-4222-8222-222222222222',
            label: 'Release',
            displayPrefix: 'hap_22222222',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
        } as const;
        const initialState: ApiTokenSettingsState = {
            phase: 'ready',
            tokens: [tokenA, tokenB],
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null,
        };
        const observable = createObservableController(initialState);
        const screen = await renderScreen(<ApiTokensSettingsScreen controller={observable.controller} />);

        await act(async () => {
            observable.setState({
                ...initialState,
                tokens: [tokenB],
                operationNotice: 'revoked',
            });
        });

        expect(screen.findByTestId('settings-api-tokens-list-transition-exit-layer')).toBeTruthy();
        expect(screen.findByTestId(`settings-api-tokens-row:${tokenA.tokenId}`)).toBeTruthy();
        expect(screen.findByTestId(`settings-api-tokens-row:${tokenB.tokenId}`)).toBeTruthy();
    });

    it('projects a pending revoke onto its row and announces operation feedback', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const token = {
            tokenId: '11111111-1111-4111-8111-111111111111',
            label: 'CI',
            displayPrefix: 'hap_11111111',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
        } as const;
        const otherToken = {
            tokenId: '22222222-2222-4222-8222-222222222222',
            label: 'Release',
            displayPrefix: 'hap_22222222',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
        } as const;
        const initialState: ApiTokenSettingsState = {
            phase: 'ready',
            tokens: [token, otherToken],
            isRefreshing: false,
            listError: 'auth_unavailable',
            createDraft: { label: '', expiryPreset: '90d' },
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null,
        };
        const observable = createObservableController(initialState);
        const screen = await renderScreen(<ApiTokensSettingsScreen controller={observable.controller} />);

        await act(async () => {
            observable.setState({
                ...initialState,
                operation: 'revoke',
                operationTokenId: token.tokenId,
            });
        });

        expect(screen.findHostByTestId(`settings-api-tokens-row:${token.tokenId}`)?.props.accessibilityState)
            .toMatchObject({ busy: true });
        expect(screen.findHostByTestId('settings-api-tokens-create')?.props.disabled).toBe(true);
        const tokenList = screen.findAllByType(ScrollView).find((node) => node.props.refreshControl);
        expect(tokenList?.props.refreshControl?.props.enabled).toBe(false);
        expect(screen.findHostByTestId('settings-api-tokens-refresh-retry')?.props.disabled).toBe(true);
        for (const rowToken of [token, otherToken]) {
            const [rowActions] = screen.findAll((node) => (
                node.props?.overflowTriggerTestID === `settings-api-tokens-overflow:${rowToken.tokenId}`
            ));
            expect(rowActions?.props.actions).toMatchObject([{ disabled: true }]);
        }

        await act(async () => {
            observable.setState({
                ...initialState,
                tokens: [],
                operationNotice: 'revoked',
            });
        });

        expect(runtime.announceAccessibilityMessage).toHaveBeenCalledWith('settingsApiTokens.notices.revoked');
    });
});
