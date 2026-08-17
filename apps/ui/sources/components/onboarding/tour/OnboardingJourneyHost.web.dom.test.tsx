/**
 * @vitest-environment jsdom
 *
 * The renderer test covers the host's semantic props, but a prop bag cannot
 * prove that react-native-web delivers a keyboard activation to the rendered
 * skip link. This mounts the real RNW host element and drives its browser key
 * cycle, which is the boundary where the loaded browser observation was
 * inconclusive.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    OnboardingWizardController,
    OnboardingWizardSurfaceProps,
} from '@/components/onboarding/surfaces/useOnboardingWizardController';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const webViewport = vi.hoisted(() => ({ width: 1280 }));

// The browser host mapping is the subject under test, so this must be the real
// react-native-web implementation rather than the renderer's host shim.
vi.mock('react-native', async () => {
    const actual: Record<string, unknown> = await vi.importActual('react-native-web');
    return {
        ...actual,
        Platform: {
            ...(actual.Platform as object ?? {}),
            OS: 'web',
            select: (values: Record<string, unknown>) => values?.web ?? values?.default,
        },
        useWindowDimensions: () => ({ width: webViewport.width, height: 820, scale: 1, fontScale: 1 }),
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock() as Record<string, unknown>;
    const { Text, View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        ...mock,
        default: { ...(mock.default as object), Text, View },
        Text,
        View,
    };
});

vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));
vi.mock('react-native-svg', () => ({
    __esModule: true,
    default: () => null,
    Circle: () => null,
    G: () => null,
    Line: () => null,
    Path: () => null,
    Rect: () => null,
    Svg: () => null,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false, credentials: null }),
}));

vi.mock('@/components/onboarding/state/usePendingSetupIntent', () => ({
    usePendingSetupIntent: () => null,
}));

vi.mock('@/components/onboarding/surfaces/useSetupWizardController', () => ({
    useSetupWizardController: () => ({
        stepId: 'setup_this_computer',
        body: null,
        onPrimary: () => {},
        primaryLabel: 'Continue',
        primaryDisabled: false,
        onBack: () => {},
        backLabel: 'Back',
        showBack: true,
        onSkip: () => {},
        skipLabel: 'Skip',
        skipDisabled: false,
        showSkip: true,
        footerHint: null,
        goToStep: () => {},
    }),
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => () => {},
}));

// Demo-world persistence and firewall installation are outside this DOM
// contract. The test keeps their lifecycle inert so the real host can be
// exercised without mutating shared test state.
vi.mock('@/demoMode/guards/demoFirewall', () => ({
    installDemoFirewall: () => {},
    uninstallDemoFirewall: () => {},
}));

vi.mock('@/demoMode/seed/seedDemoWorld', () => ({
    seedDemoWorld: async () => undefined,
    clearDemoWorld: async () => ({ residueFindings: [] }),
}));

vi.mock('@/demoMode/seed/storeSnapshot', () => ({
    takeStoreSnapshot: () => null,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => ({}),
            setState: () => {},
        },
    });
});

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: () => {},
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => null,
}));

import { OnboardingJourneyHost } from './OnboardingJourneyHost';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function createPreAuthController(): OnboardingWizardController {
    return {
        stepId: 'auth',
        currentStepIndex: 1,
        stepCount: 2,
        contentTransitionDirection: 'replace',
        showBack: true,
        showSkip: false,
        onBack: vi.fn(),
        onSkip: null,
        onPrimary: vi.fn(),
        primaryLabel: 'Sign in',
        primaryDisabled: false,
        skipLabel: null,
        skipDisabled: false,
        title: 'auth',
        subtitle: null,
        footerHint: null,
        body: null,
        goToStep: vi.fn(),
    };
}

function createWizardSurfaceProps(): OnboardingWizardSurfaceProps {
    return {
        testID: 'wizard',
        layout: 'landscape',
        isDesktopShell: true,
        authEntryOptions: {
            serverAvailability: 'ready',
            serverUrlForCopy: 'https://relay.example.test',
            showAuthActions: true,
            showProviderSignup: false,
            showAnonymousSignup: false,
            showMtlsLogin: false,
            showKeylessProviderLogin: false,
            providerId: null,
            keylessProviderId: null,
            providerSignupTitle: '',
            providerKeylessTitle: '',
            anonymousSignupTitle: '',
            mtlsTitle: '',
            primaryAction: null,
            mtlsPrimary: false,
            keylessPrimary: false,
            autoRedirect: {
                enabled: false,
                providerId: null,
                toKeyedProvision: false,
                toKeylessLogin: false,
                toMtls: false,
                toLegacySignupProvider: false,
            },
            retryServerCheck: () => undefined,
        },
        onCreateAccount: vi.fn(),
        onCreateAccountViaProvider: vi.fn(),
        onLoginWithKeylessProvider: vi.fn(),
        onLoginWithMtls: vi.fn(),
    };
}

function requireElement(testID: string): HTMLElement {
    const element = container?.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    if (!element) throw new Error(`Missing element: ${testID}`);
    return element;
}

function isNativeLink(element: HTMLElement): boolean {
    return element.tagName === 'A' && element.hasAttribute('href');
}

function isNativeButton(element: HTMLElement): element is HTMLButtonElement {
    return element.tagName === 'BUTTON' && element.getAttribute('type') === 'button';
}

/**
 * jsdom does not perform an anchor's keyboard default action. It does deliver
 * the real keydown/keyup path, and the small UA step below is deliberately
 * conditional on a native anchor and unconsumed events. A role-only element
 * therefore gets no invented click: it must handle the real key path itself.
 */
