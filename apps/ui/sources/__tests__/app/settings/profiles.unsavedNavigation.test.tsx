import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiLaunchProfile } from '@happier-dev/protocol';

import {
    createDeferred,
    createExpoRouterMock,
    createReactNavigationNativeMock,
    createReactNativeWebMock,
    createStorageModuleStub,
    renderScreen,
    standardCleanup,
    type RenderScreenResult,
} from '@/dev/testkit';
import { createCapturingComponent, createPassThroughComponent } from '@/dev/testkit/mocks/components';
import { installProfilesCommonModuleMocks } from '@/components/profiles/profilesTestHelpers';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

type BeforeRemoveEvent = {
    data: { action: unknown };
    preventDefault: () => void;
};

type CapturedProfilesListProps = {
    onAddProfilePress?: () => void;
    onEditProfile?: (profile: AIBackendProfile) => void;
};

type CapturedEditFormProps = {
    profile: AiLaunchProfile;
    onSave: (profile: AiLaunchProfile) => boolean;
    onCancel: () => void;
    onDirtyChange: (isDirty: boolean) => void;
    saveRef: React.MutableRefObject<(() => boolean) | null>;
};

const promptUnsavedChangesAlertSpy = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({
    legacyBeforeRemove: null as null | ((event: BeforeRemoveEvent) => void),
    preventRemoveEnabled: false,
    preventRemoveCallback: null as null | ((event: { data: { action: unknown } }) => void),
    dispatch: vi.fn(),
}));
const settingsState = vi.hoisted(() => ({
    values: {
        useProfiles: true,
        profiles: [],
        lastUsedProfile: null,
        favoriteProfiles: [],
        profileEnabledById: {},
        providerSettingsV1: null,
        secretBindingsByProfileId: {},
    } as Record<string, unknown>,
}));

installProfilesCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({
        Platform: { OS: 'web' },
    }),
    storage: () => createStorageModuleStub({
        useAllMachines: () => [],
        useSetting: (key: string) => settingsState.values[key],
        useSettingMutable: (key: string) => [
            settingsState.values[key],
            vi.fn((value: unknown) => {
                settingsState.values[key] = value;
            }),
        ],
    }),
});

vi.mock('@react-navigation/native', () => createReactNavigationNativeMock({
    usePreventRemove: (enabled, callback) => {
        navigationState.preventRemoveEnabled = enabled;
        navigationState.preventRemoveCallback = callback;
    },
}));

vi.mock('expo-router', () => createExpoRouterMock({
    navigation: {
        addListener: (event: string, callback: (event: BeforeRemoveEvent) => void) => {
            if (event === 'beforeRemove') {
                navigationState.legacyBeforeRemove = callback;
            }
            return { remove: vi.fn() };
        },
        dispatch: navigationState.dispatch,
    },
}).module);

vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: (...args: unknown[]) => promptUnsavedChangesAlertSpy(...args),
}));

vi.mock('@/components/secrets/useSavedSecretsMutable', () => ({
    useSavedSecretsMutable: () => [[], vi.fn()],
}));

let capturedProfilesListProps: CapturedProfilesListProps | null = null;
vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: createCapturingComponent('ProfilesList', (props) => {
        capturedProfilesListProps = props as CapturedProfilesListProps;
    }),
}));

let capturedEditFormProps: CapturedEditFormProps | null = null;
vi.mock('@/components/profiles/edit', () => ({
    LaunchProfileEditForm: createCapturingComponent('LaunchProfileEditForm', (props) => {
        capturedEditFormProps = props as CapturedEditFormProps;
    }),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: createPassThroughComponent('ItemList'),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassThroughComponent('ItemGroup'),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassThroughComponent('Item'),
}));
vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: createPassThroughComponent('Switch'),
}));
vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: createPassThroughComponent('SecretRequirementModal'),
}));
vi.mock('@/components/profiles/migration/LegacyProfileMigrationFlow', () => ({
    LegacyProfileMigrationFlow: createPassThroughComponent('LegacyProfileMigrationFlow'),
}));
vi.mock('@/components/profiles/migration/LegacyProfileMigrationConflictFlow', () => ({
    LegacyProfileMigrationConflictFlow: createPassThroughComponent('LegacyProfileMigrationConflictFlow'),
}));

