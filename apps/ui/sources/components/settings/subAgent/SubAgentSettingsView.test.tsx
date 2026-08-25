import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let executionRunsEnabledState = false;
let guidanceEntriesState: any[] = [];
let guidanceEnabledState: boolean | null = null;
let guidanceMaxCharsState: number | null = null;
let pluginProjectionByIdState: Record<string, any> = {};
const routerPushSpy = vi.fn();

installSettingsViewCommonModuleMocks({
    icons: () => ({
        Ionicons: 'Ionicons',
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: any) => (options && 'default' in options ? options.default : undefined),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: routerPushSpy },
        });
        return routerMock.module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
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
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => {
                if (params && typeof params.value === 'string') {
                    return `${key}: ${params.value}`;
                }
                return key;
            },
        });
    },
});

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

vi.mock('@/constants/Typography', () => ({
    Typography: {
        mono: () => ({}),
    },
}));

vi.mock('@/sync/domains/settings/executionRunsGuidance', () => ({
    buildExecutionRunsGuidanceBlock: () => ({ text: '' }),
    coerceExecutionRunsGuidanceEntries: (value: any) => value,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        inputs: { pluginProjectionById: pluginProjectionByIdState },
    }),
}));

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
    getResolvedBackendCatalogEntries: () => [
        {
            backendTarget: { kind: 'backend', backendId: 'custom-review', configuredBackendId: 'custom-review' },
            backendTargetKey: 'backend:custom-review:configured:custom-review',
            kind: 'configuredBackend',
            backendId: 'custom-review',
            providerId: 'custom-review',
            catalogAgentId: null,
            builtInAgentId: null,
            iconAgentId: 'customAcp',
            title: 'Custom Review Bot',
            subtitle: 'Custom ACP',
        },
    ],
}));

vi.mock('./guidance/showSubAgentGuidanceRuleEditorModal', () => ({
    showSubAgentGuidanceRuleEditorModal: vi.fn(async () => null),
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid-test',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'customAcp'],
    DEFAULT_AGENT_ID: 'customAcp',
    getAgentCore: () => ({ displayNameKey: 'agent.name' }),
    isBundledAgentId: () => false,
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
        pluginProjectionByIdState = {};
        routerPushSpy.mockReset();
    });

    it('renders an execution-runs-disabled state when execution runs are not enabled', async () => {
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        const enableItem = screen.findRowByTitle('subAgentGuidance.settings.disabled.enableExecutionRuns.title');
        expect(enableItem).toBeTruthy();
    });

    it('renders a Subagents status row and routes it to Features settings', async () => {
        executionRunsEnabledState = true;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        const statusItem = screen.findRowByTitle('subAgentGuidance.settings.overview.happierStatusTitle');
        expect(statusItem).toBeTruthy();

        screen.pressRowByTitle('subAgentGuidance.settings.overview.happierStatusTitle');

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/features');
    });

    it('renders related subagent settings links and routes to Session settings', async () => {
        executionRunsEnabledState = true;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        const sessionItem = screen.findRowByTitle('subAgentGuidance.settings.related.sessionTitle');
        expect(sessionItem).toBeTruthy();

        screen.pressRowByTitle('subAgentGuidance.settings.related.sessionTitle');

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/session');
    });

    it('routes the related custom ACP backends entry to the providers settings screen', async () => {
        executionRunsEnabledState = true;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        const backendsItem = screen.findRowByTitle('subAgentGuidance.settings.related.backendsTitle');
        expect(backendsItem).toBeTruthy();

        screen.pressRowByTitle('subAgentGuidance.settings.related.backendsTitle');

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/agents');
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

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        const ruleItem = screen.findRowByTitle('Use the custom backend');
        expect(ruleItem).toBeTruthy();
        expect(ruleItem!.props.subtitle).toContain('subAgentGuidance.settings.rules.meta.target: Custom Review Bot');
    });

    it('keeps colliding external Agent local ids qualified when routing to their settings', async () => {
        pluginProjectionByIdState = {
            'example.agent-one': {
                editableSettingsGroups: [{
                    target: {
                        kind: 'agent',
                        agent: { pluginId: 'example.agent-one', localId: 'assistant' },
                    },
                    presentation: {
                        subagentSections: [{
                            id: 'agentOneTeams',
                            title: 'Agent One teams',
                            description: 'Manage Agent One subagent behavior.',
                            items: [{
                                id: 'agent-one-team-settings',
                                title: 'Agent One settings',
                                description: 'Open Agent One settings',
                                iconIonName: 'people-outline',
                            }],
                        }],
                    },
                }],
            },
            'example.agent-two': {
                editableSettingsGroups: [{
                    target: {
                        kind: 'agent',
                        agent: { pluginId: 'example.agent-two', localId: 'assistant' },
                    },
                    presentation: {
                        subagentSections: [{
                            id: 'agentTwoTeams',
                            title: 'Agent Two teams',
                            description: 'Manage Agent Two subagent behavior.',
                            items: [{
                                id: 'agent-two-team-settings',
                                title: 'Agent Two settings',
                                description: 'Open Agent Two settings',
                                iconIonName: 'people-outline',
                            }],
                        }],
                    },
                }],
            },
        };

        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        expect(screen.findRowByTitle('Agent One settings')).toBeTruthy();
        expect(screen.findRowByTitle('Agent Two settings')).toBeTruthy();

        screen.pressRowByTitle('Agent One settings');
        screen.pressRowByTitle('Agent Two settings');

        expect(routerPushSpy).toHaveBeenNthCalledWith(
            1,
            '/(app)/settings/agents/assistant?pluginId=example.agent-one',
        );
        expect(routerPushSpy).toHaveBeenNthCalledWith(
            2,
            '/(app)/settings/agents/assistant?pluginId=example.agent-two',
        );
    });
});
