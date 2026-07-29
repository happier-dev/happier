import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createDeferred,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createNavigationMock,
    createRouterMock,
    createStackOptionsCapture,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    PICKER_NAV_STATE,
    PICKER_THEME_COLORS,
} from './testHarness';
import { createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

enableReactActEnvironment();

type KeyboardAvoidingViewProps = Readonly<{
    children?: React.ReactNode;
} & Record<string, unknown>>;

type ProfileEditFormProps = Readonly<{
    onDirtyChange: (isDirty: boolean) => void;
    saveRef: React.MutableRefObject<(() => boolean) | null>;
}>;

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('expo-constants', () => ({
    default: { statusBarHeight: 0 },
}));

vi.mock('@react-navigation/elements', () => ({
    useHeaderHeight: () => 0,
}));

const routerMock = createRouterMock();
const navigationMock = createNavigationMock() as ReturnType<typeof createNavigationMock> & {
    setOptions: ReturnType<typeof vi.fn>;
    addListener: ReturnType<typeof vi.fn>;
};
navigationMock.setOptions = vi.fn();
navigationMock.addListener = vi.fn(() => ({ remove: vi.fn() }));
const stackOptionsCapture = createStackOptionsCapture();
const promptUnsavedChangesAlertSpy = vi.hoisted(() => vi.fn());
const profileRouteParamsState = vi.hoisted(() => ({
    profileData: JSON.stringify({
        id: 'p1',
        name: 'Test profile',
        isBuiltIn: false,
        compatibility: { claude: true, codex: true, gemini: true },
    }),
}));

installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            KeyboardAvoidingView: (props: KeyboardAvoidingViewProps) =>
                React.createElement('KeyboardAvoidingView', props, props.children),
            Platform: { OS: 'ios' },
            useWindowDimensions: () => ({ width: 390, height: 844 }),
        }),
    expoRouter: async () =>
        (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
            navigation: navigationMock,
            params: () => ({ profileData: profileRouteParamsState.profileData }),
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
            stackOptionsCapture,
        }).module,
    unistyles: async () =>
        (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
            theme: {
                colors: {
                    background: PICKER_THEME_COLORS.background,
                    chrome: PICKER_THEME_COLORS.chrome,
                },
            },
            runtime: { insets: { bottom: 0 } },
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: createUseSettingMutableMockFromReader(() => [[], vi.fn()]),
            },
        }),
    modal: async () =>
        (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
            spies: {
                alert: vi.fn(),
                show: vi.fn(),
            },
        }).module,
});

vi.mock('@/components/profiles/edit', () => ({
    LaunchProfileEditForm: (props: ProfileEditFormProps) => React.createElement('LaunchProfileEditForm', props),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024 },
}));

vi.mock('@/sync/domains/profiles/profileUtils', () => ({
    DEFAULT_PROFILES: [],
    getBuiltInProfile: () => null,
    getBuiltInProfileNameKey: () => null,
    resolveProfileById: () => null,
}));

vi.mock('@/sync/domains/profiles/profileMutations', () => ({
    convertBuiltInProfileToCustom: <T,>(profile: T) => profile,
    createEmptyCustomProfile: () => ({ id: 'new', name: '', isBuiltIn: false, compatibility: { claude: true, codex: true, gemini: true } }),
    duplicateProfileForEdit: <T,>(profile: T) => profile,
}));

vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: (...args: unknown[]) => promptUnsavedChangesAlertSpy(...args),
}));

vi.mock('@/components/ui/keyboardAvoidance', () => ({
    KeyboardAwareScreen: ({ children, ...props }: any) =>
        React.createElement('KeyboardAwareScreen', props, props.children ?? children),
}));

async function renderProfileEditor() {
    const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;
    const screen = await renderScreen(React.createElement(ProfileEditScreen));
    const form = screen.findByType('LaunchProfileEditForm' as any);
    return {
        form: form.props as ProfileEditFormProps,
        screen,
    };
}

async function markDirty(form: ProfileEditFormProps): Promise<void> {
    await act(async () => {
        form.onDirtyChange(true);
    });
}

