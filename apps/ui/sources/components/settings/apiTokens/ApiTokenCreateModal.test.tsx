import { API_TOKEN_FULL_GRANT_V1, type ApiTokenGrantV1 } from '@happier-dev/protocol';
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
    activeServerAccountScope: { serverId: 'home-a', accountId: 'account-a' } as Readonly<{
        serverId: string;
        accountId: string;
    }> | null,
    activeServerSnapshot: { serverId: 'home-a', serverUrl: 'https://home-a.example.test' },
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
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return {
            ...createStorageModuleStub({}),
            useActiveServerAccountScope: () => runtime.activeServerAccountScope,
        };
    },
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

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => runtime.activeServerSnapshot,
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
            encryptionAvailability: 'unchecked',
            recoveryTokenId: null,
        createPending: false,
        createError: null,
        reveal,
        operation: null,
        operationTokenId: null,
        operationError: null,
        operationNotice: null, accessEdit: null,
    };
}

function createController(state: ApiTokenSettingsState): ApiTokenSettingsController {
    return {
        getState: () => state,
        subscribe: () => () => {},
        refresh: async () => {},
        refreshEncryptionAvailability: async () => {},
        setCreateDraft: () => {},
        resetCreateDraft: () => {},
        createToken: async () => {},
        adoptCreatedToken: () => false,
        acknowledgeReveal: vi.fn(),
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
    runtime.activeServerAccountScope = { serverId: 'home-a', accountId: 'account-a' };
});

