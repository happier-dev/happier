import * as React from 'react';
import { afterEach, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { t } from '@/text';

import { WorkflowRunComposer } from './WorkflowRunComposer';

afterEach(standardCleanup);

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
    expect(label).toContain(t('workflows.page.sections.aSession'));
    expect(label).toContain(t('workflows.page.sections.aBackgroundRun'));
});

it('keeps the admission status readable while Start is pending and cannot be submitted again', async () => {
    const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}} pending
        onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
    expect(screen.findByTestId('workflow-run-inputs-starting')?.props.children).toBe(t('workflows.start.starting'));
    expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
});
