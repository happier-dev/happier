import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { createNewSessionWizardTestProps, type NewSessionWizardTestProps } from './newSessionWizardTestFixtures';

installNewSessionComponentsCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();
const profile = AIBackendProfileSchema.parse({
    id: 'profile-1', name: 'Work', environmentVariables: [], envVarRequirements: [],
    compatibility: {}, compatibilityByTargetKey: {}, defaultPermissionModeByAgent: {},
    defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByAgent: {}, defaultPersistenceModeByTargetKey: {},
    isBuiltIn: false, createdAt: 1, updatedAt: 1, version: '1.0.0',
});

function buildProps() {
    const base = createNewSessionWizardTestProps();
    return { ...base, profiles: { ...base.profiles, useProfiles: true, profiles: [profile],
        selectedProfileId: profile.id, openProfileEnvVarsPreview: vi.fn() } };
}

async function renderWizard(props: NewSessionWizardTestProps = buildProps(), boundaryRef = { current: null }) {
    const { NewSessionWizard } = await import('./NewSessionWizard');
    const { AgentInput } = await import('@/components/sessions/agentInput');
    props.machine.serverId = runtime.serverId;
    const screen = await renderScreen(<runtime.Wrapper>
        <NewSessionWizard {...props} popoverBoundaryRef={boundaryRef} />
    </runtime.Wrapper>);
    const input: React.ComponentProps<typeof AgentInput> = screen.findByType<typeof AgentInput>(AgentInput).props;
    return { screen, input };
}

