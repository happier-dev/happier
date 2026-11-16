import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setWorkflowInputs } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { WorkflowInputsEditor } from './WorkflowInputsEditor';
import {
  createWorkflowEditorDraft,
  type WorkflowEditorDraft,
} from '@/sync/domains/workflows/workflowEditorDraft';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// Native/web portals are a platform boundary; the real menu and row logic stay.
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
  return createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 360, placement: 'bottom' });
});
afterEach(standardCleanup);

/** The card's own wiring: the table's edits land in the draft through the inputs owner. */
function InputsHost(
  props: Readonly<{
    initial: WorkflowEditorDraft;
    onDraft: (draft: WorkflowEditorDraft) => void;
  }>,
) {
  const [draft, setDraft] = React.useState(props.initial);
  return (
    <WorkflowInputsEditor
      inputs={draft.inputs}
      testIDPrefix="wf"
      onChange={(next) => {
        const updated = setWorkflowInputs(draft, next);
        props.onDraft(updated);
        setDraft(updated);
      }}
    />
  );
}

function textInput(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  testID: string,
) {
  return screen.root.find(
    (node) =>
      node.props?.testID === testID &&
      typeof node.props?.onChangeText === 'function',
  );
}

describe('Workflow inputs table', () => {
  it('edits each cell in place and round-trips through the inputs owner', async () => {
    const branch: WorkflowInputDefinition = {
      name: 'branch',
      valueType: 'string',
      required: false,
    };
    const initial = {
      ...createWorkflowEditorDraft({ draftId: 'd1' }),
      inputs: [branch],
    };
    const drafts: WorkflowEditorDraft[] = [];
    const screen = await renderScreen(
      <InputsHost initial={initial} onDraft={(draft) => drafts.push(draft)} />,
    );

    await act(async () => {
      textInput(screen, 'wf-input-0-default').props.onChangeText('main');
    });
    await act(async () => {
      textInput(screen, 'wf-input-0-description').props.onChangeText(
        'The branch whose checks to run',
      );
    });
    await act(async () => {
      textInput(screen, 'wf-input-0-name').props.onChangeText('base');
    });
    expect(drafts.at(-1)?.inputs).toEqual([
      {
        name: 'base',
        valueType: 'string',
        required: false,
        default: 'main',
        description: 'The branch whose checks to run',
      },
    ]);

    // Required has no fallback: the default goes, and its cell stops offering one.
    await act(async () => {
      screen.root
        .find(
          (node) =>
            node.props?.testID === 'wf-input-0-required' &&
            typeof node.props?.onValueChange === 'function',
        )
        .props.onValueChange(true);
    });
    expect(drafts.at(-1)?.inputs[0]).toMatchObject({
      name: 'base',
      required: true,
      default: undefined,
    });
    expect(screen.findByTestId('wf-input-0-default')).toBeNull();

    await screen.pressByTestIdAsync('wf-inputs-add');
    expect(drafts.at(-1)?.inputs.map((input) => input.name)).toEqual([
      'base',
      'input',
    ]);

    await screen.pressByTestIdAsync('wf-input-1-more');
    await screen.pressByTestIdAsync('wf-input-1-remove');
    expect(drafts.at(-1)?.inputs.map((input) => input.name)).toEqual(['base']);
    await screen.unmount();
  });
});

describe('More settings', () => {
  it('closed, sums up what the workflow sets beyond the card, in the words its rows use', async () => {
    const { createWorkflowEditorReadable } =
      await import('./workflowEditorDraftStore');
    const { WorkflowMoreSettings } = await import('./WorkflowMoreSettings');
    const draft: WorkflowEditorDraft = {
      ...createWorkflowEditorDraft({ draftId: 'd2' }),
      roles: [
        { roleId: 'judge', name: 'Judge', instructions: 'Decide.' },
        { roleId: 'second', name: 'Second opinion', instructions: 'Disagree.' },
      ],
    } as WorkflowEditorDraft;
    const store = createWorkflowEditorReadable(draft);
    const screen = await renderScreen(
      <WorkflowMoreSettings
        draftStore={store}
        onChange={(next) => store.set(next)}
        documentEditable
        authoringFacts={undefined}
        testIDPrefix="wf"
      />,
    );
    const summary = screen.findByTestId('wf-more-settings-summary');
    expect(screen.getTextContent()).toContain(
      'Judge, Second opinion',
    );
    expect(summary).not.toBeNull();

    await screen.pressByTestIdAsync('wf-more-settings-toggle');
    // Open, the summary gives way to the rows themselves, and the Roles row reads the same names.
    expect(screen.findByTestId('wf-more-settings-summary')).toBeNull();
    expect(
      screen.root.find(
        (node) =>
          node.props?.testID === 'wf-more-settings-roles' &&
          typeof node.props?.onPress === 'function',
      ).props.accessibilityLabel,
    ).toContain('Judge, Second opinion');

    // A change the rows make reaches the closed line.
    await act(async () => {
      store.set({
        ...store.get(),
        roles: [{ roleId: 'judge', name: 'Judge', instructions: 'Decide.' }],
      } as WorkflowEditorDraft);
    });
    await screen.pressByTestIdAsync('wf-more-settings-toggle');
    expect(screen.getTextContent()).toContain(
      `${t('workflows.page.sections.rolesRow')}: Judge`,
    );
    expect(screen.getTextContent()).not.toContain('Second opinion');
    await screen.unmount();
  });
});