function currentBeforeRemoveCallback(): (event: BeforeRemoveEvent) => void {
    if (navigationState.preventRemoveEnabled && navigationState.preventRemoveCallback) {
        return navigationState.preventRemoveCallback;
    }
    if (navigationState.legacyBeforeRemove) {
        return navigationState.legacyBeforeRemove;
    }
    throw new Error('ProfileManager did not register an unsaved-navigation guard');
}

async function renderDirtyInlineEditor() {
    const ProfileManager = (await import('@/app/(app)/settings/profiles')).default;
    const screen = await renderScreen(React.createElement(ProfileManager));
    await act(async () => {
        capturedProfilesListProps?.onAddProfilePress?.();
    });
    expect(capturedEditFormProps).not.toBeNull();
    await act(async () => {
        capturedEditFormProps?.onDirtyChange(true);
    });
    return screen;
}

function hasInlineEditor(screen: RenderScreenResult): boolean {
    return screen.findAll((node) => String(node.type) === 'LaunchProfileEditForm').length > 0;
}

async function invokeAndFlush(callback: () => void): Promise<void> {
    await act(async () => {
        callback();
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe('ProfileManager web unsaved navigation', () => {
    beforeEach(() => {
        capturedProfilesListProps = null;
        capturedEditFormProps = null;
        navigationState.legacyBeforeRemove = null;
        navigationState.preventRemoveEnabled = false;
        navigationState.preventRemoveCallback = null;
        navigationState.dispatch.mockReset();
        promptUnsavedChangesAlertSpy.mockReset();
        settingsState.values.useProfiles = true;
        settingsState.values.profiles = [];
    });

    afterEach(() => {
        standardCleanup();
    });

    it('serializes repeated navigator exits while the first decision is pending', async () => {
        const decision = createDeferred<UnsavedChangesDecision>();
        promptUnsavedChangesAlertSpy.mockReturnValue(decision.promise);
        await renderDirtyInlineEditor();
        const beforeRemove = currentBeforeRemoveCallback();

        await act(async () => {
            beforeRemove({
                data: { action: { type: 'GO_BACK', key: 'first' } },
                preventDefault: vi.fn(),
            });
            beforeRemove({
                data: { action: { type: 'GO_BACK', key: 'second' } },
                preventDefault: vi.fn(),
            });
            await Promise.resolve();
        });

        await act(async () => {
            decision.resolve('keepEditing');
            await decision.promise;
            await Promise.resolve();
        });

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledOnce();
        expect(navigationState.dispatch).not.toHaveBeenCalled();
        expect(capturedEditFormProps).not.toBeNull();
    });

    it('keeps a dirty inline editor open on Keep editing and closes it on Discard', async () => {
        promptUnsavedChangesAlertSpy
            .mockResolvedValueOnce('keepEditing')
            .mockResolvedValueOnce('discard');
        const screen = await renderDirtyInlineEditor();
        const editForm = capturedEditFormProps;
        if (!editForm) throw new Error('Expected the inline Profile editor');

        await invokeAndFlush(editForm.onCancel);

        expect(hasInlineEditor(screen)).toBe(true);
        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledTimes(1);

        await invokeAndFlush(editForm.onCancel);

        expect(hasInlineEditor(screen)).toBe(false);
        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledTimes(2);
    });

    it('keeps the dirty editor and navigation blocked on save failure, then continues after save succeeds', async () => {
        promptUnsavedChangesAlertSpy.mockResolvedValue('save');
        const screen = await renderDirtyInlineEditor();
        const firstEditForm = capturedEditFormProps;
        if (!firstEditForm) throw new Error('Expected the inline Profile editor');
        firstEditForm.saveRef.current = () => false;

        await invokeAndFlush(() => currentBeforeRemoveCallback()({
            data: { action: { type: 'GO_BACK', key: 'save-fails' } },
            preventDefault: vi.fn(),
        }));

        expect(hasInlineEditor(screen)).toBe(true);
        expect(navigationState.dispatch).not.toHaveBeenCalled();

        const currentEditForm = capturedEditFormProps;
        if (!currentEditForm) throw new Error('Expected the inline Profile editor after save failure');
        currentEditForm.saveRef.current = () => currentEditForm.onSave({
            ...currentEditForm.profile,
            name: 'Saved profile',
        });

        await invokeAndFlush(() => currentBeforeRemoveCallback()({
            data: { action: { type: 'GO_BACK', key: 'save-succeeds' } },
            preventDefault: vi.fn(),
        }));

        expect(hasInlineEditor(screen)).toBe(false);
        expect(navigationState.dispatch).toHaveBeenCalledOnce();
        expect(navigationState.dispatch).toHaveBeenCalledWith({
            type: 'GO_BACK',
            key: 'save-succeeds',
        });
    });

    it('closes the dirty editor before continuing a discarded navigator action', async () => {
        promptUnsavedChangesAlertSpy.mockResolvedValue('discard');
        const screen = await renderDirtyInlineEditor();
        const action = { type: 'GO_BACK', key: 'discard' };

        await invokeAndFlush(() => currentBeforeRemoveCallback()({
            data: { action },
            preventDefault: vi.fn(),
        }));

        expect(hasInlineEditor(screen)).toBe(false);
        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledOnce();
        expect(navigationState.dispatch).toHaveBeenCalledOnce();
        expect(navigationState.dispatch).toHaveBeenCalledWith(action);
    });

    it('keeps built-in Save As prompt semantics for the web inline editor', async () => {
        const { DEFAULT_PROFILES } = await import('@/sync/domains/profiles/profileUtils');
        const builtInDefinition = DEFAULT_PROFILES[0];
        if (!builtInDefinition) throw new Error('Expected at least one built-in Profile fixture');
        const { createEmptyCustomProfile } = await import('@/sync/domains/profiles/profileMutations');
        const { projectAiLaunchProfileForLegacyUi } = await import('@/sync/domains/profiles/aiLaunchProfileCollection');
        const emptyProfile = createEmptyCustomProfile();
        const projectedProfile = projectAiLaunchProfileForLegacyUi({
            ...emptyProfile,
            name: 'Built-in test profile',
        });
        const builtIn: AIBackendProfile = {
            ...projectedProfile,
            id: builtInDefinition.id,
            name: builtInDefinition.name,
            isBuiltIn: true,
        };
        promptUnsavedChangesAlertSpy.mockResolvedValue('keepEditing');
        const ProfileManager = (await import('@/app/(app)/settings/profiles')).default;
        await renderScreen(React.createElement(ProfileManager));

        await act(async () => {
            capturedProfilesListProps?.onEditProfile?.(builtIn);
        });
        await act(async () => {
            capturedEditFormProps?.onDirtyChange(true);
        });
        const editForm = capturedEditFormProps;
        if (!editForm) throw new Error('Expected the built-in inline Profile editor');

        await invokeAndFlush(editForm.onCancel);

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                saveText: 'common.saveAs',
                message: expect.stringContaining('profiles.builtInSaveAsHint'),
            }),
        );
    });

    it('uses the shared browser-unload guard only while the inline draft is dirty', async () => {
        const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
        type BeforeUnloadHandler = (event: {
            preventDefault: () => void;
            returnValue?: string;
        }) => void;
        const beforeUnloadHandlerRef: { current: BeforeUnloadHandler | null } = { current: null };
        const addEventListener = vi.fn((type: string, handler: BeforeUnloadHandler) => {
            if (type === 'beforeunload') beforeUnloadHandlerRef.current = handler;
        });
        const removeEventListener = vi.fn((type: string, handler: BeforeUnloadHandler) => {
            if (type === 'beforeunload' && beforeUnloadHandlerRef.current === handler) {
                beforeUnloadHandlerRef.current = null;
            }
        });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { addEventListener, removeEventListener },
        });

        try {
            promptUnsavedChangesAlertSpy.mockResolvedValue('discard');
            const screen = await renderDirtyInlineEditor();

            expect(addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
            const preventDefault = vi.fn();
            const event = { preventDefault, returnValue: undefined as string | undefined };
            beforeUnloadHandlerRef.current?.(event);
            expect(preventDefault).toHaveBeenCalledOnce();
            expect(event.returnValue).toBe('');

            const editForm = capturedEditFormProps;
            if (!editForm) throw new Error('Expected the inline Profile editor');
            await invokeAndFlush(editForm.onCancel);

            expect(hasInlineEditor(screen)).toBe(false);
            expect(removeEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
            expect(beforeUnloadHandlerRef.current).toBeNull();
        } finally {
            if (originalWindowDescriptor) {
                Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'window');
            }
        }
    });
});