async function activateLinkWithEnter(element: HTMLElement): Promise<void> {
    await act(async () => {
        const keyDown = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        element.dispatchEvent(keyDown);

        const keyPress = new KeyboardEvent('keypress', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        if (!keyDown.defaultPrevented) {
            element.dispatchEvent(keyPress);
        }

        element.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        if (isNativeLink(element) && !keyDown.defaultPrevented && !keyPress.defaultPrevented) {
            element.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                detail: 0,
            }));
        }
    });
}

async function pressWithPointer(element: HTMLElement): Promise<void> {
    await act(async () => {
        const base = { bubbles: true, cancelable: true, button: 0, clientX: 4, clientY: 4 };
        element.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
        element.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
        element.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
    });
}

async function sendSpaceCycle(element: HTMLElement): Promise<void> {
    await act(async () => {
        element.dispatchEvent(new KeyboardEvent('keydown', {
            key: ' ',
            code: 'Space',
            bubbles: true,
            cancelable: true,
        }));
        element.dispatchEvent(new KeyboardEvent('keyup', {
            key: ' ',
            code: 'Space',
            bubbles: true,
            cancelable: true,
        }));
    });
}

/**
 * Browser Space activation for a real native button. jsdom delivers the
 * key events but not the browser's keyup default click, so model that one
 * default action only when the focused element is actually a native button.
 * A role-only element cannot pass by receiving an invented click here.
 */
async function activateNativeButtonWithSpace(element: HTMLElement): Promise<boolean> {
    let nativeActivation = false;
    await act(async () => {
        const keyDown = new KeyboardEvent('keydown', {
            key: ' ',
            code: 'Space',
            bubbles: true,
            cancelable: true,
        });
        element.dispatchEvent(keyDown);
        const keyUp = new KeyboardEvent('keyup', {
            key: ' ',
            code: 'Space',
            bubbles: true,
            cancelable: true,
        });
        element.dispatchEvent(keyUp);

        if (
            isNativeButton(element)
            && !element.disabled
            && !keyDown.defaultPrevented
            && !keyUp.defaultPrevented
        ) {
            nativeActivation = true;
            element.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                detail: 0,
            }));
        }
    });
    return nativeActivation;
}

/**
 * The controlled browser regression supplies an Enter cycle but no resulting
 * click for the Journey primary action. Do not invent that click here: this
 * exercises the real RNW key path which must itself produce the one advance.
 */
async function activatePrimaryWithEnter(element: HTMLElement): Promise<boolean> {
    let consumed = false;
    await act(async () => {
        const keyDown = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        element.dispatchEvent(keyDown);
        consumed = keyDown.defaultPrevented;

        element.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
        }));
    });
    return consumed;
}

