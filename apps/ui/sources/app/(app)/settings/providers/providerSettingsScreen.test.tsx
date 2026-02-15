import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async () => ({
    supported: true,
    response: { ok: true, result: { plan: null } },
}));

vi.mock('react-native', () => ({
    View: 'View',
    TextInput: 'TextInput',
    Platform: {
        OS: 'ios',
        select: (v: any) => (v && typeof v === 'object' ? (v.ios ?? v.default) : v),
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#999',
                textDestructive: '#f00',
                input: { placeholder: '#999' },
            },
        },
    }),
    StyleSheet: {
        create: (v: any) => v,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ providerId: 'codex' }),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: ({ trigger }: any) => React.createElement('DropdownMenu', null, trigger({ open: false, toggle: () => undefined })),
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: vi.fn(),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettings: () => ({ backendEnabledById: {} }),
    useAllMachines: () => ([{ id: 'm1', metadata: { name: 'My Machine', host: 'm1' } }]),
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({
        available: { codex: false },
        login: { codex: null },
        tmux: null,
        isDetecting: false,
        timestamp: 1,
    }),
}));

vi.mock('@/sync/ops', async (importOriginal) => {
    const actual: any = await importOriginal();
    return { ...actual, machineCapabilitiesInvoke: machineCapabilitiesInvokeMock };
});

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        isAgentId: (v: any) => v === 'codex',
        getAgentCore: () => ({
            displayNameKey: 'Codex',
            subtitleKey: 'subtitle',
            availability: { experimental: false },
            resume: { supportsVendorResume: false, experimental: false, runtimeGate: null },
            sessionModes: { kind: 'none' },
            model: {
                supportsSelection: true,
                supportsFreeform: true,
                defaultMode: 'default',
                allowedModes: ['default'],
                dynamicProbe: 'static-only',
                nonAcpApplyScope: 'spawn_only',
                acpApplyBehavior: 'set_model',
                acpModelConfigOptionId: null,
            },
            cli: {
                detectKey: 'codex',
                installBanner: { installKind: 'installer', installCommand: null, guideUrl: null },
            },
            connectedService: { name: 'cloud' },
            localControl: { supported: false },
            ui: { agentPickerIconName: 'code-slash' },
        }),
    };
});

vi.mock('@/agents/providers/_registry/providerSettingsRegistry', () => ({
    getProviderSettingsPlugin: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual: any = await importOriginal();
    return { ...actual, getAgentAdvancedModeCapabilities: () => ({ supportsRuntimeModeSwitch: false }) };
});

vi.mock('@/components/settings/providers/ProviderCliInstallItem', () => ({
    ProviderCliInstallItem: (props: any) => React.createElement('ProviderCliInstallItem', props),
}));

describe('ProviderSettingsScreen', () => {
    it('surfaces provider CLI install via capability installer item', async () => {
        const Screen = (await import('./[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const installer = tree!.root.findByType('ProviderCliInstallItem' as any);
        expect(installer.props.machineId).toBe('m1');
        expect(installer.props.capabilityId).toBe('cli.codex');
        expect(installer.props.installed).toBe(false);
        expect(installer.props.installability).toMatchObject({ kind: 'installable' });
    });
});
