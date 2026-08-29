import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { CustomModalChromeCardConfig } from '@/modal';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import type { ApiTokenSettingsController, ApiTokenSettingsState } from './apiTokenSettingsController';

const ACCESSIBILITY_ANNOUNCEMENT = 'Copy your token now — it is shown once.';

const runtime = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
    push: vi.fn(),
    announceAccessibilityMessage: vi.fn(),
    completeAnimationCallbacks: true,
    reducedMotion: false,
    setClipboardStringSafe: vi.fn(async (_value: string) => true),
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => await createReactNativeWebMock({
        Animated: {
            timing: (_value: unknown, _config: unknown) => ({
                start: (callback?: () => void) => {
                    if (runtime.completeAnimationCallbacks) callback?.();
                },
                stop: () => {},
            }),
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

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: (value: string) => runtime.setClipboardStringSafe(value),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') return flattenStyle(style({ pressed: false, focused: false }));
    if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

function flattenInteractionStyle(style: unknown, focused: boolean): Record<string, unknown> {
    return flattenStyle(typeof style === 'function'
        ? style({ pressed: false, focused })
        : style);
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
        acknowledgeReveal: vi.fn(),
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
    runtime.completeAnimationCallbacks = true;
    runtime.setClipboardStringSafe.mockClear();
    runtime.setClipboardStringSafe.mockResolvedValue(true);
    runtime.reducedMotion = false;
});

describe('ApiTokenCreateModal', () => {
    it('exposes the selected expiry preset through web radio semantics', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const screen = await renderScreen(
            <ApiTokenCreateModal
                controller={createController(createState(null))}
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        const expiryGroup = screen.findAll((node) => node.props.accessibilityRole === 'radiogroup')[0];
        expect(expiryGroup?.props.accessibilityLabel).toBe('settingsApiTokens.create.expiry');
        expect(screen.findByTestId('settings-api-tokens-expiry-30d')?.props['aria-checked']).toBe(false);
        expect(screen.findByTestId('settings-api-tokens-expiry-90d')?.props['aria-checked']).toBe(true);
        expect(screen.findByTestId('settings-api-tokens-expiry-1y')?.props['aria-checked']).toBe(false);
        expect(screen.findByTestId('settings-api-tokens-expiry-none')?.props['aria-checked']).toBe(false);
    });

    it('uses the shared radio-group behavior for web roving focus and selection', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const state = createState(null);
        const setCreateDraft = vi.fn();
        const controller: ApiTokenSettingsController = {
            ...createController(state),
            setCreateDraft,
        };
        const screen = await renderScreen(
            <ApiTokenCreateModal controller={controller} onClose={vi.fn()} setChrome={vi.fn()} />,
        );

        const thirtyDays = screen.findByTestId('settings-api-tokens-expiry-30d');
        const ninetyDays = screen.findByTestId('settings-api-tokens-expiry-90d');
        expect(thirtyDays?.props.tabIndex).toBe(-1);
        expect(ninetyDays?.props.tabIndex).toBe(0);

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        await act(async () => {
            ninetyDays?.props.onKeyDown?.({
                key: 'ArrowLeft',
                nativeEvent: { key: 'ArrowLeft' },
                preventDefault,
                stopPropagation,
            });
        });

        expect(setCreateDraft).toHaveBeenCalledWith({ label: '', expiryPreset: '30d' });
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('holds mutable form controls in their busy state while the one-time token is being minted', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const state: ApiTokenSettingsState = {
            ...createState(null),
            createPending: true,
            createDraft: { label: 'CI', expiryPreset: '90d' },
        };
        const screen = await renderScreen(
            <ApiTokenCreateModal
                controller={createController(state)}
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        expect(screen.findByTestId('settings-api-tokens-create-label')?.props.editable).toBe(false);
        expect(screen.findByTestId('settings-api-tokens-expiry-90d')?.props).toMatchObject({
            disabled: true,
            accessibilityState: { checked: true, disabled: true },
        });
        expect(screen.findByTestId('settings-api-tokens-action-settings')?.props).toMatchObject({
            disabled: true,
            accessibilityState: { disabled: true },
        });
    });

    it('announces the one-time token and leaves Copy independently reachable to assistive technology', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const controller = createController(createState({
            token: 'hap_v1_11111111-1111-4111-8111-111111111111_abcdefghijklmnopqrstuvwxyz',
            apiToken: {
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_v1_11111111',
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
        const setChrome = vi.fn<(chrome: CustomModalChromeCardConfig | null) => void>();
        const controller = createController(createState({
            token: 'hap_v1_11111111-1111-4111-8111-111111111111_abcdefghijklmnopqrstuvwxyz',
            apiToken: {
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_v1_11111111',
                createdAt: '2026-08-22T12:00:00.000Z',
                lastUsedAt: null,
                expiresAt: null,
            },
            acknowledged: false,
        }));

        const screen = await renderScreen(
            <ApiTokenCreateModal controller={controller} onClose={vi.fn()} setChrome={setChrome} />,
        );

        expect(screen.findByTestId('settings-api-tokens-reveal-stage-success')).toBeTruthy();
        expect(screen.findByTestId('settings-api-tokens-reveal-stage-secret')).toBeTruthy();
        expect(screen.findByTestId('settings-api-tokens-reveal-stage-warning')).toBeTruthy();

        const stages = screen.findHostByTestId('settings-api-tokens-reveal-stages');
        expect(stages?.children.map((child) => typeof child === 'string' ? null : child.props.testID)).toEqual([
            'settings-api-tokens-reveal-stage-success',
            'settings-api-tokens-reveal-stage-secret',
            'settings-api-tokens-reveal-stage-warning',
        ]);

        const chrome = setChrome.mock.calls.at(-1)?.[0];
        expect(chrome?.kind).toBe('card');
        const footerScreen = await renderScreen(<>{chrome?.footer}</>);
        expect(footerScreen.findByTestId('settings-api-tokens-reveal-stage-done')).toBeTruthy();
    });

    it('enables Done on schedule even when the web animation driver omits its completion callback', async () => {
        vi.useFakeTimers();
        runtime.completeAnimationCallbacks = false;
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const setChrome = vi.fn<(chrome: CustomModalChromeCardConfig | null) => void>();
        await renderScreen(
            <ApiTokenCreateModal
                controller={createController(createState({
                    token: 'hap_v1_11111111-1111-4111-8111-111111111111_abcdefghijklmnopqrstuvwxyz',
                    apiToken: {
                        tokenId: '11111111-1111-4111-8111-111111111111',
                        label: 'CI',
                        displayPrefix: 'hap_v1_11111111',
                        createdAt: '2026-08-22T12:00:00.000Z',
                        lastUsedAt: null,
                        expiresAt: null,
                    },
                    acknowledged: false,
                }))}
                onClose={vi.fn()}
                setChrome={setChrome}
            />,
        );

        const footer = setChrome.mock.calls.at(-1)?.[0]?.footer;
        const footerScreen = await renderScreen(<>{footer}</>);
        expect(footerScreen.findByTestId('settings-api-tokens-reveal-done')?.props.disabled).toBe(true);

        await act(async () => {
            vi.advanceTimersByTime(5_000);
        });

        expect(footerScreen.findByTestId('settings-api-tokens-reveal-done')?.props.disabled).toBe(false);
    });

    it('uses the copy button itself as the single calm copied-feedback surface', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const token = 'hap_v1_11111111-1111-4111-8111-111111111111_abcdefghijklmnopqrstuvwxyz';
        const screen = await renderScreen(
            <ApiTokenCreateModal
                controller={createController(createState({
                    token,
                    apiToken: {
                        tokenId: '11111111-1111-4111-8111-111111111111',
                        label: 'CI',
                        displayPrefix: 'hap_v1_11111111',
                        createdAt: '2026-08-22T12:00:00.000Z',
                        lastUsedAt: null,
                        expiresAt: null,
                    },
                    acknowledged: false,
                }))}
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        await screen.pressByTestIdAsync('settings-api-tokens-reveal-copy');

        expect(runtime.setClipboardStringSafe).toHaveBeenCalledExactlyOnceWith(token);
        expect(screen.findByTestId('settings-api-tokens-copy-feedback')).toBeNull();
        expect(screen.findByTestId('settings-api-tokens-reveal-copy')?.props.accessibilityLabel)
            .toBe('settingsApiTokens.reveal.copied');
    });

    it('projects one in-flight clipboard request as an accessible busy state', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        let finishCopy!: (copied: boolean) => void;
        runtime.setClipboardStringSafe.mockImplementationOnce(async () => await new Promise<boolean>((resolve) => {
            finishCopy = resolve;
        }));
        const controller = createController(createState({
            token: 'hap_v1_11111111-1111-4111-8111-111111111111_abcdefghijklmnopqrstuvwxyz',
            apiToken: {
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_v1_11111111',
                createdAt: '2026-08-22T12:00:00.000Z',
                lastUsedAt: null,
                expiresAt: null,
            },
            acknowledged: false,
        }));
        const screen = await renderScreen(
            <ApiTokenCreateModal controller={controller} onClose={vi.fn()} setChrome={vi.fn()} />,
        );
        let pendingCopy!: Promise<void>;

        await act(async () => {
            pendingCopy = screen.findByTestId('settings-api-tokens-reveal-copy')?.props.onPress();
            await Promise.resolve();
        });

        expect(screen.findByTestId('settings-api-tokens-reveal-copy')?.props).toMatchObject({
            disabled: true,
            accessibilityState: { disabled: true, busy: true },
        });
        screen.findByTestId('settings-api-tokens-reveal-copy')?.props.onPress();
        expect(runtime.setClipboardStringSafe).toHaveBeenCalledOnce();

        await act(async () => {
            finishCopy(true);
            await pendingCopy;
        });

        expect(screen.findByTestId('settings-api-tokens-reveal-copy')?.props).toMatchObject({
            disabled: false,
            accessibilityState: { disabled: false, busy: false },
        });
        expect(controller.acknowledgeReveal).toHaveBeenCalledOnce();
    });

    it('uses one reduced-motion fade instead of staged reveal movement', async () => {
        runtime.reducedMotion = true;
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const controller = createController(createState({
            token: 'hap_v1_11111111-1111-4111-8111-111111111111_abcdefghijklmnopqrstuvwxyz',
            apiToken: {
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'CI',
                displayPrefix: 'hap_v1_11111111',
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

    it('paints the canonical visible focus ring on every custom web action', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const createScreen = await renderScreen(
            <ApiTokenCreateModal
                controller={createController(createState(null))}
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        for (const testID of [
            'settings-api-tokens-expiry-30d',
            'settings-api-tokens-action-settings',
        ]) {
            const focusedStyle = flattenInteractionStyle(createScreen.findByTestId(testID)?.props.style, true);
            expect(focusedStyle).toMatchObject({
                outlineStyle: 'solid',
                outlineWidth: 2,
                outlineColor: expect.any(String),
            });
        }

        const revealScreen = await renderScreen(
            <ApiTokenCreateModal
                controller={createController(createState({
                    token: 'hap_v1_11111111-1111-4111-8111-111111111111_abcdefghijklmnopqrstuvwxyz',
                    apiToken: {
                        tokenId: '11111111-1111-4111-8111-111111111111',
                        label: 'CI',
                        displayPrefix: 'hap_v1_11111111',
                        createdAt: '2026-08-22T12:00:00.000Z',
                        lastUsedAt: null,
                        expiresAt: null,
                    },
                    acknowledged: false,
                }))}
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );
        const copyFocusedStyle = flattenInteractionStyle(
            revealScreen.findByTestId('settings-api-tokens-reveal-copy')?.props.style,
            true,
        );
        expect(copyFocusedStyle).toMatchObject({
            outlineStyle: 'solid',
            outlineWidth: 2,
            outlineColor: expect.any(String),
        });
    });
});
