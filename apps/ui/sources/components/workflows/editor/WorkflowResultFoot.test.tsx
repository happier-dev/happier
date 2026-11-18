import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

import { createWorkflowEditorReadable } from './workflowEditorDraftStore';
import { WorkflowResultFoot } from './WorkflowResultFoot';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) => {
  return (
    await import('@/dev/testkit/mocks/popover')
  ).createInlinePopoverModuleMock(importOriginal, {
    maxHeight: 640,
    maxWidth: 400,
    placement: 'bottom',
  });
});

afterEach(standardCleanup);

describe('WorkflowResultFoot', () => {
  // WF-ACCEPT-1118B item 2: the page-foot section is the workflow's Result (labs 1116b/1116c); "Returns" names
  // a step's own row in Step options, so the two read their own words.
  it("heads the page-foot section with the Result title, not the step row's Returns", async () => {
    const draft = createWorkflowEditorDraft({
      draftId: 'foot',
      name: 'Review',
    });
    const screen = await renderScreen(
      <WorkflowResultFoot
        draftStore={createWorkflowEditorReadable(draft)}
        onChange={() => {}}
        editable
        testIDPrefix="editor"
      />,
    );
    const heading = screen.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'header' &&
        typeof node.props.children === 'string',
    );
    expect(heading.map((node) => node.props.children)).toContain(
      'workflows.finalOutput.sectionTitle',
    );
    expect(screen.getTextContent()).not.toContain(
      'workflows.page.inspector.resultTitle',
    );
  });
});
