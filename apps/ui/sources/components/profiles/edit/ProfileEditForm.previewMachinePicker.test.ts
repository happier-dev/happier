import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { AIBackendProfile } from '@/sync/settings';
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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    Platform: {
        OS: 'ios',
        select: (spec: { ios?: unknown; default?: unknown }) => (spec && 'ios' in spec ? spec.ios : spec?.default),
    },
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    Pressable: 'Pressable',
    Linking: {},
    useWindowDimensions: () => ({ height: 800, width: 400 }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: capture.routerPush }),
    useLocalSearchParams: () => ({}),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { tint: '#000' },
                textSecondary: '#666',
                button: { secondary: { tint: '#000' }, primary: { background: '#00f' } },
                surface: '#fff',
                text: '#000',
                status: { connected: '#0f0', disconnected: '#f00' },
                input: { placeholder: '#999' },
            },
        },
        rt: { themeName: 'light' },
    }),
    StyleSheet: { create: () => ({}) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', () => ({
    Modal: {
        show: (...args: unknown[]) => capture.modalShow(...args),
        alert: vi.fn(),
    },
}));

vi.mock('@/sync/storage', () => ({
    useSetting: () => ({}),
    useAllMachines: () => [{ id: 'm1', metadata: { displayName: 'M1' } }],
    useMachine: () => null,
    useSettingMutable: (key: string) => {
        if (key === 'favoriteMachines') return [[], vi.fn()] as const;
        if (key === 'secrets') return [[], vi.fn()] as const;
        if (key === 'secretBindingsByProfileId') return [{}, vi.fn()] as const;
        return [[], vi.fn()] as const;
    },
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/hooks/useCLIDetection', () => ({
    useCLIDetection: () => ({ status: 'unknown' }),
}));

vi.mock('@/components/profiles/environmentVariables/EnvironmentVariablesList', () => ({
    EnvironmentVariablesList: () => null,
}));

vi.mock('@/components/SessionTypeSelector', () => ({
    SessionTypeSelector: () => null,
}));

vi.mock('@/components/ui/forms/OptionTiles', () => ({
    OptionTiles: () => null,
}));

vi.mock('@/agents/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/catalog', () => ({
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
    Item: (props: { title?: string; onPress?: () => void }) => {
        if (props?.title === 'profiles.previewMachine.itemTitle' && typeof props.onPress === 'function') {
            capture.previewMachinePress = props.onPress;
        }
        return null;
    },
}));

vi.mock('@/components/Switch', () => ({
    Switch: () => null,
}));

vi.mock('@/utils/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/sync/profileUtils', () => ({
    getBuiltInProfileDocumentation: () => null,
}));

vi.mock('@/sync/permissionTypes', () => ({
    normalizeProfileDefaultPermissionMode: <T,>(value: T) => value,
}));

vi.mock('@/sync/permissionModeOptions', () => ({
    getPermissionModeLabelForAgentType: () => '',
    getPermissionModeOptionsForAgentType: () => [],
    normalizePermissionModeForAgentType: <T,>(value: T) => value,
}));

vi.mock('@/components/layout', () => ({
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
        compatibility: { claude: true, codex: true, gemini: true },
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

        await act(async () => {
            renderer.create(
                React.createElement(ProfileEditForm, {
                    profile: buildProfile(),
                    machineId: null,
                    onSave: () => true,
                    onCancel: vi.fn(),
                }),
            );
        });

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