function pressHeaderClose(): void {
    const closeButton = stackOptionsCapture.getResolved()?.headerLeft?.();
    if (!closeButton?.props.onPress) {
        throw new Error('Expected the Profile editor header close button');
    }
    closeButton.props.onPress();
}

async function pressHeaderCloseAndFlush(): Promise<void> {
    await act(async () => {
        pressHeaderClose();
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe('ProfileEditScreen (header buttons)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        stackOptionsCapture.reset();
        promptUnsavedChangesAlertSpy.mockReset();
        promptUnsavedChangesAlertSpy.mockResolvedValue('keepEditing');
        profileRouteParamsState.profileData = JSON.stringify({
            id: 'p1',
            name: 'Test profile',
            isBuiltIn: false,
            compatibility: { claude: true, codex: true, gemini: true },
        });
        navigationMock.dispatch.mockReset();
        navigationMock.goBack.mockReset();
        navigationMock.setOptions.mockReset();
        routerMock.back.mockReset();
        routerMock.replace.mockReset();
        navigationMock.getState = vi.fn(() => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        }));
    });

    it('renders a header close button even when the form is pristine', async () => {
        const { screen } = await renderProfileEditor();

        expect(screen.findAllByType('KeyboardAwareScreen' as any)).toHaveLength(1);
        expect(screen.findAllByType('KeyboardAvoidingView' as any)).toHaveLength(0);

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerLeft).toBe('function');

        await pressHeaderCloseAndFlush();

        expect(promptUnsavedChangesAlertSpy).not.toHaveBeenCalled();
        expect(navigationMock.goBack).toHaveBeenCalledOnce();
    });

    it('renders a disabled header save button when the form is pristine', async () => {
        await renderProfileEditor();

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerRight).toBe('function');

        const headerRight = options?.headerRight;
        const saveButton = headerRight?.();
        expect(saveButton?.props?.disabled).toBe(true);
    });

    it('serializes repeated dirty close presses into one prompt and one discarded continuation', async () => {
        const decision = createDeferred<UnsavedChangesDecision>();
        promptUnsavedChangesAlertSpy.mockReturnValue(decision.promise);
        const { form } = await renderProfileEditor();
        await markDirty(form);

        await act(async () => {
            pressHeaderClose();
            pressHeaderClose();
            await Promise.resolve();
        });

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledOnce();
        expect(navigationMock.goBack).not.toHaveBeenCalled();

        await act(async () => {
            decision.resolve('discard');
            await decision.promise;
            await Promise.resolve();
        });

        expect(navigationMock.goBack).toHaveBeenCalledOnce();
    });

    it('keeps editing without continuing a dirty close', async () => {
        promptUnsavedChangesAlertSpy.mockResolvedValue('keepEditing');
        const { form } = await renderProfileEditor();
        await markDirty(form);

        await pressHeaderCloseAndFlush();

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledOnce();
        expect(navigationMock.goBack).not.toHaveBeenCalled();
    });

    it('lets a successful save own its destination instead of continuing the dirty close', async () => {
        promptUnsavedChangesAlertSpy.mockResolvedValue('save');
        const save = vi.fn(() => true);
        const { form } = await renderProfileEditor();
        form.saveRef.current = save;
        await markDirty(form);

        await pressHeaderCloseAndFlush();

        expect(save).toHaveBeenCalledOnce();
        expect(navigationMock.goBack).not.toHaveBeenCalled();
    });

    it('preserves built-in Save As behavior through the same guarded close transaction', async () => {
        profileRouteParamsState.profileData = JSON.stringify({
            id: 'builtin-test',
            name: 'Built-in test profile',
            isBuiltIn: true,
            compatibility: { claude: true, codex: true, gemini: true },
        });
        promptUnsavedChangesAlertSpy.mockResolvedValue('save');
        const saveAs = vi.fn(() => true);
        const { form } = await renderProfileEditor();
        form.saveRef.current = saveAs;
        await markDirty(form);

        await pressHeaderCloseAndFlush();

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({ saveText: 'common.saveAs' }),
        );
        expect(saveAs).toHaveBeenCalledOnce();
        expect(navigationMock.goBack).not.toHaveBeenCalled();
    });
});
