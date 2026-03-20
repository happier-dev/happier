import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let executionRunsEnabledState = false;
let guidanceEntriesState: any[] = [];
let guidanceEnabledState: boolean | null = null;
let guidanceMaxCharsState: number | null = null;
let providerSubagentSectionsState: any[] = [];
const routerPushSpy = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    Platform: {
        OS: 'web',
        select: (options: any) => (options && 'default' in options ? options.default : undefined),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => executionRunsEnabledState,
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

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        mono: () => ({}),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => {
        if (key === 'executionRunsGuidanceEnabled') return [guidanceEnabledState, vi.fn()];
        if (key === 'executionRunsGuidanceMaxChars') return [guidanceMaxCharsState, vi.fn()];
        if (key === 'executionRunsGuidanceEntries') return [guidanceEntriesState, vi.fn()];
        return [null, vi.fn()];
    },
    useSetting: () => ({
        v: 2,
        backends: [{
            id: 'custom-review',
            name: 'custom-review',
            title: 'Custom Review Bot',
            description: 'Custom ACP',
            command: 'custom-acp',
            args: [],
            env: {},
            transportProfile: 'generic',
            capabilities: {
                supportsLoadSession: false,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
            },
            createdAt: 1,
            updatedAt: 1,
        }],
    }),
}));

vi.mock('@/sync/domains/settings/executionRunsGuidance', () => ({
    buildExecutionRunsGuidanceBlock: () => ({ text: '' }),
    coerceExecutionRunsGuidanceEntries: (value: any) => value,
}));

vi.mock('@/agents/providers/registry/providerSubagentSettingsRegistry', () => ({
    listProviderSubagentSettingsSections: () => providerSubagentSectionsState,
}));

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
    getResolvedBackendCatalogEntries: () => [
        {
            target: { kind: 'configuredAcpBackend', backendId: 'custom-review' },
            targetKey: 'acpBackend:custom-review',
            family: 'configuredAcpBackend',
            builtInAgentId: null,
            iconAgentId: 'customAcp',
            title: 'Custom Review Bot',
            subtitle: 'Custom ACP',
        },
    ],
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        if (params && typeof params.value === 'string') return `${key}:${params.value}`;
        return key;
    },
}));

vi.mock('./guidance/showSubAgentGuidanceRuleEditorModal', () => ({
    showSubAgentGuidanceRuleEditorModal: vi.fn(async () => null),
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid-test',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: () => ({ displayNameKey: 'agent.name' }),
    isAgentId: () => false,
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude', 'customAcp'],
}));

describe('SubAgentSettingsView', () => {
    beforeEach(() => {
        executionRunsEnabledState = false;
        guidanceEnabledState = null;
        guidanceMaxCharsState = null;
        guidanceEntriesState = [];
        providerSubagentSectionsState = [];
        routerPushSpy.mockReset();
    });

    it('renders an execution-runs-disabled state when execution runs are not enabled', async () => {
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SubAgentSettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const enableItem = items.find((item: any) => item?.props?.title === 'subAgentGuidance.settings.disabled.enableExecutionRuns.title');
        expect(enableItem).toBeTruthy();
    });

    it('renders a Subagents status row and routes it to Features settings', async () => {
        executionRunsEnabledState = true;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SubAgentSettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const statusItem = items.find((item: any) => item?.props?.title === 'subAgentGuidance.settings.overview.happierStatusTitle');
        expect(statusItem).toBeTruthy();

        await act(async () => {
            statusItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/features');
    });

    it('renders related subagent settings links and routes to Session settings', async () => {
        executionRunsEnabledState = true;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SubAgentSettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const sessionItem = items.find((item: any) => item?.props?.title === 'subAgentGuidance.settings.related.sessionTitle');
        expect(sessionItem).toBeTruthy();

        await act(async () => {
            sessionItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/session');
    });

    it('routes the related custom ACP backends entry to the providers settings screen', async () => {
        executionRunsEnabledState = true;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SubAgentSettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const backendsItem = items.find((item: any) => item?.props?.title === 'subAgentGuidance.settings.related.backendsTitle');
        expect(backendsItem).toBeTruthy();

        await act(async () => {
            backendsItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/providers');
    });

    it('renders configured ACP backend titles in rule subtitles', async () => {
        executionRunsEnabledState = true;
        guidanceEnabledState = true;
        guidanceMaxCharsState = 4000;
        guidanceEntriesState = [{
            id: 'rule-1',
            description: 'Use the custom backend',
            enabled: true,
            suggestedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-review' },
        }];

        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SubAgentSettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const ruleItem = items.find((item: any) => item?.props?.title === 'Use the custom backend');
        expect(ruleItem).toBeTruthy();
        expect(ruleItem!.props.subtitle).toContain('Custom Review Bot');
    });

    it('renders provider-contributed subagent settings sections and routes to their target screen', async () => {
        providerSubagentSectionsState = [{
            providerId: 'claude',
            section: {
                id: 'claudeTeams',
                title: 'Claude teams',
                footer: 'Manage Claude-specific subagent behavior.',
                items: [{
                    id: 'claude-team-settings',
                    title: 'Agent Teams',
                    subtitle: 'Open Claude provider settings',
                    route: '/(app)/settings/providers/claude',
                    iconIonName: 'people-outline',
                }],
            },
        }];

        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SubAgentSettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const providerItem = items.find((item: any) => item?.props?.title === 'Agent Teams');
        expect(providerItem).toBeTruthy();

        await act(async () => {
            providerItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/providers/claude');
    });
});