describe('ApiTokenCreateModal', () => {
    it('carries the complete non-secret create draft through recovery and returns to this modal', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: ['session_transcripts'], ids: [] }, origins: ['https://crm.acme.dev'] } satisfies ApiTokenGrantV1;
        const state = {
            ...createState(null),
            createDraft: { label: 'Release deploy', expiryPreset: '1y' as const, encryptionAccess: true, access: 'limited' as const, grant },
            createError: 'api_token_encryption_not_ready' as const,
        };
        const onClose = vi.fn();
        const screen = await renderScreen(
            <ApiTokenCreateModal controller={createController(state)} onClose={onClose} setChrome={vi.fn()} />,
        );

        await screen.pressByTestIdAsync('settings-api-tokens-restore-encryption');

        expect(onClose).toHaveBeenCalledOnce();
        const destination = String(runtime.push.mock.calls[0]?.[0]);
        expect(destination).toContain('/restore/manual?returnTo=');
        const resumed = new URL(destination, 'https://app.test').searchParams;
        expect(resumed.get('returnTo')).toBe('/settings/account/api-tokens');
        expect(JSON.parse(resumed.get('draft') ?? 'null')).toEqual({
            label: 'Release deploy', expiryPreset: '1y', encryptionAccess: true, access: 'limited', grant,
        });
        expect(destination).toContain('targetServerId=home-a');
        expect(destination).toContain('targetServerUrl=https%3A%2F%2Fhome-a.example.test');
        expect(destination).toContain('expectedAccountId=account-a');
        expect(destination).not.toContain('token=');
        expect(destination).not.toContain('secret=');
    });

    it('offers the shared recovery continuation for a bearer-only create whose outcome is unknown', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const requestedTokenId = '11111111-1111-4111-8111-111111111111';
        const state = {
            ...createState(null),
            createDraft: { label: 'Release deploy', expiryPreset: '90d' as const },
            createError: 'outcome_unknown' as const,
            recoveryTokenId: requestedTokenId,
        };
        const setChrome = vi.fn<(chrome: CustomModalChromeCardConfig | null) => void>();
        const screen = await renderScreen(
            <ApiTokenCreateModal controller={createController(state)} onClose={vi.fn()} setChrome={setChrome} />,
        );

        expect(screen.findByTestId('settings-api-tokens-create-recovery')).toBeTruthy();
        expect(screen.getTextContent()).toContain(requestedTokenId);
        // No credential material exists for an unknown outcome, and a
        // replacement stays blocked until the list reconciles that exact row.
        expect(screen.findAllHostsByTestId('settings-api-tokens-reveal-copy')).toHaveLength(0);
        const footer = setChrome.mock.calls.at(-1)?.[0]?.footer;
        const footerScreen = await renderScreen(<>{footer}</>);
        expect(footerScreen.findByTestId('settings-api-tokens-create-submit')?.props.disabled).toBe(true);
    });

    it('offers encryption consent on capable devices and preserves the selected choice', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const state = { ...createState(null), encryptionAvailability: 'ready' as const };
        const controller = createController(state);
        const update = vi.spyOn(controller, 'setCreateDraft');
        const screen = await renderScreen(<ApiTokenCreateModal controller={controller} onClose={vi.fn()} setChrome={vi.fn()} />);
        const choice = screen.findByTestId('settings-api-tokens-encryption-access');
        await act(async () => choice!.props.onValueChange(true));
        expect(update).toHaveBeenCalledWith({ ...state.createDraft, encryptionAccess: true });
    });

    it('offers an independent explicit unattended Team-access choice', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const state = createState(null);
        const controller = createController(state);
        const update = vi.spyOn(controller, 'setCreateDraft');
        const screen = await renderScreen(<ApiTokenCreateModal controller={controller} onClose={vi.fn()} setChrome={vi.fn()} />);
        const choice = screen.findByTestId('settings-api-tokens-unattended-team-access');
        await act(async () => choice!.props.onValueChange(true));
        expect(update).toHaveBeenCalledWith({ ...state.createDraft, authorizeUnattendedTeamAccess: true });
    });

    it('sets the expiry from its segmented choice', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const setCreateDraft = vi.fn();
        const controller: ApiTokenSettingsController = { ...createController(createState(null)), setCreateDraft };
        const screen = await renderScreen(<ApiTokenCreateModal controller={controller} onClose={vi.fn()} setChrome={vi.fn()} />);

        await screen.pressByTestIdAsync('settings-api-tokens-expiry:30d');

        expect(setCreateDraft).toHaveBeenCalledWith({ label: '', expiryPreset: '30d' });
    });

    it('continues a limited token to the grant editor before it can be created', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const state: ApiTokenSettingsState = {
            ...createState(null),
            createDraft: { label: 'Leads dashboard', expiryPreset: '30d', access: 'limited', grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [] } } },
        };
        const setChrome = vi.fn<(chrome: CustomModalChromeCardConfig | null) => void>();
        const screen = await renderScreen(<ApiTokenCreateModal controller={createController(state)} onClose={vi.fn()} setChrome={setChrome} />);
        const footer = async () => await renderScreen(<>{setChrome.mock.calls.at(-1)?.[0]?.footer}</>);

        expect((await footer()).findByTestId('settings-api-tokens-create-submit')).toBeNull();
        const continueButton = (await footer()).findByTestId('settings-api-tokens-create-continue');
        await act(async () => { continueButton?.props.onPress(); });

        expect(screen.findByTestId('api-token-grant-actions')).toBeTruthy();
        // No action is chosen yet, so the grant cannot succeed and Create stays unavailable.
        expect((await footer()).findByTestId('settings-api-tokens-create-submit')?.props.disabled).toBe(true);
    });

    it('makes the open grant picker\'s Done the one footer action, returning to the same draft summary', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const state: ApiTokenSettingsState = {
            ...createState(null),
            createDraft: { label: 'Leads dashboard', expiryPreset: '30d', access: 'limited', grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [] } } },
        };
        const setChrome = vi.fn<(chrome: CustomModalChromeCardConfig | null) => void>();
        const screen = await renderScreen(<ApiTokenCreateModal controller={createController(state)} onClose={vi.fn()} setChrome={setChrome} />);
        const footer = async () => await renderScreen(<>{setChrome.mock.calls.at(-1)?.[0]?.footer}</>);
        const continueButton = (await footer()).findByTestId('settings-api-tokens-create-continue');
        await act(async () => { continueButton?.props.onPress(); });

        await screen.pressByTestIdAsync('api-token-grant-actions');
        const pickerFooter = await footer();
        // Lab T5: while a picker is open, its Done is the footer; Create and Back wait for the summary.
        expect(pickerFooter.findByTestId('settings-api-tokens-create-submit')).toBeNull();
        expect(pickerFooter.findByTestId('settings-api-tokens-create-back')).toBeNull();
        const done = pickerFooter.findByTestId('api-token-grant-picker-done');
        expect(done).toBeTruthy();

        await act(async () => { done?.props.onPress(); });
        expect(screen.findByTestId('api-token-grant-actions')).toBeTruthy();
        expect((await footer()).findByTestId('api-token-grant-picker-done')).toBeNull();
        expect((await footer()).findByTestId('settings-api-tokens-create-submit')).toBeTruthy();
    });

    it('gives editing access the same picker Done, in place of Save, while a picker is open', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const token = {
            tokenId: '11111111-1111-4111-8111-111111111111',
            label: 'Leads dashboard',
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
        };
        const setChrome = vi.fn<(chrome: CustomModalChromeCardConfig | null) => void>();
        const screen = await renderScreen(
            <ApiTokenCreateModal
                mode="editAccess"
                controller={createController({
                    ...createState(null),
                    tokens: [token],
                    accessEdit: { tokenId: token.tokenId, grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true }, pending: false, error: null, signsOutEmbeddedCredentials: false },
                })}
                onClose={vi.fn()}
                setChrome={setChrome}
            />,
        );
        const footer = async () => await renderScreen(<>{setChrome.mock.calls.at(-1)?.[0]?.footer}</>);

        await screen.pressByTestIdAsync('api-token-grant-actions');
        expect((await footer()).findByTestId('settings-api-tokens-edit-save')).toBeNull();
        const done = (await footer()).findByTestId('api-token-grant-picker-done');
        await act(async () => { done?.props.onPress(); });
        expect(screen.findByTestId('api-token-grant-actions')).toBeTruthy();
        expect((await footer()).findByTestId('settings-api-tokens-edit-save')).toBeTruthy();
    });

    it('warns that saving edited access signs out active embedded credentials', async () => {
        const { ApiTokenCreateModal } = await import('./ApiTokenCreateModal');
        const token = {
            tokenId: '11111111-1111-4111-8111-111111111111',
            label: 'Leads dashboard',
            displayPrefix: 'hap_v1_11111111',
            createdAt: '2026-08-22T12:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
            hasEncryptionAccess: false,
            hasUnattendedTeamAccess: false,
            grant: API_TOKEN_FULL_GRANT_V1,
            parentTokenId: null,
            activeChildCount: 2,
            embedConfig: null,
        };
        const renderEdit = async (signsOutEmbeddedCredentials: boolean) => {
            const setChrome = vi.fn<(chrome: CustomModalChromeCardConfig | null) => void>();
            await renderScreen(
                <ApiTokenCreateModal
                    mode="editAccess"
                    controller={createController({
                        ...createState(null),
                        tokens: [token],
                        accessEdit: { tokenId: token.tokenId, grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true }, pending: false, error: null, signsOutEmbeddedCredentials },
                    })}
                    onClose={vi.fn()}
                    setChrome={setChrome}
                />,
            );
            return await renderScreen(<>{setChrome.mock.calls.at(-1)?.[0]?.footer}</>);
        };

        const withChildren = await renderEdit(true);
        expect(withChildren.findByTestId('settings-api-tokens-edit-signs-out')).toBeTruthy();
        expect(withChildren.findByTestId('settings-api-tokens-edit-save')?.props.disabled).toBe(false);
        expect((await renderEdit(false)).findByTestId('settings-api-tokens-edit-signs-out')).toBeNull();
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
                hasEncryptionAccess: false,
                hasUnattendedTeamAccess: false,
                grant: API_TOKEN_FULL_GRANT_V1,
                parentTokenId: null,
                activeChildCount: 0,
                embedConfig: null,
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
                hasEncryptionAccess: false,
                hasUnattendedTeamAccess: false,
                grant: API_TOKEN_FULL_GRANT_V1,
                parentTokenId: null,
                activeChildCount: 0,
                embedConfig: null,
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
        // The body says "shown once" a single time; the title band does not repeat it.
        expect(chrome?.subtitle).toBeUndefined();
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
                        hasEncryptionAccess: false,
                        hasUnattendedTeamAccess: false,
                        grant: API_TOKEN_FULL_GRANT_V1,
                        parentTokenId: null,
                        activeChildCount: 0,
                        embedConfig: null,
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
                        hasEncryptionAccess: false,
                        hasUnattendedTeamAccess: false,
                        grant: API_TOKEN_FULL_GRANT_V1,
                        parentTokenId: null,
                        activeChildCount: 0,
                        embedConfig: null,
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
                hasEncryptionAccess: false,
                hasUnattendedTeamAccess: false,
                grant: API_TOKEN_FULL_GRANT_V1,
                parentTokenId: null,
                activeChildCount: 0,
                embedConfig: null,
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
                hasEncryptionAccess: false,
                hasUnattendedTeamAccess: false,
                grant: API_TOKEN_FULL_GRANT_V1,
                parentTokenId: null,
                activeChildCount: 0,
                embedConfig: null,
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
                        hasEncryptionAccess: false,
                        hasUnattendedTeamAccess: false,
                        grant: API_TOKEN_FULL_GRANT_V1,
                        parentTokenId: null,
                        activeChildCount: 0,
                        embedConfig: null,
                    },
                    acknowledged: false,
                }))}
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );
        // Copy is the shared button: keyboard focus paints the canonical ring on its visible pill.
        await act(async () => { revealScreen.findByTestId('settings-api-tokens-reveal-copy')?.props.onFocus({}); });
        const ringed = revealScreen.findByTestId('settings-api-tokens-reveal-copy')!
            .findAll((node) => typeof node.type === 'string' && flattenStyle(node.props.style).outlineStyle === 'solid');
        expect(ringed.length).toBeGreaterThan(0);
        expect(flattenStyle(ringed[0]!.props.style)).toMatchObject({ outlineWidth: 2, outlineColor: expect.any(String) });
    });
});
