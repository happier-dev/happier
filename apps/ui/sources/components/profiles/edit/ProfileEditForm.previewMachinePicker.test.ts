import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import {
    installProfileEditFormModuleMocks,
    profileEditFormTestState,
} from './profileEditFormTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    previewMachinePress: null as null | (() => void),
    reset() {
        this.previewMachinePress = null;
    },
}));

installProfileEditFormModuleMocks({
    reactNative: () =>
        createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (spec: { ios?: unknown; default?: unknown }) =>
                    spec && 'ios' in spec ? spec.ios : spec?.default,
            },
            View: 'View',
            Text: 'Text',
            TextInput: 'TextInput',
            Pressable: 'Pressable',
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            useWindowDimensions: () => ({ height: 800, width: 400 }),
        }),
    storageModule: () =>
        createStorageModuleStub({
            useSetting: () => ({}),
            useSettings: () => ({}),
            useAllMachines: () => [{ id: 'm1', metadata: { displayName: 'M1' } }],
            useMachine: () => null,
            useSettingMutable: (key: string) => {
                if (key === 'favoriteMachines') return [[], vi.fn()] as const;
                if (key === 'secrets') return [[], vi.fn()] as const;
                if (key === 'secretBindingsByProfileId') return [{}, vi.fn()] as const;
                return [[], vi.fn()] as const;
            },
        }),
});

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: () => ({ permissions: { modeGroup: 'default' } }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, onPress }: { title?: string; onPress?: () => void }) => {
        if (title === 'profiles.previewMachine.itemTitle' && typeof onPress === 'function') {
            capture.previewMachinePress = onPress;
        }
        return null;
    },
}));

function buildProfile(): AIBackendProfile {
    return {
        id: 'p1',
        name: 'P',
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: { claude: true, codex: true, gemini: true },
        compatibilityByTargetKey: {
            'agent:claude': true,
            'agent:codex': true,
            'agent:gemini': true,
        },
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    };
}

describe('ProfileEditForm (native preview machine picker)', () => {
    it('opens a picker screen instead of a modal overlay on native', async () => {
        capture.reset();
        profileEditFormTestState.routerPushSpy.mockReset();
        profileEditFormTestState.modalShowSpy.mockReset();
        profileEditFormTestState.modalAlertSpy.mockReset();

        const { ProfileEditForm } = await import('./ProfileEditForm');

        await renderScreen(React.createElement(ProfileEditForm, {
            profile: buildProfile(),
            machineId: null,
            onSave: () => true,
            onCancel: vi.fn(),
        }));

        expect(capture.previewMachinePress).toBeTruthy();

        await act(async () => {
            capture.previewMachinePress?.();
        });

        expect(profileEditFormTestState.modalShowSpy).not.toHaveBeenCalled();
        expect(profileEditFormTestState.routerPushSpy).toHaveBeenCalledTimes(1);
        expect(profileEditFormTestState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new/pick/preview-machine',
            params: {},
        });
    });
});