async function renderHost(reducedMotion: boolean, width = 1280): Promise<void> {
    webViewport.width = width;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root?.render(
            <OnboardingJourneyHost
                surface="web"
                isDesktopShell
                initialBeatId="A1"
                reducedMotion={reducedMotion}
                preAuthController={createPreAuthController()}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
        );
    });
}

afterEach(async () => {
    const activeRoot = root;
    root = null;
    if (activeRoot) {
        await act(async () => {
            activeRoot.unmount();
        });
    }
    container?.remove();
    container = null;
    webViewport.width = 1280;
    document.body.focus();
    vi.restoreAllMocks();
});

describe('OnboardingJourneyHost web keyboard contracts', () => {
    it.each([false, true])('moves focus exactly once from the real skip link on Enter when reduced motion is %s', async (reducedMotion) => {
        await renderHost(reducedMotion);
        const bypass = requireElement('journey-host-skip-to-content');
        const main = requireElement('journey-host-main-content');
        const focusMain = vi.spyOn(main, 'focus');

        expect(bypass.tagName).toBe('A');
        expect(bypass.getAttribute('href')).toBe('#journey-host-main-content');
        expect(main.id).toBe('journey-host-main-content');
        await act(async () => { bypass.focus(); });
        expect(document.activeElement).toBe(bypass);

        await activateLinkWithEnter(bypass);

        expect(focusMain).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(main);
    });

    it('keeps the link-only Space semantics while pointer activation still moves focus exactly once', async () => {
        await renderHost(false);
        const bypass = requireElement('journey-host-skip-to-content');
        const main = requireElement('journey-host-main-content');
        const focusMain = vi.spyOn(main, 'focus');

        await act(async () => { bypass.focus(); });
        await sendSpaceCycle(bypass);
        expect(focusMain).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(bypass);

        await pressWithPointer(bypass);
        expect(focusMain).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(main);
    });

    it.each([
        {
            name: 'desktop pointer',
            width: 1280,
            primaryTestID: 'journey-host-desktop-config-primary',
            activate: pressWithPointer,
            expectedActivation: undefined,
        },
        {
            name: 'desktop Space',
            width: 1280,
            primaryTestID: 'journey-host-desktop-config-primary',
            activate: activateNativeButtonWithSpace,
            expectedActivation: true,
        },
        {
            name: 'desktop Enter',
            width: 1280,
            primaryTestID: 'journey-host-desktop-config-primary',
            activate: activatePrimaryWithEnter,
            expectedActivation: true,
        },
        {
            name: 'mobile pointer',
            width: 390,
            primaryTestID: 'journey-host-mobile-config-primary',
            activate: pressWithPointer,
            expectedActivation: undefined,
        },
        {
            name: 'mobile Space',
            width: 390,
            primaryTestID: 'journey-host-mobile-config-primary',
            activate: activateNativeButtonWithSpace,
            expectedActivation: true,
        },
        {
            name: 'mobile Enter',
            width: 390,
            primaryTestID: 'journey-host-mobile-config-primary',
            activate: activatePrimaryWithEnter,
            expectedActivation: true,
        },
    ])('advances exactly one beat from the real $name primary button', async ({
        width,
        primaryTestID,
        activate,
        expectedActivation,
    }) => {
        await renderHost(false, width);
        const next = requireElement(primaryTestID);

        expect(isNativeButton(next)).toBe(true);
        await act(async () => { next.focus(); });
        expect(document.activeElement).toBe(next);

        const activation = await activate(next);
        if (expectedActivation !== undefined) {
            expect(activation).toBe(expectedActivation);
        }
        if (width > 680) {
            expect(requireElement('journey-host-desktop-current-beat:A2')).not.toBeNull();
            expect(container?.querySelector('[data-testid="journey-host-desktop-current-beat:A3"]')).toBeNull();
            return;
        }

        const activeA2Page = requireElement('journey-host-mobile-narration-A2')
            .closest<HTMLElement>('[data-testid="journey-host-mobile-page"]');
        const inactiveA4Page = requireElement('journey-host-mobile-narration-A4')
            .closest<HTMLElement>('[data-testid="journey-host-mobile-page"]');
        expect(activeA2Page?.hasAttribute('inert')).toBe(false);
        expect(inactiveA4Page?.hasAttribute('inert')).toBe(true);
    });
});
