import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import type { ApiTokenSettingsController, ApiTokenSettingsState } from './apiTokenSettingsController';

const ACCESSIBILITY_ANNOUNCEMENT = 'Copy your token now — it is shown once.';

const runtime = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
    push: vi.fn(),
    announceAccessibilityMessage: vi.fn(),
    reducedMotion: false,
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => await createReactNativeWebMock({
        Animated: {
            stagger: (_delay: number, animations: readonly { start?: (callback?: () => void) => void }[]) => ({
                start: (callback?: () => void) => {
                    for (const animation of animations) animation.start?.();
                    callback?.();
                },
                stop: () => {},
            }),
        },
        Platform: {
            get OS() {
                return runtime.platform;
            },
            select: <T,>(choices: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
                choices[runtime.platform] ?? choices.native ?? choices.default
            ),
        },
    }),
    router: async () => createExpoRouterMock({ router: { push: runtime.push } }).module,
    text: async () => createTextModuleMock({
        translate: (key) => {
            if (key === 'settingsApiTokens.reveal.accessibilityAnnouncement') return ACCESSIBILITY_ANNOUNCEMENT;
            if (key === 'settingsApiTokens.create.actionSettingsPrefix') {
                return 'This token can perform any operation enabled for External API & SDK in your';
            }
            if (key === 'settingsApiTokens.create.actionSettingsLink') return 'Action settings.';
            return key;
        },
    }),
});

vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: runtime.announceAccessibilityMessage,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => runtime.reducedMotion,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') return flattenStyle(style({ pressed: false, focused: false }));
    if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

function readPhysicalTarget(node: ReactTestInstance): Readonly<{ width: number; height: number }> {
    const style = flattenStyle(node.props.style);
    return {
        width: Math.max(Number(style.width ?? 0), Number(style.minWidth ?? 0)),
        height: Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0)),
    };
}

function createState(reveal: ApiTokenSettingsState['reveal']): ApiTokenSettingsState {
    return {
        phase: 'ready',
        tokens: [],
        isRefreshing: false,
        listError: null,
        createDraft: { label: '', expiryPreset: '90d' },
        createPending: false,
        createError: null,
        reveal,
        operation: null,
        operationTokenId: null,
        operationError: null,
        operationNotice: null,
    };
}

function createController(state: ApiTokenSettingsState): ApiTokenSettingsController {
    return {
        getState: () => state,
        subscribe: () => () => {},
        refresh: async () => {},
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
}

afterEach(() => {
    standardCleanup();
    runtime.platform = 'web';
    runtime.push.mockClear();
    runtime.announceAccessibilityMessage.mockClear();
    runtime.reducedMotion = false;
});

describe('ApiTokenCreateModal', () => {
    it('announces the one-time token and leaves Copy independently reachable to assistive technology', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const controller = createController(createState({
            token: 'hap_v1_11111111-1111-4111-8111-111111111111_abcdefghijklmnopqrstuvwxyz',
            apiToken: {
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_11111111',
                createdAt: '2026-08-22T12:00:00.000Z',
                lastUsedAt: null,
                expiresAt: null,
            },
            acknowledged: false,
        }));

        const screen = await renderScreen(
            <ApiTokenCreateModal controller={controller} onClose={vi.fn()} setChrome={vi.fn()} />,
        );

        expect(runtime.announceAccessibilityMessage).toHaveBeenCalledWith(ACCESSIBILITY_ANNOUNCEMENT);
        const copy = screen.findByTestId('settings-api-tokens-reveal-copy');
        expect(copy?.props.accessibilityRole).toBe('button');

        const ancestors: ReactTestInstance[] = [];
        for (let ancestor = copy?.parent; ancestor; ancestor = ancestor.parent) ancestors.push(ancestor);
        expect(ancestors.some((node) => (
            node.props.accessible === true
            && node.props.accessibilityLabel === ACCESSIBILITY_ANNOUNCEMENT
        ))).toBe(false);
    });

    it('stages short semantic reveal chunks during normal motion', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const controller = createController(createState({
            token: 'hap_v1_11111111-1111-4111-8111-111111111111_abcdefghijklmnopqrstuvwxyz',
            apiToken: {
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_11111111',
                createdAt: '2026-08-22T12:00:00.000Z',
                lastUsedAt: null,
                expiresAt: null,
            },
            acknowledged: false,
        }));

        const screen = await renderScreen(
            <ApiTokenCreateModal controller={controller} onClose={vi.fn()} setChrome={vi.fn()} />,
        );

        expect(screen.findByTestId('settings-api-tokens-reveal-stage-success')).toBeTruthy();
        expect(screen.findByTestId('settings-api-tokens-reveal-stage-warning')).toBeTruthy();
        expect(screen.findByTestId('settings-api-tokens-reveal-stage-secret')).toBeTruthy();
    });

    it('uses one reduced-motion fade instead of staged reveal movement', async () => {
        runtime.reducedMotion = true;
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const controller = createController(createState({
            token: 'hap_v1_11111111-1111-4111-8111-111111111111_abcdefghijklmnopqrstuvwxyz',
            apiToken: {
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_11111111',
                createdAt: '2026-08-22T12:00:00.000Z',
                lastUsedAt: null,
                expiresAt: null,
            },
            acknowledged: false,
        }));

        const screen = await renderScreen(
            <ApiTokenCreateModal controller={controller} onClose={vi.fn()} setChrome={vi.fn()} />,
        );

        expect(screen.findByTestId('settings-api-tokens-reveal-reduced-fade')).toBeTruthy();
        expect(screen.findByTestId('settings-api-tokens-reveal-stage-success')).toBeNull();
    });

    it.each([
        ['web', 'web', 44],
        ['iOS', 'ios', 44],
        ['Android', 'android', 48],
    ] as const)('routes to Action Settings through a physical %s target', async (_name, platform, minimum) => {
        runtime.platform = platform;
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const onClose = vi.fn();
        const screen = await renderScreen(
            <ApiTokenCreateModal
                controller={createController(createState(null))}
                onClose={onClose}
                setChrome={vi.fn()}
            />,
        );

        const actionSettings = screen.findByTestId('settings-api-tokens-action-settings');
        expect(actionSettings?.props.accessibilityRole).toBe('link');
        expect(readPhysicalTarget(actionSettings!)).toEqual({ width: minimum, height: minimum });
        expect(resolveMinimumInteractiveTargetSize(platform)).toBe(minimum);

        screen.pressByTestId('settings-api-tokens-action-settings');
        expect(onClose).toHaveBeenCalledOnce();
        expect(runtime.push).toHaveBeenCalledWith('/settings/actions');
    });
});
