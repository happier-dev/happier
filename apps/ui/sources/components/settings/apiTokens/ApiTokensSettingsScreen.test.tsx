import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import type { ApiTokenSettingsController, ApiTokenSettingsState } from './apiTokenSettingsController';

const runtime = vi.hoisted(() => ({
    logout: vi.fn(),
}));

installSettingsViewCommonModuleMocks();

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ logout: runtime.logout }),
}));

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
    runtime.logout.mockClear();
});

describe('ApiTokensSettingsScreen', () => {
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
});