describe('NewSessionWizard real AgentInput composition', () => {
    it('uses host-constrained panel height and suppresses duplicate permission status', async () => {
        const { input } = await renderWizard();
        expect(input.panelMaxHeightMode).toBe('host-constrained');
        expect(input.showStatusPermissionMode).toBe(false);
    });

    it('owns the local popover boundary without creating another portal scope', async () => {
        const { PopoverBoundaryProvider, PopoverPortalTargetProvider } = await import('@/components/ui/popover');
        const boundaryRef = { current: null };
        const { screen } = await renderWizard(buildProps(), boundaryRef);
        expect(screen.findAllByType(PopoverPortalTargetProvider)).toHaveLength(0);
        const boundaries = screen.findAllByType(PopoverBoundaryProvider);
        expect(boundaries).toHaveLength(1);
        expect(boundaries[0].props.boundaryRef).toBe(boundaryRef);
    });

    it('preserves exact engine picker choices and the canonical picker action', async () => {
        const props = buildProps();
        const onAgentPickerSelect = vi.fn();
        props.agent = { ...props.agent,
            agentPickerOptions: [{ id: 'agent:claude', label: 'Claude' }, { id: 'agent:codex', label: 'Codex' }],
            agentPickerSelectedOptionId: 'agent:claude', onAgentPickerSelect };
        const { input } = await renderWizard(props);
        expect(input.agentPickerTitle).toBeUndefined();
        expect(input.agentPickerSelectedOptionId).toBe('agent:claude');
        expect(input.agentPickerOptions).toEqual(props.agent.agentPickerOptions);
        expect(input.onAgentPickerSelect).toBe(onAgentPickerSelect);
        expect(input.onAgentClick).toBeUndefined();
    });

    it('routes compact choices through canonical qualified Agent options without a carrier-id fallback', async () => {
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const props = buildProps();
        const selectPiImmediately = vi.fn();
        const onAgentPickerSelect = vi.fn();
        const setAgentType = vi.fn();
        props.sectionPresentation = { backends: 'dropdown' };
        props.agent = { ...props.agent, enabledAgentIds: ['gemini', 'pi'], agentType: 'gemini', agentLabel: 'Gemini', setAgentType,
            agentPickerOptions: [
                { id: 'agent:happier.agent.gemini/gemini', label: 'Gemini' },
                { id: 'agent:happier.agent.pi/pi', label: 'Pi', onSelectImmediate: selectPiImmediately },
            ], agentPickerSelectedOptionId: 'agent:happier.agent.gemini/gemini', onAgentPickerSelect };
        const { screen } = await renderWizard(props);
        const dropdown = screen.findAllByType(DropdownMenu).find((node) => (
            node.props.itemTrigger?.itemProps?.testID === 'new-session-agent-dropdown-trigger'
        ));
        expect(dropdown).toBeDefined();
        expect(dropdown?.props.items.map((item: { id: string; title: string }) => ({ id: item.id, title: item.title }))).toEqual([
            { id: 'agent:happier.agent.gemini/gemini', title: 'Gemini' },
            { id: 'agent:happier.agent.pi/pi', title: 'Pi' },
        ]);
        expect(dropdown?.props.selectedId).toBe('agent:happier.agent.gemini/gemini');
        await act(async () => { dropdown?.props.onSelect('agent:happier.agent.pi/pi'); });
        expect(selectPiImmediately).toHaveBeenCalledOnce();
        expect(onAgentPickerSelect).not.toHaveBeenCalled();
        expect(setAgentType).not.toHaveBeenCalled();
        await act(async () => { dropdown?.props.onSelect('agent:happier.agent.gemini/gemini'); });
        expect(onAgentPickerSelect).toHaveBeenCalledExactlyOnceWith('agent:happier.agent.gemini/gemini');
        onAgentPickerSelect.mockClear();
        await act(async () => { dropdown?.props.onSelect('unknown-agent'); });
        expect(onAgentPickerSelect).not.toHaveBeenCalled();
        expect(setAgentType).not.toHaveBeenCalled();
    });

    it('preserves the qualified current Agent and producer labels in expanded choices', async () => {
        const { Item } = await import('@/components/ui/lists/Item');
        const props = buildProps();
        const onAgentPickerSelect = vi.fn();
        const setAgentType = vi.fn();
        const installedAgentKey = 'agent:example.agent.pi/pi';
        props.sectionPresentation = { backends: 'list' };
        props.agent = { ...props.agent, enabledAgentIds: ['gemini', 'pi'], agentType: 'gemini', setAgentType,
            agentPickerOptions: [
                { id: 'agent:happier.agent.gemini/gemini', label: 'Gemini' },
                { id: installedAgentKey, label: 'Workspace Pi' },
            ], agentPickerSelectedOptionId: installedAgentKey, onAgentPickerSelect };
        const { screen } = await renderWizard(props);
        const agentRows = screen.findAllByType(Item).filter((node) => (
            node.props.testID?.startsWith('new-session-agent:')
        ));
        expect(agentRows.map((row) => ({ title: row.props.title, selected: row.props.selected }))).toEqual([
            { title: 'Gemini', selected: false },
            { title: 'Workspace Pi', selected: true },
        ]);
        const currentAgent = agentRows.find((row) => row.props.testID === `new-session-agent:${installedAgentKey}`);
        if (!currentAgent?.props.onPress) throw new Error('Expected the selected installed Agent row');
        await act(async () => { currentAgent.props.onPress?.(); });
        expect(onAgentPickerSelect).toHaveBeenCalledExactlyOnceWith(installedAgentKey);
        expect(setAgentType).not.toHaveBeenCalled();
    });

    it('renders the real profile list inside its popover and omits redundant environment chips', async () => {
        const { ProfilesList } = await import('@/components/profiles/ProfilesList');
        const boundaryRef = { current: null };
        const { input } = await renderWizard(buildProps(), boundaryRef);
        expect(input.profilePopover?.renderContent).toBeTypeOf('function');
        expect(input.onProfileClick).toBeUndefined();
        expect(input.envVarsCount).toBeUndefined();
        expect(input.envVarsPopover).toBeUndefined();
        expect(input.onEnvVarsClick).toBeUndefined();
        const renderContent = input.profilePopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected the real Profile content renderer');
        const content = renderContent({ maxHeight: 420, requestClose: () => {} });
        const popover = await renderScreen(<runtime.Wrapper>{content}</runtime.Wrapper>);
        expect(popover.findByType(ProfilesList).props.popoverBoundaryRef).toBe(boundaryRef);
    });

    it('uses machine, path and resume popovers without legacy chip actions', async () => {
        const props = buildProps();
        props.footer.machinePopover = { renderContent: () => null };
        props.footer.pathPopover = { renderContent: () => null };
        props.footer.resumePopover = { renderContent: () => null };
        props.footer.resumeSessionId = 'resume-1';
        const { input } = await renderWizard(props);
        expect(input.machinePopover?.renderContent).toBeTypeOf('function');
        expect(input.pathPopover?.renderContent).toBeTypeOf('function');
        expect(input.resumePopover?.renderContent).toBeTypeOf('function');
        expect(input.onMachineClick).toBeUndefined();
        expect(input.onPathClick).toBeUndefined();
        expect(input.onResumeClick).toBeUndefined();
    });

    it('preserves the committed Temporary-computer destination without requesting another machine', async () => {
        const props = buildProps();
        props.footer.machineName = 'newSession.temporaryComputer.destination.windows';
        props.machine.selectedMachine = null;
        const { input } = await renderWizard(props);
        expect(input.machineName).toBe('newSession.temporaryComputer.destination.windows');
    });

    it('exposes ACP configuration refresh through the real action-menu input', async () => {
        const props = buildProps();
        const refresh = vi.fn();
        props.agent.acpConfigOptionsProbe = { phase: 'idle', onRefresh: refresh };
        props.agent.acpConfigOptions = [{ id: 'speed', name: 'Speed', type: 'select', currentValue: 'standard',
            options: [{ value: 'standard', name: 'Standard' }, { value: 'fast', name: 'Fast' }] }];
        props.agent.setAcpConfigOptionOverride = vi.fn();
        const { input } = await renderWizard(props);
        expect(input.acpConfigOptionsOverrideProbe?.phase).toBe('idle');
        await act(async () => { input.acpConfigOptionsOverrideProbe?.onRefresh?.(); });
        expect(refresh).toHaveBeenCalledOnce();
    });

    it.each(['inline', 'popover'] as const)('renders the canonical environment preview from the %s profile browser', async (presentation) => {
        const { ProfilesList } = await import('@/components/profiles/ProfilesList');
        const { EnvironmentVariablesPreviewPanel } = await import('./EnvironmentVariablesPreviewPanel');
        const props = buildProps();
        const { screen, input } = await renderWizard(props);
        let browser = screen;
        if (presentation === 'popover') {
            const renderContent = input.profilePopover?.renderContent;
            if (typeof renderContent !== 'function') throw new Error('Expected the real Profile content renderer');
            browser = await renderScreen(<runtime.Wrapper>
                {renderContent({ maxHeight: 420, requestClose: () => {} })}
            </runtime.Wrapper>);
        }
        const list: React.ComponentProps<typeof ProfilesList> = browser.findByType<typeof ProfilesList>(ProfilesList).props;
        await act(async () => { list.onViewEnvironmentVariables?.(profile); });
        expect(props.profiles.openProfileEnvVarsPreview).not.toHaveBeenCalled();
        expect(browser.findByType(EnvironmentVariablesPreviewPanel).props.profileName).toBe('Work');
    });
});
