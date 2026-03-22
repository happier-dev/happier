import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                            Text: 'Text',
                            Pressable: 'Pressable',
                            ActivityIndicator: 'ActivityIndicator',
                            Platform: {
                                OS: 'web',
                                select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android,
                            },
                            AppState: {
                                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
                            },
                        }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            prompt: vi.fn(async () => null),
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#fff',
                textSecondary: '#999',
                surfacePressedOverlay: 'rgba(0,0,0,0.1)',
                surfaceSelected: 'rgba(255,255,255,0.1)',
                surfaceRipple: 'rgba(0,0,0,0.1)',
                surfaceHigh: '#222',
                surfaceHighest: '#333',
                divider: '#444',
                accent: { blue: '#00f', orange: '#f60', indigo: '#66f' },
                input: { placeholder: '#666' },
                groupped: {
                    background: '#111',
                    chevron: '#888',
                },
            },
        },
    });
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'claude',
    isAgentId: (value: unknown) => value === 'claude',
    getAgentCore: () => ({ displayNameKey: 'agents.claude.displayName' }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useAllMachines: () => [],
    useLocalSetting: () => 1,
}));

vi.mock('@/components/settings/pickers/agentDropdownItems', () => ({
    getAgentDropdownMenuItems: () => [
        {
            id: 'claude',
            title: 'Claude',
            subtitle: 'claude',
            icon: React.createElement('Ionicons', { name: 'sparkles-outline' }),
        },
    ],
}));

vi.mock('@/components/settings/pickers/modelDropdownItems', () => ({
    REFRESH_MODELS_DROPDOWN_ITEM_ID: '__refresh_models__',
    getModelDropdownMenuItems: () => [],
}));

vi.mock('@/components/settings/pickers/resolvePreferredMachineId', () => ({
    resolvePreferredMachineId: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: unknown) => promise,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSetting: (key: string) =>
        key === 'acpCatalogSettingsV1'
            ? {
                  v: 2,
                  backends: [
                      {
                          id: 'custom-backend',
                          name: 'custom-backend',
                        title: 'Custom Backend',
                        command: 'custom-backend',
                        args: [],
                        env: {},
                        transportProfile: { kind: 'stdio' },
                        capabilities: {},
                          createdAt: 1,
                          updatedAt: 1,
                      },
                  ],
              }
            : [],
});
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

const preflightModelArgs: any[] = [];
vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: (args: any) => {
        preflightModelArgs.push(args);
        return {
            modelOptions: [],
            probe: { phase: 'idle', refresh: vi.fn() },
        };
    },
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: ({ children }: any) => (typeof children === 'function' ? children({ maxHeight: 320, maxWidth: 320 }) : children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('LlmTaskRunnerConfigV1BackendModelPicker', () => {
    it('probes models against the selected configured ACP backend target', async () => {
        preflightModelArgs.length = 0;
        const { LlmTaskRunnerConfigV1BackendModelPicker } = await import('./LlmTaskRunnerConfigV1BackendModelPicker');

        await renderScreen(<LlmTaskRunnerConfigV1BackendModelPicker
                    value={{ v: 1, backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' }, modelId: 'default', permissionMode: 'no_tools' } as any}
                    onChange={() => {}}
                />);

        expect(preflightModelArgs[0]?.backendTarget).toEqual({ kind: 'configuredAcpBackend', backendId: 'custom-backend' });
    });

    it('does not emit raw period text nodes under non-Text parents on web', async () => {
        const { LlmTaskRunnerConfigV1BackendModelPicker } = await import('./LlmTaskRunnerConfigV1BackendModelPicker');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<LlmTaskRunnerConfigV1BackendModelPicker
                    value={{ v: 1, backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: 'default', permissionMode: 'no_tools' } as any}
                    onChange={() => {}}
                />)).tree;

        const json = tree!.toJSON();
        const badNodes: Array<{ parent: string | null; value: string }> = [];

        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parentType !== 'Text' && node.trim().length > 0) {
                    badNodes.push({ parent: parentType, value: node });
                }
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : null;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(json, null);

        expect(badNodes).toEqual([]);
    });
});
