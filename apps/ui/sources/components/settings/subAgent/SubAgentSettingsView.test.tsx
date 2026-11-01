import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let executionRunsEnabledState = false;
let notifyParentOnCompletionState: boolean | null = null;
let pluginProjectionByIdState: Record<string, any> = {};
const routerPushSpy = vi.fn();
const notifyParentOnCompletionSetter = vi.fn();
const modalConfirm = vi.fn(async () => false);

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
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm: modalConfirm as any } }).module;
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
                if (key === 'executionRunsNotifyParentOnCompletionDefault') return [notifyParentOnCompletionState, notifyParentOnCompletionSetter];
                return [null, vi.fn()];
            },
            useSetting: () => ({
                v: 2,
                backends: [{
                    id: 'custom-review',
                    name: 'custom-review',
                    title: 'Custom Review Bot',
                    description: 'Custom ACP',
                    launch: { kind: 'command' as const, command: 'custom-acp', args: [] },
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





vi.mock('@/constants/Typography', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/constants/Typography')>(),
    Typography: new Proxy({}, { get: () => () => ({}) }),
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

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        preflightModels: null,
        modelOptions: [],
        probe: { phase: 'idle', refreshedAt: null, refresh: () => {} },
    }),
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

// Load the real owner after boundaries during collection, outside behavior deadlines.
await import('./SubAgentSettingsView');

describe('SubAgentSettingsView', () => {
    beforeEach(() => {
        executionRunsEnabledState = false;
        notifyParentOnCompletionState = null;
        pluginProjectionByIdState = {};
        routerPushSpy.mockReset();
        notifyParentOnCompletionSetter.mockReset();
        modalConfirm.mockReset();
        modalConfirm.mockImplementation(async () => false);
    });

    it('leads to Features from the off state', async () => {
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        screen.pressRowByTitle('subAgentGuidance.settings.disabled.enableExecutionRuns.title');

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/features');
    });

    it('updates the canonical parent-completion notification setting', async () => {
        executionRunsEnabledState = true;
        notifyParentOnCompletionState = false;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        screen.pressRowByTitle('subAgentGuidance.settings.notifyParentOnCompletion.title');

        expect(notifyParentOnCompletionSetter).toHaveBeenCalledWith(true);
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

    it('routes the related Agents entry to the Agents collection', async () => {
        executionRunsEnabledState = true;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        screen.pressRowByTitle('subAgentGuidance.settings.related.agentsTitle');

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/agents');
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
