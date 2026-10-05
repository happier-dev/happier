import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AgentInputChipPickerPopover } from '@/components/sessions/agentInput/components/AgentInputChipPickerPopover';
import * as inspector from './WorkflowStepInspector';
import * as controls from './workflowStepFieldControls';
import * as draftModule from '@/sync/domains/workflows/workflowEditorDraft';
import * as edits from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

/**
 * The inspector can now edit a step's Session-authoring values, not only show
 * whether they are inherited.
 *
 * Its own contract is unchanged: it still owns inherited/override state and the
 * reset to the workflow default, and an override equal to the current default
 * stays explicitly an override.
 */

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));
vi.mock('@/components/ui/popover/Popover', () => ({
    Popover: (props: { open: boolean; children: (render: unknown) => React.ReactNode }) =>
        (props.open ? React.createElement(React.Fragment, null, props.children({})) : null),
}));

afterEach(async () => {
    await standardCleanup();
});

const AGENT_TARGET = {
    kind: 'agent' as const,
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

async function loadHarness() {
    return { ...inspector, ...controls, ...draftModule, ...edits };
}

type Harness = Awaited<ReturnType<typeof loadHarness>>;

function buildDraft(harness: Harness) {
    return harness.setWorkflowDefaultField(
        harness.createWorkflowEditorDraft({ draftId: 'draft-1', name: 'Review' }),
        'agentTarget',
        AGENT_TARGET,
    );
}

function InspectorHarness(props: Readonly<{
    harness: Harness;
    fields: readonly string[];
    onChangeField: (field: string, value: unknown) => void;
    onResetField?: (field: string) => void;
    onChangeTimeout?: (timeoutMs: number | undefined) => void;
    draft: ReturnType<typeof buildDraft>;
}>): React.ReactElement {
    const renderFieldControl = props.harness.useWorkflowStepFieldControlRenderer();
    const step = props.draft.blocks[0] as never;
    return React.createElement(props.harness.WorkflowStepInspector, {
        draft: props.draft,
        step,
        fields: props.fields as never,
        renderFieldControl,
        onResetField: props.onResetField ?? (() => {}),
        onChangeField: props.onChangeField as never,
        onChangeTimeout: props.onChangeTimeout ?? (() => {}),
    });
}

describe('workflow step inspector field controls', () => {
    it('presents an authored engine once and resets its whole arm to the workflow default', async () => {
        const draft = draftModule.createWorkflowEditorDraft({ draftId: 'engine', name: 'Review' });
        const step = draft.blocks[0]!;
        if (step.kind !== 'step') throw new Error('Invalid step fixture');
        const reset = vi.fn();
        const screen = await renderScreen(<inspector.WorkflowStepInspector draft={draft}
            step={{ ...step, execution: { engine: { role: 'reviewer' } } }}
            renderFieldControl={params => React.createElement('Control', { field: params.field })}
            onChangeFields={() => {}} onChangeEngine={() => {}} onResetEngine={reset}
            onResetField={() => {}} onChangeField={() => {}} />);
        expect(screen.root.findAllByType('Control').filter(node => ['agentTarget', 'modelSelection', 'acpSessionModeId', 'sessionConfigOptionOverrides'].includes(node.props.field))).toHaveLength(1);
        expect(screen.findByTestId('workflow-inspector-agentTarget-state')?.props.children).toBe('workflows.a11y.overridden');
        await screen.pressByTestIdAsync('workflow-inspector-agentTarget-reset');
        expect(reset).toHaveBeenCalledOnce();
    });
    it('supplies a real editable control for a field the Agent can offer', async () => {
        const harness = await loadHarness();
        const onChangeField = vi.fn();
        const screen = await renderScreen(
            <InspectorHarness
                harness={harness}
                fields={['permissionMode']}
                draft={buildDraft(harness)}
                onChangeField={onChangeField}
            />,
        );

        // The inherited/override state and the value control live together.
        expect(screen.findByTestId('workflow-inspector-permissionMode-state')).toBeTruthy();
        const chip = screen.findByTestId('workflow-inspector-control-permissionMode');
        expect(chip).toBeTruthy();

        await act(async () => { screen.pressByTestId('workflow-inspector-control-permissionMode'); });
        const picker = screen.root.findAllByType(AgentInputChipPickerPopover).find(node => node.props.open)!;
        await act(async () => { picker.props.onSelect('yolo'); });

        expect(onChangeField).toHaveBeenCalledWith('permissionMode', 'yolo');
        await screen.unmount();
    });

    it('keeps an override equal to the current default explicitly an override', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness);
        const stepId = draft.blocks[0]!.id;
        // Same value as the workflow default, authored on the step.
        const withExplicitOverride = harness.setWorkflowStepExecutionField(
            harness.setWorkflowDefaultField(draft, 'permissionMode', 'plan'),
            stepId,
            'permissionMode',
            'plan',
        );

        const screen = await renderScreen(
            <InspectorHarness
                harness={harness}
                fields={['permissionMode']}
                draft={withExplicitOverride}
                onChangeField={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('workflows.a11y.overridden');
        expect(screen.getTextContent()).not.toContain('workflows.a11y.inherited');
        // Reset is the only way back to inheriting; choosing the same value is not.
        expect(screen.findByTestId('workflow-inspector-permissionMode-reset')).toBeTruthy();
        await screen.unmount();
    });

    it('renders a field whose host contributed no option source as unavailable rather than omitting it', async () => {
        const harness = await loadHarness();
        const screen = await renderScreen(
            <InspectorHarness
                harness={harness}
                fields={['connectedServices']}
                draft={buildDraft(harness)}
                onChangeField={() => {}}
            />,
        );

        expect(screen.findByTestId('workflow-inspector-connectedServices-state')).toBeTruthy();
        expect(
            screen.findByTestId('workflow-inspector-control-connectedServices-unavailable'),
        ).toBeTruthy();
        await screen.unmount();
    });

    /**
     * A field row names the field the way its own picker names it. Printing the
     * schema id told a reader nothing they could act on, and it was the only
     * place in the editor where raw contract vocabulary reached the surface.
     */
    it('names each field with its canonical control title rather than its schema id', async () => {
        const harness = await loadHarness();
        const screen = await renderScreen(
            <InspectorHarness
                harness={harness}
                fields={['permissionMode', 'connectedServices', 'terminal', 'runtimeDescriptorV1']}
                draft={buildDraft(harness)}
                onChangeField={() => {}}
            />,
        );

        expect(screen.findByTestId('workflow-inspector-permissionMode')?.props.children)
            .toBe('settingsSession.permissions.title');
        expect(screen.findByTestId('workflow-inspector-connectedServices')?.props.children)
            .toBe('connectedServices.authChip.label');
        expect(screen.findByTestId('workflow-inspector-terminal')?.props.children)
            .toBe('profiles.tmux.spawnSessionsTitle');
        expect(screen.findByTestId('workflow-inspector-runtimeDescriptorV1')?.props.children)
            .toBe('workflows.editor.agentRuntime');
        expect(screen.getTextContent()).not.toContain('runtimeDescriptorV1');
        await screen.unmount();
    });

    /**
     * UX-28: a step's result-wait deadline is the exact value the author types,
     * in the unit the field states; an empty field is omission, which the
     * coordinator reads as "no authored deadline". No default, floor or ceiling
     * is invented by the editor, and text that is not a whole number stays
     * visible as an unresolved value rather than being coerced or dropped.
     */
    it('authors an explicit result-wait timeout and treats an empty field as no deadline', async () => {
        const harness = await loadHarness();
        const onChangeTimeout = vi.fn();
        const screen = await renderScreen(
            <InspectorHarness
                harness={harness}
                fields={[]}
                draft={buildDraft(harness)}
                onChangeField={() => {}}
                onChangeTimeout={onChangeTimeout}
            />,
        );

        // Omitted: the field says what omission means and no value is authored.
        expect(screen.findByTestId('workflow-inspector-timeout-omitted')).toBeTruthy();
        expect(screen.findByTestId('workflow-inspector-timeout-error')).toBeNull();

        await act(async () => { screen.changeTextByTestId('workflow-inspector-timeout', '90000'); });
        expect(onChangeTimeout).toHaveBeenLastCalledWith(90_000);

        await act(async () => { screen.changeTextByTestId('workflow-inspector-timeout', '1.5'); });
        expect(onChangeTimeout).toHaveBeenLastCalledWith(1.5);
        await act(async () => { screen.changeTextByTestId('workflow-inspector-timeout', '1x'); });
        expect(Number.isNaN(onChangeTimeout.mock.lastCall?.[0])).toBe(true);
        await act(async () => { screen.changeTextByTestId('workflow-inspector-timeout', '0'); });
        expect(onChangeTimeout).toHaveBeenLastCalledWith(0);

        await act(async () => { screen.changeTextByTestId('workflow-inspector-timeout', '  '); });
        expect(onChangeTimeout).toHaveBeenLastCalledWith(undefined);
        await screen.unmount();
    });

    it('shows an authored timeout exactly and states the repair for an unresolved one', async () => {
        const harness = await loadHarness();
        const draft = buildDraft(harness);
        const stepId = draft.blocks[0]!.id;
        const authored = harness.setWorkflowStepTimeout(draft, stepId, 120_000);
        const screen = await renderScreen(
            <InspectorHarness harness={harness} fields={[]} draft={authored} onChangeField={() => {}} />,
        );
        expect(screen.findByTestId('workflow-inspector-timeout')?.props.value).toBe('120000');
        expect(screen.findByTestId('workflow-inspector-timeout-omitted')).toBeNull();
        expect(screen.findByTestId('workflow-inspector-timeout-error')).toBeNull();
        await screen.unmount();

        const unresolved = harness.setWorkflowStepTimeout(draft, stepId, Number.NaN);
        const repair = await renderScreen(
            <InspectorHarness harness={harness} fields={[]} draft={unresolved} onChangeField={() => {}} />,
        );
        const error = repair.findByTestId('workflow-inspector-timeout-error');
        expect(error).toBeTruthy();
        expect(error?.props.accessibilityRole).toBe('alert');
        expect(repair.findByTestId('workflow-inspector-timeout')?.props.accessibilityHint)
            .toBe('workflows.editor.wholeNumberRequired');
        await repair.unmount();
    });
});
