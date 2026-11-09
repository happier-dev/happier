import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let executionRunsEnabledState = false;
let guidanceEntriesState: any[] = [];
let guidanceEnabledState: boolean | null = null;
let guidanceMaxCharsState: number | null = null;
let notifyParentOnCompletionState: boolean | null = null;
let providerSubagentSectionsState: any[] = [];
let roleProfilesState: any = null;
const roleProfilesSetter = vi.fn();
const roleProfileEditor = vi.hoisted(() => ({ result: null as any, calls: [] as any[] }));
const routerPushSpy = vi.fn();
const notifyParentOnCompletionSetter = vi.fn();

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
            storage: {
                getState: () => ({ settings: { sessionRoleProfilesV1: roleProfilesState } }),
            },
            useSettingMutable: (key: string) => {
                if (key === 'executionRunsGuidanceEnabled') return [guidanceEnabledState, vi.fn()];
                if (key === 'executionRunsGuidanceMaxChars') return [guidanceMaxCharsState, vi.fn()];
                if (key === 'executionRunsGuidanceEntries') return [guidanceEntriesState, vi.fn()];
                if (key === 'executionRunsNotifyParentOnCompletionDefault') return [notifyParentOnCompletionState, notifyParentOnCompletionSetter];
                if (key === 'sessionRoleProfilesV1') return [roleProfilesState, roleProfilesSetter];
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
    ItemGroup: ({ children, ...props }: any) => React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/constants/Typography', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/constants/Typography')>(),
    Typography: new Proxy({}, { get: () => () => ({}) }),
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

vi.mock('./guidance/showSubAgentGuidanceRuleEditorModal', () => ({
    showSubAgentGuidanceRuleEditorModal: vi.fn(async () => null),
}));

