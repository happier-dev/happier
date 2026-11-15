import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import * as React from 'react';
import { ScrollView } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ApiTokenSettingsController, ApiTokenSettingsState } from './apiTokenSettingsController';

const runtime = vi.hoisted(() => ({
    logout: vi.fn(),
    announceAccessibilityMessage: vi.fn(),
    shimmerRepeats: vi.fn(),
    executeApiTokenAction: vi.fn(),
    activeAccountScopeLifetime: null as ActiveServerAccountScopeLifetime | null,
    activeServerAccountScope: null as Readonly<{ serverId: string; accountId: string }> | null,
    activeServerAccountScopeListeners: new Set<() => void>(),
    activeServerSnapshot: { serverId: 'server-a', serverUrl: 'https://home-a.example.test' },
    hostActivelyViewed: true,
    hostActivelyViewedListeners: new Set<() => void>(),
    routeParams: {} as Record<string, string | undefined>,
    setRouteParams: vi.fn(),
    push: vi.fn(),
    showCreateModal: vi.fn(),
}));

installSettingsViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { setParams: runtime.setRouteParams, push: runtime.push },
        }).module;
        return {
            ...routerMock,
            useLocalSearchParams: () => runtime.routeParams,
            useGlobalSearchParams: () => runtime.routeParams,
        };
    },
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

vi.mock('./showApiTokenCreateModal', () => ({
    showApiTokenCreateModal: (...args: unknown[]) => runtime.showCreateModal(...args),
}));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const reanimated = createReanimatedModuleMock();
    return {
        ...reanimated,
        measure: () => null,
        withRepeat: <T,>(value: T, ...args: unknown[]): T => {
            runtime.shimmerRepeats(value, ...args);
            return reanimated.withRepeat(value);
        },
    };
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ logout: runtime.logout }),
}));

vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: runtime.announceAccessibilityMessage,
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => runtime.activeAccountScopeLifetime,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => runtime.activeServerSnapshot,
}));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

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

function createActiveAccountScopeLifetime(): ActiveServerAccountScopeLifetime {
    const retirementCallbacks = new Set<() => void>();
    return {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => true,
        onRetire(callback) {
            retirementCallbacks.add(callback);
            return { dispose: () => retirementCallbacks.delete(callback) };
        },
    };
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
            refreshEncryptionAvailability: async () => {},
            setCreateDraft: (_draft: ApiTokenSettingsState['createDraft']) => {},
            resetCreateDraft: () => {},
            createToken: async () => {},
            adoptCreatedToken: async () => false,
            acknowledgeReveal: () => {},
            clearReveal: () => {},
            requestRevealDismiss: async () => true,
            // The Account this fake controller serves stays active.
            captureDestructiveTarget: () => ({ scope: { serverId: 'server-a', accountId: 'account-a' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }),
            revokeToken: async () => true,
            revokeAllTokens: async () => 0,
            signOutEverywhere: async () => true,
            clearOperationFeedback: () => {},
            beginAccessEdit: () => true,
            setAccessEditGrant: () => {},
            saveAccessEdit: async () => true,
            updateToken: async () => null,
            cancelAccessEdit: () => {},
            retire: () => {},
        } satisfies ApiTokenSettingsController,
        refresh,
        refreshEncryptionAvailability: async () => {},
    };
}

function createObservableController(initialState: ApiTokenSettingsState) {
    let state = initialState;
    const listeners = new Set<() => void>();
    const refresh = vi.fn(async () => {});
    const clearOperationFeedback = vi.fn();
    const controller: ApiTokenSettingsController = {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        refresh,
        refreshEncryptionAvailability: async () => {},
        setCreateDraft: () => {},
        resetCreateDraft: () => {},
        createToken: async () => {},
        adoptCreatedToken: async () => false,
        acknowledgeReveal: () => {},
        clearReveal: () => {},
        requestRevealDismiss: async () => true,
        // The Account this fake controller serves stays active.
        captureDestructiveTarget: () => ({ scope: { serverId: 'server-a', accountId: 'account-a' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }),
        revokeToken: async () => true,
        revokeAllTokens: async () => 0,
        signOutEverywhere: async () => true,
        clearOperationFeedback,
        beginAccessEdit: () => true,
        setAccessEditGrant: () => {},
        saveAccessEdit: async () => true,
        updateToken: async () => null,
        cancelAccessEdit: () => {},
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
        clearOperationFeedback,
    };
}

// Collect the real screen after installing its boundaries, before individual test deadlines begin.
await import('./ApiTokensSettingsScreen');

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
    runtime.logout.mockClear();
    runtime.announceAccessibilityMessage.mockClear();
    runtime.shimmerRepeats.mockClear();
    runtime.executeApiTokenAction.mockReset();
    runtime.activeAccountScopeLifetime = null;
    runtime.activeServerAccountScope = null;
    runtime.activeServerSnapshot = { serverId: 'server-a', serverUrl: 'https://home-a.example.test' };
    runtime.activeServerAccountScopeListeners.clear();
    runtime.hostActivelyViewed = true;
    runtime.hostActivelyViewedListeners.clear();
    runtime.routeParams = {};
    runtime.setRouteParams.mockClear();
    runtime.push.mockClear();
    runtime.showCreateModal.mockClear();
});

