import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { normalizePluginWorkflowContributionV1 } from '@happier-dev/protocol/workflows';
import { resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { WorkflowRunComposer, type WorkflowRunComposerProps } from './WorkflowRunComposer';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function mount(values: WorkflowRunComposerProps['values'] = {}) {
    return renderScreen(<WorkflowRunComposer inputs={[{ name: 'release', valueType: 'string', required: true }]}
        values={values} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
}

describe('workflow composer accessibility', () => {
    let restorePopoverGlobals: () => void;
    beforeEach(() => {
        restorePopoverGlobals = withPopoverWebGlobals();
    });
    afterEach(async () => {
        await standardCleanup();
        restorePopoverGlobals();
    });
    it('renders a contributed Workflow’s declared input title, placeholder and choice label', async () => {
        const { definition } = normalizePluginWorkflowContributionV1({
            id: 'publish',
            title: 'Publish',
            definition: {
                ...createWorkflowDefinitionFixture({
                    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                }),
                inputs: [
                    { name: 'message', valueType: 'string', required: true,
                        presentation: { title: 'Release message', placeholder: 'Describe this release' } },
                    { name: 'mode', valueType: 'string', required: true, enum: ['dry-run', 'publish'],
                        presentation: { optionLabels: { 'dry-run': 'Preview only' } } },
                ],
            },
        }, 'com.example.releases');
        const screen = await renderScreen(<WorkflowRunComposer inputs={definition.inputs}
            values={{ mode: 'dry-run' }} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        const input = screen.findByTestId('new-session-composer-input');
        expect(input?.props.accessibilityLabel).toBe('Release message');
        expect(input?.props.placeholder).toBe('Describe this release');
        await screen.pressByTestIdAsync('workflow-run-inputs-inputs-chip');
        expect(screen.getTextContent()).toContain('Preview only');
    });
    it.each([false, true])('focuses a defaulted caller input once when ready (initially blocked: %s)', async (initiallyBlocked) => {
        const focus = vi.fn();
        const props: WorkflowRunComposerProps = {
            inputs: [{ name: 'qa_note', valueType: 'string', required: false, default: 'Ready note' }],
            values: {}, onChangeValues: () => {}, onRun: () => {}, onCancel: () => {},
        };
        // Physical input focus is the platform boundary; AgentInput and the focus registry stay real.
        const screen = await renderScreen(<WorkflowRunComposer {...props} autoFocusComposer startDisabled={initiallyBlocked} />, {
            createNodeMock: element => element.type === 'TextInput' || element.type === 'textarea' || element.type === 'HappierComposerInput'
                ? { focus, blur: vi.fn(), setNativeProps: vi.fn(), setTextAndSelection: vi.fn(), setSelection: vi.fn() } : null,
        });
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Ready note');
        expect(focus).toHaveBeenCalledTimes(initiallyBlocked ? 0 : 1);
        await screen.update(<WorkflowRunComposer {...props} autoFocusComposer />);
        expect(focus).toHaveBeenCalledTimes(1);
        await screen.update(<WorkflowRunComposer {...props} autoFocusComposer pending />);
        await screen.update(<WorkflowRunComposer {...props} autoFocusComposer values={{ qa_note: 'Edited' }} />);
        expect(focus).toHaveBeenCalledTimes(1);
    });
    it('keeps admission status in the footer while Start stays with the composer', async () => {
        const props: WorkflowRunComposerProps = { inputs: [], values: {}, onChangeValues: () => {}, onRun: () => {}, onCancel: () => {} };
        const screen = await renderScreen(<WorkflowRunComposer {...props} />);
        expect(screen.findByTestId('workflow-run-inputs-status')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-preview')?.findAllByProps({ testID: 'workflow-run-inputs-run' }).length).toBeGreaterThan(0);
        await screen.update(<WorkflowRunComposer {...props} pending reconciling />);
        expect(screen.findByTestId('workflow-run-inputs-status')?.findAllByProps({ testID: 'workflow-run-inputs-reconciling' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('workflow-run-inputs-footer')?.findAllByProps({ testID: 'workflow-run-inputs-run' })).toHaveLength(0);
    });
    it('shows a status badge handed to it in the composer\'s own status row', async () => {
        const props: WorkflowRunComposerProps = { inputs: [], values: {}, onChangeValues: () => {}, onRun: () => {}, onCancel: () => {} };
        const screen = await renderScreen(<WorkflowRunComposer {...props}
            statusBadges={[{ key: 'managed-machine-progress', label: 'Installing Happier on mac-vm-2', testID: 'managed-machine-progress-badge',
                accessibilityLabel: 'Installing Happier on mac-vm-2', tone: 'neutral' }]} />);
        expect(screen.findByTestId('managed-machine-progress-badge')).not.toBeNull();
        await screen.update(<WorkflowRunComposer {...props} />);
        expect(screen.findByTestId('managed-machine-progress-badge')).toBeNull();
    });
    it('associates the required repair with the actual main input without an untouched alert', async () => {
        const screen = await mount();
        // 07 §3: untouched fields never show errors. The readiness footnote names
        // what is missing quietly; it is not an alert before any interaction.
        const reason = screen.findByTestId('workflow-run-inputs-reason');
        expect(reason?.props.accessibilityRole).toBeUndefined();
        expect(screen.findByTestId('workflow-run-inputs-reason-text')?.props.children).toBe('workflows.start.addToStart');
        expect(screen.findByTestId('new-session-composer-input')?.props.accessibilityHint).toBeTruthy();
    });
    it('names a built-in input by its presentation, never by its raw key', async () => {
        const { definition } = resolveBuiltinWorkflowDefinitionV1('plan-with-a-panel')!;
        const screen = await renderScreen(<WorkflowRunComposer inputs={definition.inputs}
            values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        const input = screen.findByTestId('new-session-composer-input');
        expect(input?.props.placeholder).toBe('What should the panel plan?');
        expect(input?.props.accessibilityLabel).toBe('Request');
    });
    it('names Review changes’ After the review choices by their labels and says a default only where the field cannot show it (M3, P3)', async () => {
        const { definition } = resolveBuiltinWorkflowDefinitionV1('review-and-converge')!;
        const then = definition.inputs.find(input => input.name === 'then')!;
        const screen = await renderScreen(<WorkflowRunComposer
            inputs={[then, { name: 'limit', valueType: 'number', required: false, default: 3 }]}
            values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        await screen.pressByTestIdAsync('workflow-run-inputs-inputs-chip');
        const text = screen.getTextContent();
        expect(text).toContain('After the review');
        // The control shows its selected default by its label, never the raw value.
        expect(text).toContain('Report findings');
        expect(text).not.toMatch(/\breport\b/);
        // The choice shows its default selected; only the number field, which can't, says its default.
        expect(text.split('workflows.start.defaultValue').length - 1).toBe(1);
    });
    it('closes through its presenter rather than a separate Cancel row', async () => {
        const screen = await mount();
        expect(screen.findByTestId('workflow-run-inputs-cancel')).toBeNull();
    });
    it('explains a disabled Start on the action itself', async () => {
        const screen = await mount();
        const start = screen.findByTestId('workflow-run-inputs-run');
        expect(start?.props.disabled).toBe(true);
        expect(start?.props.accessibilityHint).toBeTruthy();
    });
    it('removes the refusal from the input and Start once the value is repaired', async () => {
        const screen = await mount({ release: '1.2.0' });
        expect(screen.findByTestId('new-session-composer-input')?.props.accessibilityHint).toBeUndefined();
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.accessibilityHint).toBeUndefined();
        expect(screen.findByTestId('workflow-run-inputs-reason')).toBeNull();
    });
    it('puts what Start needs directly under the composer, before the facts about the Run (FIN-DESIGN-ACCEPT-10 P6)', async () => {
        const screen = await renderScreen(<WorkflowRunComposer inputs={[{ name: 'release', valueType: 'string', required: true }]}
            values={{}} includesUnsavedEdits onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        const order = screen.findByTestId('workflow-run-inputs-status')!.findAll((node) => typeof node.type === 'string'
            && (node.props.testID === 'workflow-run-inputs-reason' || node.props.testID === 'workflow-run-inputs-unsaved'))
            .map((node) => node.props.testID as string);
        expect(order).toEqual(['workflow-run-inputs-reason', 'workflow-run-inputs-unsaved']);
    });
    it('says a missing Request once, in the readiness row, not again on the Inputs chip (FIN-DESIGN-ACCEPT-9 X3)', async () => {
        const screen = await renderScreen(<WorkflowRunComposer inputs={[{ name: 'release', valueType: 'string', required: true },
            { name: 'notes', valueType: 'number', required: false }]}
            values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        expect(screen.findByTestId('workflow-run-inputs-reason-text')?.props.children).toBe('workflows.start.addToStart');
        expect(screen.findByTestId('workflow-run-inputs-inputs-chip')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('workflows.start.neededNamed');
    });
    it('keeps a structured input it cannot present off the form, unless Start needs it (FIN-DESIGN-ACCEPT-9 X2)', async () => {
        const onRun = vi.fn();
        const reviewers = [{ kind: 'engine', engineId: 'claude' }];
        const screen = await renderScreen(<WorkflowRunComposer
            inputs={[{ name: 'reviewers', valueType: 'json', required: true, default: reviewers },
                { name: 'steps', valueType: 'json', required: false }]}
            values={{}} onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        // Neither is asked; the required one starts with its declared default.
        expect(screen.findByTestId('workflow-run-inputs-inputs-chip')).toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun.mock.lastCall?.[0]).toEqual({ reviewers });
        // Required with no default: shown, so the form says what Start needs.
        const needed = await renderScreen(<WorkflowRunComposer inputs={[{ name: 'reviewers', valueType: 'json', required: true }]}
            values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        expect(needed.findByTestId('workflow-run-inputs-inputs-chip')).not.toBeNull();
        expect(needed.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
    });
});