// The editor modal is a separate presentation boundary with its own test.
vi.mock('./roleProfiles/showSessionRoleProfileEditorModal', () => ({
    showSessionRoleProfileEditorModal: vi.fn(async (params: any) => {
        roleProfileEditor.calls.push(params);
        return roleProfileEditor.result;
    }),
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => '123e4567-e89b-12d3-a456-426614174000',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'customAcp'],
    DEFAULT_AGENT_ID: 'customAcp',
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
        notifyParentOnCompletionState = null;
        guidanceEntriesState = [];
        providerSubagentSectionsState = [];
        routerPushSpy.mockReset();
        notifyParentOnCompletionSetter.mockReset();
        roleProfilesState = null;
        roleProfilesSetter.mockReset();
        roleProfileEditor.result = null;
        roleProfileEditor.calls = [];
    });

    it('edits and resets account-wide role profiles, independently of execution-run guidance', async () => {
        const { DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1 } = await import('@happier-dev/protocol');
        roleProfilesState = { v: 1, instructionsByRole: { planner: 'Custom planner rules.' }, colorsByRole: { worker: '#123456' }, futureTop: true };
        const { VisibleSubagentsSettingsView } = await import('./VisibleSubagentsSettingsView');
        const screen = await renderSettingsView(React.createElement(VisibleSubagentsSettingsView));
        const press = async (title: string) => {
            const row = screen.findRowByTitle(title);
            if (!row) throw new Error(`missing row ${title}`);
            await React.act(async () => { await row.props.onPress?.(); });
        };

        roleProfileEditor.result = { kind: 'save', displayName: 'Quality Gate', instructions: 'Review against the plan.' };
        await press('sessionRole.reviewer');
        expect(roleProfileEditor.calls[0]).toMatchObject({ role: 'reviewer', instructions: DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.reviewer, isCustom: false });
        expect(roleProfilesSetter).toHaveBeenLastCalledWith({
            v: 1,
            instructionsByRole: { planner: 'Custom planner rules.', reviewer: 'Review against the plan.' },
            colorsByRole: { worker: '#123456' },
            displayNamesByRole: { reviewer: 'Quality Gate' },
            futureTop: true,
        });

        roleProfileEditor.result = { kind: 'reset' };
        await press('sessionRole.planner');
        expect(roleProfileEditor.calls[1]).toMatchObject({ role: 'planner', instructions: 'Custom planner rules.', isCustom: true });
        expect(roleProfilesSetter).toHaveBeenLastCalledWith({ v: 1, instructionsByRole: {}, colorsByRole: { worker: '#123456' }, futureTop: true });
    });

    it('adds, edits, and confirms removal of custom role profiles without touching existing assignments', async () => {
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        const customId = 'custom:223e4567-e89b-12d3-a456-426614174000';
        roleProfilesState = {
            v: 1,
            instructionsByRole: { reviewer: 'Keep.' },
            customRoles: [{ id: customId, name: 'Architect', instructions: 'Design.', color: '#123456', future: true }],
            futureTop: true,
        };
        const { VisibleSubagentsSettingsView } = await import('./VisibleSubagentsSettingsView');
        const screen = await renderSettingsView(React.createElement(VisibleSubagentsSettingsView));

        roleProfileEditor.result = { kind: 'save', name: 'System Architect', instructions: 'Design safely.', color: '#abcdef' };
        await React.act(async () => { await screen.findRowByTitle('Architect')?.props.onPress?.(); });
        expect(roleProfilesSetter).toHaveBeenLastCalledWith(expect.objectContaining({
            customRoles: [{ id: customId, name: 'System Architect', instructions: 'Design safely.', color: '#abcdef', future: true }],
            futureTop: true,
        }));

        roleProfileEditor.result = { kind: 'delete' };
        await React.act(async () => { await screen.findRowByTitle('Architect')?.props.onPress?.(); });
        expect(Modal.confirm).toHaveBeenCalledWith(
            'sessionRole.profiles.deleteTitle',
            'sessionRole.profiles.deleteExistingSessionsUnchanged',
            expect.objectContaining({ destructive: true }),
        );
        expect(roleProfilesSetter).toHaveBeenLastCalledWith(expect.objectContaining({ customRoles: [], futureTop: true }));

        roleProfileEditor.result = { kind: 'save', name: 'Researcher', instructions: 'Research.', color: '#654321' };
        await React.act(async () => { await screen.findRowByTitle('sessionRole.profiles.addCustom')?.props.onPress?.(); });
        expect(roleProfilesSetter).toHaveBeenLastCalledWith(expect.objectContaining({
            customRoles: expect.arrayContaining([expect.objectContaining({
                id: 'custom:123e4567-e89b-12d3-a456-426614174000',
                name: 'Researcher',
                instructions: 'Research.',
                color: '#654321',
            })]),
        }));
    });

    it('orders the seeded Repo Admin, built-ins, additional custom roles, and Add by stable identity', async () => {
        const { SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1 } = await import('@happier-dev/protocol');
        roleProfilesState = {
            v: 1,
            instructionsByRole: {},
            customRoles: [
                { id: 'custom:223e4567-e89b-12d3-a456-426614174000', name: 'Architect', instructions: 'Design.', color: '#123456' },
                SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1,
            ],
        };
        const { VisibleSubagentsSettingsView } = await import('./VisibleSubagentsSettingsView');
        const screen = await renderSettingsView(React.createElement(VisibleSubagentsSettingsView));

        const titlesById = new Map(screen.listRows('session-role-profile-').map((row) => [
            row.props.testID as string,
            row.props.title as string,
        ]));
        expect([...titlesById.values()]).toEqual([
            'Repo Admin',
            'sessionRole.projectLead',
            'sessionRole.planner',
            'sessionRole.worker',
            'sessionRole.reviewer',
            'Architect',
            'sessionRole.profiles.addCustom',
        ]);
    });

    it('rebases a pending custom edit on the latest synced catalog and never resurrects a concurrently deleted identity', async () => {
        const customId = 'custom:223e4567-e89b-12d3-a456-426614174000';
        const concurrentId = 'custom:323e4567-e89b-12d3-a456-426614174000';
        const original = { id: customId, name: 'Architect', instructions: 'Design.', color: '#123456' };
        const concurrent = { id: concurrentId, name: 'Researcher', instructions: 'Research.', color: '#654321' };
        roleProfilesState = { v: 1, instructionsByRole: {}, customRoles: [original], retainedTop: true };
        let settleEditor!: (value: unknown) => void;
        roleProfileEditor.result = new Promise((resolve) => { settleEditor = resolve; });
        const { VisibleSubagentsSettingsView } = await import('./VisibleSubagentsSettingsView');
        const screen = await renderSettingsView(React.createElement(VisibleSubagentsSettingsView));

        const pending = screen.findRowByTitle('Architect')?.props.onPress?.();
        roleProfilesState = { v: 1, instructionsByRole: { reviewer: 'Concurrent.' }, customRoles: [original, concurrent], retainedTop: true };
        settleEditor({ kind: 'save', name: 'System Architect', instructions: 'Design safely.', color: '#abcdef' });
        await React.act(async () => { await pending; });
        expect(roleProfilesSetter).toHaveBeenLastCalledWith(expect.objectContaining({
            instructionsByRole: { reviewer: 'Concurrent.' },
            customRoles: [
                expect.objectContaining({ id: customId, name: 'System Architect' }),
                concurrent,
            ],
            retainedTop: true,
        }));

        roleProfilesSetter.mockClear();
        roleProfilesState = { v: 1, instructionsByRole: {}, customRoles: [original, concurrent] };
        roleProfileEditor.result = new Promise((resolve) => { settleEditor = resolve; });
        const deletionPending = screen.findRowByTitle('Architect')?.props.onPress?.();
        roleProfilesState = { v: 1, instructionsByRole: {}, customRoles: [concurrent] };
        settleEditor({ kind: 'save', name: 'Resurrected', instructions: 'Wrong.', color: '#abcdef' });
        await React.act(async () => { await deletionPending; });
        expect(roleProfilesSetter).not.toHaveBeenCalled();
    });

    it('keeps the Subagents page in pre-local order without the separate Visible subagents entry or moved groups', async () => {
        executionRunsEnabledState = true;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');
        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        const groupTitles = screen.findAllByType('ItemGroup' as never).map((group) => group.props.title ?? null);

        expect(screen.findRowByTitle('visibleAgents.pageTitle')).toBeFalsy();
        expect(groupTitles.slice(0, 2)).toEqual([
            'subAgentGuidance.settings.overview.groupTitle',
            'subAgentGuidance.settings.related.groupTitle',
        ]);
        expect(groupTitles).toContain('subAgentGuidance.settings.overview.groupTitle');
        expect(groupTitles).toContain('subAgentGuidance.settings.related.groupTitle');
        expect(groupTitles).toContain('subAgentGuidance.settings.groupTitle');
        expect(groupTitles).not.toContain('sessionRole.profiles.groupTitle');
        expect(groupTitles).not.toContain('visibleAgents.groupTitle');

    });

    it('renders role profiles and visible-team controls without legacy run visibility defaults', async () => {
        const { VisibleSubagentsSettingsView } = await import('./VisibleSubagentsSettingsView');
        const screen = await renderSettingsView(React.createElement(VisibleSubagentsSettingsView));
        const groupTitles = screen.findAllByType('ItemGroup' as never).map((group) => group.props.title).filter(Boolean);
        expect(groupTitles[0]).toBe('visibleAgents.overview.title');
        expect(groupTitles).toContain('sessionRole.profiles.groupTitle');
        expect(groupTitles).toContain('visibleAgents.teamGroupTitle');
        expect(groupTitles).not.toContain('subAgentGuidance.settings.groupTitle');
        expect(groupTitles).not.toContain('visibleAgents.groupTitle');
        expect(screen.findRowByTitle('visibleAgents.intent.review')).toBeFalsy();
        expect(screen.findRowByTitle('visibleAgents.intent.plan')).toBeFalsy();
        expect(screen.findRowByTitle('visibleAgents.intent.delegate')).toBeFalsy();
        expect(screen.findRowByTitle('subAgentGuidance.settings.groupTitle')).toBeTruthy();
        screen.pressRowByTitle('subAgentGuidance.settings.groupTitle');
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/sub-agent');
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

    it('updates the canonical parent-completion notification setting', async () => {
        executionRunsEnabledState = true;
        notifyParentOnCompletionState = false;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        screen.pressRowByTitle('subAgentGuidance.settings.notifyParentOnCompletion.title');

        expect(notifyParentOnCompletionSetter).toHaveBeenCalledWith(true);
    });

    it('explains that disabling Happier run instructions removes routing and mechanics', async () => {
        executionRunsEnabledState = true;
        guidanceEnabledState = true;
        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        const guidanceItem = screen.findRowByTitle('subAgentGuidance.settings.enableInjection.title');

        expect(guidanceItem?.props.subtitle).toBe('subAgentGuidance.settings.enableInjection.subtitle');
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

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/providers');
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
                    route: '/settings/providers/claude',
                    iconIonName: 'people-outline',
                }],
            },
        }];

        const { SubAgentSettingsView } = await import('./SubAgentSettingsView');

        const screen = await renderSettingsView(React.createElement(SubAgentSettingsView));
        const providerItem = screen.findRowByTitle('Agent Teams');
        expect(providerItem).toBeTruthy();

        screen.pressRowByTitle('Agent Teams');

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/providers/claude');
    });
});
