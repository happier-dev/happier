import { describe, expect, it, vi } from 'vitest';

import { buildAgentInputActionMenuActions } from './actionMenuActions';
import type { AgentInputPlacementDescriptor, AgentInputResolvedControlLines } from './controls/agentInputControlTypes';
import { buildAgentInputPlacementDescriptors } from './controls/buildAgentInputPlacementDescriptors';
import { getAgentInputResetStartPlacement, getLinkedFilesActionChipPlacement } from './definitions/agentInputActionChipPlacements';
import { createSessionAccessActionChip } from './definitions/createSessionAccessActionChip';
import { createAutomationEditorActionChip } from './definitions/createAutomationEditorActionChip';
import { createWorkflowRunActionChip } from './sessionActions/createWorkflowRunActionChip';
import { buildCollapsedExtraControlActions } from './controls/buildCollapsedExtraControlActions';
import type { AgentInputExtraActionChip } from './agentInputContracts';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/components/ui/theme/haptics', () => ({ hapticsLight: vi.fn() }));

const resolved = (collapsed: readonly string[]): AgentInputResolvedControlLines => ({
    primary: [], secondary: [], collapsed, accessories: [], hidden: [], controls: [], effectivePlacements: {},
});
const base = {
    tint: '#fff', agentId: 'codex', agentLabel: 'Codex', profileLabel: null, profileIcon: 'user-circle', dismiss: () => {}, blurInput: () => {},
} as const;
const action = (id: string) => ({ id, label: id, icon: null, onPress: () => {} });

