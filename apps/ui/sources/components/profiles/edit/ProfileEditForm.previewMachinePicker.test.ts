import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { ProfileEditForm } from './ProfileEditForm';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    routerPush: vi.fn(),
    modalShow: vi.fn(),
    previewMachinePress: null as null | (() => void),
    reset() {
        this.routerPush.mockReset();
        this.modalShow.mockReset();
        this.previewMachinePress = null;
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: 'ios',
                select: (spec: { ios?: unknown; default?: unknown }) => (spec && 'ios' in spec ? spec.ios : spec?.default),
            },
            View: 'View',
            Text: 'Text',
            TextInput: 'TextInput',
            Pressable: 'Pressable',
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            useWindowDimensions: () => ({ height: 800, width: 400 }),
        },
    );
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { push: capture.routerPush },
        params: {},
    });
    return expoRouterMock.module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: (...args: unknown[]) => capture.modalShow(...args),
            alert: vi.fn(),
        },
    }).module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
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
    });
});

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({ status: 'unknown' }),
}));

vi.mock('@/components/profiles/environmentVariables/EnvironmentVariablesList', () => ({
    EnvironmentVariablesList: () => null,
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: () => ({ permissions: { modeGroup: 'default' } }),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, onPress }: { title?: string; onPress?: () => void }) => {
        if (title === 'profiles.previewMachine.itemTitle' && typeof onPress === 'function') {
            capture.previewMachinePress = onPress;
        }
        return null;
    },
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: () => null,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/sync/domains/profiles/profileUtils', () => ({
    getBuiltInProfileDocumentation: () => null,
}));

vi.mock('@/sync/domains/permissions/permissionTypes', () => ({
    normalizeProfileDefaultPermissionMode: <T,>(value: T) => value,
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeLabelForAgentType: () => '',
    getPermissionModeOptionsForAgentType: () => [],
    normalizePermissionModeForAgentType: <T,>(value: T) => value,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 900 },
}));

vi.mock('@/utils/profiles/envVarTemplate', () => ({
    parseEnvVarTemplate: () => ({ variables: [] }),
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => null,
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

        expect(capture.modalShow).not.toHaveBeenCalled();
        expect(capture.routerPush).toHaveBeenCalledTimes(1);
        expect(capture.routerPush).toHaveBeenCalledWith({
            pathname: '/new/pick/preview-machine',
            params: {},
        });
    });
});