const RESUMED_LIMITED_DRAFT = Object.freeze({
    label: 'Release deploy',
    expiryPreset: '1y' as const,
    encryptionAccess: true,
    access: 'limited' as const,
    grant: {
        ...API_TOKEN_FULL_GRANT_V1,
        actions: { families: ['session_transcripts'], ids: [] },
        origins: ['https://crm.acme.dev'],
    },
});

describe('ApiTokensSettingsScreen', () => {
    it('never resumes a limited draft that lost its grant as Full access', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        runtime.activeServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
        const { grant: _lost, ...withoutGrant } = RESUMED_LIMITED_DRAFT;
        runtime.routeParams = {
            resumeCreate: '1',
            draft: JSON.stringify(withoutGrant),
            targetServerId: 'server-a',
            targetServerUrl: 'https://home-a.example.test',
            expectedAccountId: 'account-a',
        };
        const state: ApiTokenSettingsState = {
            phase: 'ready', tokens: [], isRefreshing: false, listError: null,
            createDraft: { label: '', expiryPreset: '90d' }, encryptionAvailability: 'unchecked',
            recoveryTokenId: null, createPending: false, createError: null, reveal: null,
            operation: null, operationTokenId: null, operationError: null, operationNotice: null, accessEdit: null,
        };
        const { controller } = createController(state);
        const setCreateDraft = vi.spyOn(controller, 'setCreateDraft');

        await renderScreen(<ApiTokensSettingsScreen controller={controller} />);

        expect(setCreateDraft).not.toHaveBeenCalled();
        expect(runtime.showCreateModal).not.toHaveBeenCalled();
    });

    it('restores the complete non-secret draft, limited grant included, and reopens the existing create modal', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        runtime.activeServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
        runtime.routeParams = {
            resumeCreate: '1',
            draft: JSON.stringify(RESUMED_LIMITED_DRAFT),
            targetServerId: 'server-a',
            targetServerUrl: 'https://home-a.example.test',
            expectedAccountId: 'account-a',
        };
        const state: ApiTokenSettingsState = {
            phase: 'ready', tokens: [], isRefreshing: false, listError: null,
            createDraft: { label: '', expiryPreset: '90d' }, encryptionAvailability: 'unchecked',
            recoveryTokenId: null, createPending: false, createError: null, reveal: null,
            operation: null, operationTokenId: null, operationError: null, operationNotice: null, accessEdit: null,
        };
        const { controller } = createController(state);
        const setCreateDraft = vi.spyOn(controller, 'setCreateDraft');

        await renderScreen(<ApiTokensSettingsScreen controller={controller} />);

        expect(setCreateDraft).toHaveBeenCalledWith(RESUMED_LIMITED_DRAFT);
        expect(runtime.showCreateModal).toHaveBeenCalledWith(controller);
        expect(runtime.setRouteParams).toHaveBeenCalledWith({
            resumeCreate: undefined,
            draft: undefined,
            targetServerId: undefined,
            targetServerUrl: undefined,
            expectedAccountId: undefined,
        });
        expect(setCreateDraft.mock.calls[0]?.[0]).not.toHaveProperty('token');
        expect(setCreateDraft.mock.calls[0]?.[0]).not.toHaveProperty('secret');
    });

    it('retires a recovery continuation instead of reopening creation on a different Home Account', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        runtime.activeServerAccountScope = { serverId: 'server-b', accountId: 'account-b' };
        runtime.activeServerSnapshot = { serverId: 'server-b', serverUrl: 'https://home-b.example.test' };
        runtime.routeParams = {
            resumeCreate: '1',
            draft: JSON.stringify(RESUMED_LIMITED_DRAFT),
            targetServerId: 'server-a',
            targetServerUrl: 'https://home-a.example.test',
            expectedAccountId: 'account-a',
        };
        const state: ApiTokenSettingsState = {
            phase: 'ready', tokens: [], isRefreshing: false, listError: null,
            createDraft: { label: '', expiryPreset: '90d' }, encryptionAvailability: 'unchecked',
            recoveryTokenId: null, createPending: false, createError: null, reveal: null,
            operation: null, operationTokenId: null, operationError: null, operationNotice: null, accessEdit: null,
        };
        const { controller } = createController(state);
        const setCreateDraft = vi.spyOn(controller, 'setCreateDraft');

        await renderScreen(<ApiTokensSettingsScreen controller={controller} />);

        expect(setCreateDraft).not.toHaveBeenCalled();
        expect(runtime.showCreateModal).not.toHaveBeenCalled();
        expect(runtime.setRouteParams).toHaveBeenCalledWith({
            resumeCreate: undefined,
            draft: undefined,
            targetServerId: undefined,
            targetServerUrl: undefined,
            expectedAccountId: undefined,
        });
    });

    it('puts the primary create action in the empty state without duplicating it in the header', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller } = createController({
            phase: 'ready',
            tokens: [],
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);

        expect(screen.findByTestId('settings-api-tokens-empty-create')).toBeTruthy();
        expect(screen.findByTestId('settings-api-tokens-create')).toBeNull();
    });

    it('refreshes again when the authenticated Account scope becomes available after mount', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller, refresh } = createController({
            phase: 'idle',
            tokens: [],
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        expect(refresh).toHaveBeenCalledOnce();

        await act(async () => {
            runtime.activeServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
            for (const listener of runtime.activeServerAccountScopeListeners) listener();
        });

        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('loads rows after a direct route mount waits for the Account scope to become current', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        runtime.executeApiTokenAction.mockResolvedValue({
            ok: true,
            result: {
                tokens: [{
                    tokenId: '11111111-1111-4111-8111-111111111111',
                    label: 'CI',
                    displayPrefix: 'hap_v1_11111111',
                    createdAt: '2026-08-22T12:00:00.000Z',
                    lastUsedAt: null,
                    expiresAt: null,
                    hasEncryptionAccess: false,
                    hasUnattendedTeamAccess: false,
                    grant: API_TOKEN_FULL_GRANT_V1,
                    parentTokenId: null,
                    activeChildCount: 0,
                    embedConfig: null,
                }],
            },
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen />);
        expect(runtime.executeApiTokenAction).not.toHaveBeenCalled();

        await act(async () => {
            runtime.activeAccountScopeLifetime = createActiveAccountScopeLifetime();
            runtime.activeServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
            for (const listener of runtime.activeServerAccountScopeListeners) listener();
        });

        await vi.waitFor(() => {
            expect(runtime.executeApiTokenAction).toHaveBeenCalledOnce();
            expect(screen.findByTestId('settings-api-tokens-row:11111111-1111-4111-8111-111111111111')).toBeTruthy();
        });
    });

    it('opens a token detail from its row, and an embed-backed token in Settings → Embeds', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const tokens = [{
            tokenId: '11111111-1111-4111-8111-111111111111',
            label: 'CI',
            displayPrefix: 'hap_v1_11111111',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
            hasEncryptionAccess: false,
            hasUnattendedTeamAccess: false,
            grant: API_TOKEN_FULL_GRANT_V1,
            parentTokenId: null,
            activeChildCount: 0,
            embedConfig: null,
        }, {
            tokenId: '22222222-2222-4222-8222-222222222222',
            label: 'Release',
            displayPrefix: 'hap_v1_22222222',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
            hasEncryptionAccess: true,
            hasUnattendedTeamAccess: false,
            grant: API_TOKEN_FULL_GRANT_V1,
            parentTokenId: null,
            activeChildCount: 0,
            // An embed owns this token; its embed configuration is opaque to this page.
            embedConfig: {} as never,
        }] as const;
        const { controller } = createController({
            phase: 'ready',
            tokens: [...tokens],
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);

        // An embed-backed token leads its context line with its kind; an ordinary token does not.
        const { t } = await import('@/text');
        const subtitle = (tokenId: string) => String(screen.findAll((node) => node.props?.testID === `settings-api-tokens-row:${tokenId}`
            && typeof node.props?.subtitle === 'string')[0]?.props.subtitle ?? '');
        expect(subtitle(tokens[1].tokenId)).toContain(t('settingsApiTokens.embedPill'));
        expect(subtitle(tokens[0].tokenId)).not.toContain(t('settingsApiTokens.embedPill'));

        await screen.pressByTestIdAsync(`settings-api-tokens-row:${tokens[0].tokenId}`);
        await screen.pressByTestIdAsync(`settings-api-tokens-row:${tokens[1].tokenId}`);

        expect(runtime.push.mock.calls.map(([href]) => href)).toEqual([
            `/settings/account/api-tokens/${tokens[0].tokenId}`,
            `/settings/embeds/${tokens[1].tokenId}`,
        ]);
    });

    it('keeps its owned controller current through StrictMode effect replay', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        runtime.activeAccountScopeLifetime = createActiveAccountScopeLifetime();
        runtime.activeServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
        runtime.executeApiTokenAction.mockResolvedValue({
            ok: true,
            result: {
                tokens: [{
                    tokenId: '11111111-1111-4111-8111-111111111111',
                    label: 'CI',
                    displayPrefix: 'hap_v1_11111111',
                    createdAt: '2026-08-22T12:00:00.000Z',
                    lastUsedAt: null,
                    expiresAt: null,
                    hasEncryptionAccess: false,
                    hasUnattendedTeamAccess: false,
                    grant: API_TOKEN_FULL_GRANT_V1,
                    parentTokenId: null,
                    activeChildCount: 0,
                    embedConfig: null,
                }],
            },
        });

        const screen = await renderScreen(
            <React.StrictMode>
                <ApiTokensSettingsScreen />
            </React.StrictMode>,
        );

        await vi.waitFor(() => {
            expect(runtime.executeApiTokenAction).toHaveBeenCalledOnce();
            expect(screen.findByTestId('settings-api-tokens-row:11111111-1111-4111-8111-111111111111')).toBeTruthy();
        });
    });

    it('retires an owned controller and cancels its pending list request on actual unmount', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        runtime.activeAccountScopeLifetime = createActiveAccountScopeLifetime();
        runtime.activeServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
        let requestSignal: AbortSignal | undefined;
        runtime.executeApiTokenAction.mockImplementationOnce(async (_actionId, _input, context) => {
            requestSignal = context?.signal;
            return await new Promise((resolve) => {
                requestSignal?.addEventListener('abort', () => {
                    resolve({ ok: false, errorCode: 'aborted', error: 'aborted' });
                }, { once: true });
            });
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen />);
        await vi.waitFor(() => expect(requestSignal).toBeDefined());
        expect(requestSignal?.aborted).toBe(false);

        await screen.unmount();
        expect(requestSignal?.aborted).toBe(true);
    });

    it('keeps the last known token list visible and offers a non-destructive retry after refresh failure', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller, refresh } = createController({
            phase: 'ready',
            tokens: [{
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_v1_11111111',
                createdAt: '2026-08-22T12:00:00.000Z',
                lastUsedAt: null,
                expiresAt: null,
                hasEncryptionAccess: false,
                hasUnattendedTeamAccess: false,
                grant: API_TOKEN_FULL_GRANT_V1,
                parentTokenId: null,
                activeChildCount: 0,
                embedConfig: null,
            }],
            isRefreshing: false,
            listError: 'auth_unavailable',
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
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

    it('closes the page with Revoke all only when there are tokens to revoke', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const base = {
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' as const },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
        } satisfies Omit<ApiTokenSettingsState, 'phase' | 'tokens'>;
        const none = await renderScreen(<ApiTokensSettingsScreen controller={createController({ ...base, phase: 'ready', tokens: [] }).controller} />);
        // No target, no control: nothing to revoke means no Revoke all at all (not a disabled red row).
        expect(none.findByTestId('settings-api-tokens-revoke-all')).toBeNull();

        const some = await renderScreen(<ApiTokensSettingsScreen controller={createController({
            ...base,
            phase: 'ready',
            tokens: [{
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_v1_11111111',
                createdAt: '2026-08-22T12:00:00.000Z',
                lastUsedAt: null,
                expiresAt: null,
                hasEncryptionAccess: false,
                hasUnattendedTeamAccess: false,
                grant: API_TOKEN_FULL_GRANT_V1,
                parentTokenId: null,
                activeChildCount: 0,
                embedConfig: null,
            }],
        }).controller} />);
        // The page-closing button row, not a destructive row inside a sheet.
        expect(some.findByTestId('settings-api-tokens-closing')).toBeTruthy();
        expect(some.findByTestId('settings-api-tokens-revoke-all')).toBeTruthy();
    });

    it('keeps the empty state visible and offers the same retry after refresh failure', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller, refresh } = createController({
            phase: 'ready',
            tokens: [],
            isRefreshing: false,
            listError: 'auth_unavailable',
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
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

    it('announces a background refresh even when the last-known list is empty', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller } = createController({
            phase: 'ready',
            tokens: [],
            isRefreshing: true,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);

        expect(screen.findHostByTestId('settings-api-tokens-refreshing')?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.findHostByTestId('settings-api-tokens-empty-create')?.props.disabled).toBe(true);
    });

    it('marks a rendered token-list failure as an assertive alert', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller } = createController({
            phase: 'error',
            tokens: [],
            isRefreshing: false,
            listError: 'auth_unavailable',
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
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
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: 'auth_unavailable',
            operationNotice: null, accessEdit: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        const [alert] = screen.findAll((node) => (
            node.props?.title === 'settingsApiTokens.errors.unavailable'
            && node.props?.mode === 'info'
        ));

        expect(alert?.props).toMatchObject({
            accessibilityRole: 'alert',
            accessibilityLiveRegion: 'assertive',
        });
    });

    it('reserves the token rows with the shared quiet placeholder rows while loading', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller } = createController({
            phase: 'loading',
            tokens: [],
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        // The shared quiet placeholder rows (sheet hairline tone), not text glyphs in the text colour:
        // the placeholder must never be the loudest thing on the page.
        const placeholder = screen.findHostByTestId('settings-api-tokens-skeleton');
        expect(placeholder?.props.accessibilityRole).toBe('progressbar');
        expect(screen.findHostByTestId('settings-api-tokens-skeleton-skeleton:0')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('█');
        expect(runtime.shimmerRepeats).not.toHaveBeenCalled();
    });

    it('marks an expiring token and moves it to expired only while the page is viewed', async () => {
        vi.useFakeTimers();
        const now = Date.parse('2026-08-22T12:00:00.000Z');
        vi.setSystemTime(now);
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const { controller } = createController({
            phase: 'ready',
            tokens: [{
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_v1_11111111',
                createdAt: new Date(now - 30_000).toISOString(),
                lastUsedAt: null,
                expiresAt: new Date(now + 30_000).toISOString(),
                hasEncryptionAccess: false,
                hasUnattendedTeamAccess: false,
                grant: API_TOKEN_FULL_GRANT_V1,
                parentTokenId: null,
                activeChildCount: 0,
                embedConfig: null,
            }],
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
        });

        const screen = await renderScreen(<ApiTokensSettingsScreen controller={controller} />);
        const statusLabel = () => screen.findHostByTestId('settings-api-tokens-status:11111111-1111-4111-8111-111111111111')?.props.accessibilityLabel;

        expect(statusLabel()).toBe('settingsApiTokens.status.expiresInMinutes(count=1)');

        await act(async () => {
            setHostActivelyViewed(false);
        });
        await act(async () => {
            vi.advanceTimersByTime(30_001);
        });

        // The page clock is paused while hidden, so nothing re-renders behind it.
        expect(statusLabel()).toBe('settingsApiTokens.status.expiresInMinutes(count=1)');

        await act(async () => {
            setHostActivelyViewed(true);
        });

        expect(statusLabel()).toBe('settingsApiTokens.status.expired');
    });

    it('keeps a revoked token row mounted briefly while the remaining list reflows', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const tokenA = {
            tokenId: '11111111-1111-4111-8111-111111111111',
            label: 'CI',
            displayPrefix: 'hap_v1_11111111',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
            hasEncryptionAccess: false,
            hasUnattendedTeamAccess: false,
            grant: API_TOKEN_FULL_GRANT_V1,
            parentTokenId: null,
            activeChildCount: 0,
            embedConfig: null,
        } as const;
        const tokenB = {
            tokenId: '22222222-2222-4222-8222-222222222222',
            label: 'Release',
            displayPrefix: 'hap_v1_22222222',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
            hasEncryptionAccess: true,
            hasUnattendedTeamAccess: false,
            grant: API_TOKEN_FULL_GRANT_V1,
            parentTokenId: null,
            activeChildCount: 0,
            embedConfig: null,
        } as const;
        const initialState: ApiTokenSettingsState = {
            phase: 'ready',
            tokens: [tokenA, tokenB],
            isRefreshing: false,
            listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
        };
        const observable = createObservableController(initialState);
        const screen = await renderScreen(<ApiTokensSettingsScreen controller={observable.controller} />);

        await act(async () => {
            observable.setState({
                ...initialState,
                tokens: [tokenB],
                operationNotice: 'revoked', accessEdit: null,
            });
        });

        const exitLayer = screen.findByTestId('settings-api-tokens-list-transition-exit-layer');
        expect(exitLayer?.props).toMatchObject({
            'aria-hidden': true,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
            pointerEvents: 'none',
        });
        expect(screen.findByTestId(`settings-api-tokens-row:${tokenA.tokenId}`)).toBeTruthy();
        expect(screen.findByTestId(`settings-api-tokens-row:${tokenB.tokenId}`)).toBeTruthy();
    });

    it('holds a token being revoked and the page actions, then announces the result', async () => {
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const token = {
            tokenId: '11111111-1111-4111-8111-111111111111',
            label: 'CI',
            displayPrefix: 'hap_v1_11111111',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
            hasEncryptionAccess: false,
            hasUnattendedTeamAccess: false,
            grant: API_TOKEN_FULL_GRANT_V1,
            parentTokenId: null,
            activeChildCount: 0,
            embedConfig: null,
        } as const;
        const otherToken = {
            tokenId: '22222222-2222-4222-8222-222222222222',
            label: 'Release',
            displayPrefix: 'hap_v1_22222222',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
            hasEncryptionAccess: false,
            hasUnattendedTeamAccess: false,
            grant: API_TOKEN_FULL_GRANT_V1,
            parentTokenId: null,
            activeChildCount: 0,
            embedConfig: null,
        } as const;
        const initialState: ApiTokenSettingsState = {
            phase: 'ready',
            tokens: [token, otherToken],
            isRefreshing: false,
            listError: 'auth_unavailable',
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
            createPending: false,
            createError: null,
            reveal: null,
            operation: null,
            operationTokenId: null,
            operationError: null,
            operationNotice: null, accessEdit: null,
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
            .toMatchObject({ disabled: true });
        expect(screen.findHostByTestId(`settings-api-tokens-row:${otherToken.tokenId}`)?.props.accessibilityState)
            .not.toMatchObject({ disabled: true });
        expect(screen.findHostByTestId('settings-api-tokens-create')?.props.disabled).toBe(true);
        const tokenList = screen.findAllByType(ScrollView).find((node) => node.props.refreshControl);
        expect(tokenList?.props.refreshControl?.props.enabled).toBe(false);
        expect(screen.findHostByTestId('settings-api-tokens-refresh-retry')?.props.disabled).toBe(true);

        await act(async () => {
            observable.setState({
                ...initialState,
                tokens: [],
                operationNotice: 'revoked', accessEdit: null,
            });
        });

        expect(runtime.announceAccessibilityMessage).toHaveBeenCalledWith('settingsApiTokens.notices.revoked');
    });

    it('clears operation feedback after its brief accessible display window', async () => {
        vi.useFakeTimers();
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const initialState: ApiTokenSettingsState = {
            phase: 'ready', tokens: [], isRefreshing: false, listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null, createPending: false,
            createError: null, reveal: null, operation: null, operationTokenId: null,
            operationError: null, operationNotice: 'revoked', accessEdit: null,
        };
        const observable = createObservableController(initialState);
        await renderScreen(<ApiTokensSettingsScreen controller={observable.controller} />);

        expect(runtime.announceAccessibilityMessage).toHaveBeenCalledWith('settingsApiTokens.notices.revoked');
        expect(observable.clearOperationFeedback).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(5_000); });
        expect(observable.clearOperationFeedback).toHaveBeenCalledTimes(1);
    });

    it('also clears operation errors after the same accessible display window', async () => {
        vi.useFakeTimers();
        const { ApiTokensSettingsScreen } = await import('./ApiTokensSettingsScreen');
        const observable = createObservableController({
            phase: 'ready', tokens: [], isRefreshing: false, listError: null,
            createDraft: { label: '', expiryPreset: '90d' },
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null, createPending: false,
            createError: null, reveal: null, operation: null, operationTokenId: null,
            operationError: 'invalid_request', operationNotice: null, accessEdit: null,
        });
        await renderScreen(<ApiTokensSettingsScreen controller={observable.controller} />);

        expect(observable.clearOperationFeedback).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(5_000); });
        expect(observable.clearOperationFeedback).toHaveBeenCalledTimes(1);
    });
});