describe('buildAgentInputActionMenuActions', () => {
    it('identifies effective add operations as a first section without restoring Shown or Hidden operations', () => {
        const menu = buildAgentInputActionMenuActions({
            ...base, resolvedControls: resolved(['permission', 'linkedFiles', 'path', 'attachments']),
            permissionLabel: 'Ask', onPermissionClick: () => {}, currentPath: '/project', onPathClick: () => {}, onRemoveFolder: () => {},
            extraControlActions: { linkedFiles: action('link'), attachments: action('attach') },
        });
        expect(menu).toMatchObject([
            { id: 'link', section: 'add' }, { id: 'attach', section: 'add' },
            { id: 'permission', section: 'controls' }, { id: 'path', section: 'controls' },
            { id: 'path-remove', section: 'controls' },
        ]);
        const moved = buildAgentInputActionMenuActions({
            ...base, resolvedControls: resolved(['permission']), permissionLabel: 'Ask', onPermissionClick: () => {},
            extraControlActions: { linkedFiles: action('link'), attachments: action('attach') },
        });
        expect(moved).toMatchObject([{ id: 'permission', section: 'controls' }]);
        expect(moved).toHaveLength(1);
    });

    it('uses the Files glyph rather than a branch glyph in the file viewer action', () => {
        const [files] = buildAgentInputActionMenuActions({
            ...base, resolvedControls: resolved(['files']), sessionId: 'session', onFileViewerPress: () => {},
        });
        expect(files).toMatchObject({ icon: { props: { name: 'files' } } });
    });

    it('fills missing menu glyphs, detail disclosure and description from admitted catalog metadata without replacing live values or switches', () => {
        const resetPlacement = getAgentInputResetStartPlacement();
        const chips: AgentInputExtraActionChip[] = [
            createSessionAccessActionChip({ label: 'Private', accessibilityLabel: 'Session access', onOpen: () => {}, popoverContent: null }),
            createAutomationEditorActionChip({ label: 'Automate', onPress: () => {} }),
            { key: 'reset', controlId: 'delivery', placement: resetPlacement, render: () => null,
                collapsedContentPopover: { title: resetPlacement.title, renderContent: () => null } },
            { key: 'issue', controlId: 'plugin:fixture/issue', placement: { id: 'plugin:fixture/issue', title: 'Issue' }, render: () => null,
                collapsedContentPopover: { title: 'Issue', header: { title: 'Issue', description: 'Link an issue · plugin' }, renderContent: () => null } },
        ];
        const controls = buildAgentInputPlacementDescriptors({ coreControls: [{ id: 'permission' }, { id: 'engine' }], chips });
        const menu = buildAgentInputActionMenuActions({
            ...base, resolvedControls: { ...resolved(chips.map(chip => chip.placement!.id)), controls },
            extraControlActions: buildCollapsedExtraControlActions({ chips, tint: base.tint, dismiss: base.dismiss, blurInput: base.blurInput, openCollapsedOptionsPopover: () => {} }),
        });
        expect(menu[0]).toMatchObject({ label: 'session.access.title', subtitle: 'Private', icon: { props: { name: 'users' } }, right: { props: { name: 'caret-right' } } });
        expect(menu[1]).toMatchObject({ label: 'Automate', icon: { props: { name: 'lightning' } }, right: null });
        expect(menu[2]).toMatchObject({ subtitle: 'usage.board.plans.resetStartMeta', icon: { props: { name: 'clock' } } });
        expect(menu[3]).toMatchObject({ subtitle: 'Link an issue · plugin', right: { props: { name: 'caret-right' } } });
        const switchRight = 'existing switch';
        const withAuthoredValue = buildAgentInputActionMenuActions({
            ...base, resolvedControls: { ...resolved([resetPlacement.id]), controls },
            extraControlActions: { [resetPlacement.id]: { id: 'reset', label: 'Tomorrow', subtitle: 'Waiting for allowance', right: switchRight, onPress: () => {} } },
        });
        expect(withAuthoredValue[0]).toMatchObject({ subtitle: 'Tomorrow · Waiting for allowance', right: switchRight });
        const coreMenu = buildAgentInputActionMenuActions({
            ...base, resolvedControls: { ...resolved(['permission', 'engine']), controls },
            permissionLabel: 'Ask', onPermissionClick: () => {}, engineLabel: 'Current model',
        });
        expect(coreMenu[0]).toMatchObject({ subtitle: 'Ask', right: { props: { name: 'caret-right' } } });
        expect(coreMenu[1]).toMatchObject({ disabled: true, right: null });
    });

    it('names the Run a pattern row once, without its chip label as a second line', () => {
        const chip = createWorkflowRunActionChip({ label: 'Run…', title: 'Run a pattern', testID: 'run-pattern', renderContent: () => null });
        const controls = buildAgentInputPlacementDescriptors({ coreControls: [], chips: [chip] });
        const [row] = buildAgentInputActionMenuActions({
            ...base, resolvedControls: { ...resolved([chip.placement!.id]), controls },
            extraControlActions: buildCollapsedExtraControlActions({ chips: [chip], tint: base.tint, dismiss: base.dismiss, blurInput: base.blurInput, openCollapsedOptionsPopover: () => {} }),
        });
        expect(row).toMatchObject({ label: 'Run a pattern', right: { props: { name: 'caret-right' } } });
        expect(row?.subtitle).toBeUndefined();
    });

    it('shows stable control names with current values and preserves supplementary operations and switch props', () => {
        const descriptor = (id: 'permission' | 'engine' | 'path' | 'providerOption:approval', title: string): AgentInputPlacementDescriptor => ({
            id, title, controlId: id === 'providerOption:approval' ? 'providerOption' : id,
            line: 'primary', slot: 'chip', defaultPlacement: 'overflow', pending: false,
        });
        const onPermissionClick = vi.fn();
        const toggle = 'switch fixture';
        const menu = buildAgentInputActionMenuActions({
            ...base,
            resolvedControls: {
                ...resolved(['permission', 'engine', 'path', 'providerOption:approval']),
                controls: [descriptor('permission', 'Permissions'), descriptor('engine', 'Model'),
                    descriptor('path', 'Folder'), descriptor('providerOption:approval', 'Approval')],
            },
            permissionLabel: 'Ask before edits', onPermissionClick,
            engineLabel: 'Current model', currentPath: '/workspace/project', onPathClick: () => {}, onRemoveFolder: () => {},
            extraControlActions: { 'providerOption:approval': {
                id: 'approval', label: 'Enabled', subtitle: 'Unavailable offline', disabled: true,
                right: toggle, rightElementOutsidePressable: true,
            } },
        });
        expect(menu.map(({ id, label, subtitle }) => ({ id, label, subtitle }))).toEqual([
            { id: 'permission', label: 'Permissions', subtitle: 'Ask before edits' },
            { id: 'agent', label: 'Model', subtitle: 'Current model' },
            { id: 'path', label: 'Folder', subtitle: '/workspace/project' },
            { id: 'path-remove', label: 'newSession.folder.removeFolder', subtitle: undefined },
            { id: 'approval', label: 'Approval', subtitle: 'Enabled · Unavailable offline' },
        ]);
        expect(menu[1].disabled).toBe(true);
        expect(menu[4]).toMatchObject({ disabled: true, right: toggle, rightElementOutsidePressable: true });
        menu[0].onPress?.();
        expect(onPermissionClick).toHaveBeenCalledOnce();
    });

    it('does not repeat an operation name as its own current value or replace its authored subtitle', () => {
        const menu = buildAgentInputActionMenuActions({
            ...base,
            resolvedControls: { ...resolved(['attachments']), controls: [{
                id: 'attachments', controlId: 'attachments', title: 'Attach files', line: 'primary',
                slot: 'chip', defaultPlacement: 'overflow', pending: false,
            }] },
            extraControlActions: { attachments: { id: 'attach', label: 'Attach files', subtitle: 'Files and images' } },
        });
        expect(menu[0]).toMatchObject({ label: 'Attach files', subtitle: 'Files and images' });
    });

    it('drops a chip label that only restates the row name and keeps just the value after a repeated name', () => {
        const descriptor = (id: AgentInputPlacementDescriptor['controlId'], title: string): AgentInputPlacementDescriptor => ({
            id, title, controlId: id, line: 'primary', slot: 'chip', defaultPlacement: 'overflow', pending: false,
        });
        const menu = buildAgentInputActionMenuActions({
            ...base,
            resolvedControls: {
                ...resolved(['recipient', 'profile', 'goal']),
                controls: [descriptor('recipient', 'Send to'), descriptor('profile', 'Runs through'), descriptor('goal', 'Goal')],
            },
            extraControlActions: {
                recipient: { id: 'send-to', label: 'To', onPress: () => {} },
                profile: { id: 'runs-through', label: 'Runs through ChatGPT · Happier', onPress: () => {} },
                goal: { id: 'goal', label: 'Ship the relay fix', onPress: () => {} },
            },
        });
        expect(menu.map(({ label, subtitle }) => ({ label, subtitle }))).toEqual([
            { label: 'Send to', subtitle: undefined },
            { label: 'Runs through', subtitle: 'ChatGPT · Happier' },
            { label: 'Goal', subtitle: 'Ship the relay fix' },
        ]);
    });

    it('keeps the catalogued Link a file add operation plain even though it owns a picker', () => {
        const placement = getLinkedFilesActionChipPlacement();
        const controls = buildAgentInputPlacementDescriptors({ coreControls: [], chips: [{
            key: 'link', controlId: 'linkedFiles', placement, render: () => null,
            collapsedContentPopover: { title: placement.title, renderContent: () => null },
        }] });
        const menu = buildAgentInputActionMenuActions({
            ...base, resolvedControls: { ...resolved(['linkedFiles']), controls },
            extraControlActions: { linkedFiles: { id: 'link', label: placement.title, onPress: () => {} } },
        });
        expect(menu[0]).toMatchObject({ label: placement.title, right: null });
        expect(menu[0].subtitle).toBeUndefined();
    });

    it('keeps an available engine value readable in overflow when no editing callback is admitted', () => {
        const actions = buildAgentInputActionMenuActions({
            ...base, resolvedControls: resolved(['engine']), engineLabel: 'Current model',
        });
        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({ id: 'agent', label: 'Current model', disabled: true });
        expect(actions[0].onPress).toBeUndefined();
    });

    it('preserves current model, mode, environment and file interactions in effective overflow', () => {
        const onAgentClick = vi.fn();
        const onSessionModeClick = vi.fn();
        const onEnvVarsClick = vi.fn();
        const onFileViewerPress = vi.fn();
        const actions = buildAgentInputActionMenuActions({
            ...base, resolvedControls: resolved(['engine', 'mode', 'env', 'files']),
            engineLabel: 'Configured model', sessionModeLabel: 'Build', envVarsCount: 2, sessionId: 'session-1',
            onAgentClick, onSessionModeClick, onEnvVarsClick, onFileViewerPress,
        });
        expect(actions.map((item) => item.id)).toEqual(['agent', 'mode', 'env-vars', 'files']);
        expect(actions[0].label).toBe('Configured model');
        expect(actions[1].label).toBe('Build');
        actions.forEach((item) => item.onPress?.());
        expect(onAgentClick).toHaveBeenCalledOnce();
        expect(onSessionModeClick).toHaveBeenCalledOnce();
        expect(onEnvVarsClick).toHaveBeenCalledOnce();
        expect(onFileViewerPress).toHaveBeenCalledOnce();
    });

    it('renders effective overflow in saved order, grouping effective add actions first', () => {
        const actions = buildAgentInputActionMenuActions({
            ...base,
            resolvedControls: resolved(['delivery:second', 'resume', 'attachments', 'linkedFiles', 'delivery:first']),
            onResumeClick: () => {},
            extraControlActions: {
                'delivery:first': action('first'), 'delivery:second': action('second'),
                attachments: action('attach'), linkedFiles: action('link'),
                'plugin:action:acme/hidden': action('hidden'),
            },
        });
        expect(actions.map((item) => item.id)).toEqual(['attach', 'link', 'second', 'resume', 'first']);
    });

    it('keeps machine and folder labels and removal on their existing menu path', () => {
        const remove = vi.fn();
        const actions = buildAgentInputActionMenuActions({
            ...base, resolvedControls: resolved(['machine', 'path']),
            onMachineClick: () => {}, onPathClick: () => {}, currentPath: '/repo', onRemoveFolder: remove,
        });
        expect(actions.map((item) => item.id)).toEqual(['machine', 'path', 'path-remove']);
        expect(actions[0].label).toBe('newSession.selectMachineTitle');
        expect(actions[1].label).toBe('/repo');
        actions[2].onPress?.();
        expect(remove).toHaveBeenCalledOnce();
    });

    it('opens Permissions through its current callback', () => {
        const onPermissionClick = vi.fn();
        const dismiss = vi.fn();
        const actions = buildAgentInputActionMenuActions({
            ...base, resolvedControls: resolved(['permission']), permissionLabel: 'Approval mode', onPermissionClick, dismiss,
        });
        expect(actions.map((item) => item.id)).toEqual(['permission']);
        expect(actions[0].label).toBe('Approval mode');
        actions[0].onPress?.();
        expect(dismiss).toHaveBeenCalledOnce();
        expect(onPermissionClick).toHaveBeenCalledOnce();
    });
});
