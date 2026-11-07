import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

import { WorkflowRunComposer } from './WorkflowRunComposer';

afterEach(standardCleanup);

it.each([
    { repeat: false, kind: 'session' as const, backgroundCount: 1, ownCount: 1 },
    { repeat: true, kind: 'session' as const, backgroundCount: 2, ownCount: 2 },
    { repeat: false, kind: 'detached_run' as const, backgroundCount: 1, ownCount: 1 },
    { repeat: true, kind: 'detached_run' as const, backgroundCount: 1, ownCount: 1 },
    { repeat: false, kind: 'session' as const, backgroundCount: 0, ownCount: 0 },
])('reviews the targets that admission accepts (repeat=$repeat, default=$kind, own=$ownCount)', async ({ repeat, kind, backgroundCount, ownCount }) => {
    const fixture = createWorkflowDefinitionFixture({ defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } });
    const step = fixture.blocks[0]!;
    if (step.kind !== 'step') throw new Error('invalid_step_fixture');
    const definition = createWorkflowDefinitionFixture({ ...fixture, blocks: [step,
        ...Array.from({ length: backgroundCount }, (_, index) => ({ ...step, id: `background-${index}`,
            execution: { executionTarget: { kind: 'detached_run' as const } } })),
        { kind: 'if', id: 'conditional', when: { kind: 'exists', value: { kind: 'literal', value: true } },
            then: [{ ...step, id: 'explicit-session', execution: { executionTarget: { kind: 'session' } } }], otherwise: [] },
    ] });
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition, admission: { kind: 'user' },
        effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind },
            workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    if (!accepted.ok) throw new Error(`fixture_materialization_failed:${accepted.error.code}`);
    expect(accepted.snapshot.materializedLeaves.map(leaf => leaf.executionTarget.kind))
        .toEqual([kind, ...Array.from({ length: backgroundCount }, () => 'detached_run'), 'session']);
    const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}}
        onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}}
        definition={repeat ? createWorkflowDefinitionFixture({ ...fixture, blocks: [step] }) : definition}
        executionTarget={{ kind }}
        {...(repeat ? { materializedLeaves: accepted.snapshot.materializedLeaves } : {})} />);
    const review = screen.findAllByType(Item).find(item => item.props.testID === 'workflow-run-inputs-review-target');
    const defaultLabel = kind === 'session' ? t('workflows.page.sections.aSession') : t('workflows.page.sections.aBackgroundRun');
    expect(review?.props.subtitle).toBe(ownCount === 0 ? defaultLabel
        : `${defaultLabel} · ${t('workflows.start.targetsOwn', { count: ownCount })}`);
    await screen.pressByTestIdAsync('workflow-run-inputs-targets-chip');
    if (backgroundCount > 0) expect(screen.getTextContent()).toContain(t('workflows.page.sections.aBackgroundRun'));
    expect(screen.getTextContent()).toContain(t('workflows.page.sections.aSession'));
});

it('names every accepted execution kind in the read-only targets chip', async () => {
    const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}}
        onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}}
        definition={createWorkflowDefinitionFixture()} materializedLeaves={[
            { sourceKey: '$root', blockId: 'build', kind: 'step', selection: {},
                authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } },
            { sourceKey: 'accepted-child', blockId: 'check', kind: 'step', selection: {},
                authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'detached_run' } },
        ]} />);
    const label = screen.findByTestId('workflow-run-inputs-targets-chip')?.props.accessibilityLabel;
    expect(label).toContain(t('workflows.start.targetsSessions'));
    expect(label).toContain(t('workflows.start.targetsBackground'));
});

it('keeps the admission status readable while Start is pending and cannot be submitted again', async () => {
    const onRun = vi.fn();
    const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}} pending
        onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
    expect(screen.findByTestId('workflow-run-inputs-starting')?.props.children).toBe(t('workflows.start.starting'));
    // The pressed Start keeps its own label, width and primary look under its spinner (DESIGN-16 D11);
    // the line beside it says it is starting.
    const start = screen.tree.root.findAll((node) => node.props?.testID === 'workflow-run-inputs-run' && node.props.title !== undefined)[0];
    expect(start?.props.title).toBe(t('workflows.start.start'));
    expect(start?.props.loading).toBe(true);
    expect(start?.props.disabled).toBe(false);
    await screen.pressByTestIdAsync('workflow-run-inputs-run');
    expect(onRun).not.toHaveBeenCalled();
});
