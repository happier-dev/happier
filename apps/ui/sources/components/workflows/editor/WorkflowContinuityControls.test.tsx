import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { createSessionFixture, renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { WorkflowAccountLifetimeProvider } from '../workflowAccountScope';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  renderScreen,
  standardCleanup,
  withPopoverWebGlobals,
} from '@/dev/testkit';

import type { WorkflowConversationSelection } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import {
  formatWorkflowConversationLabel,
  useWorkflowContinuedSessionLabel,
  WorkflowContinuityControls,
} from './WorkflowContinuityControls';

/**
 * A from-step conversation continues the producer's conversation, so this
 * branch waits for that block to finish before it takes its turn. The
 * disclosure must name the block the selection actually records — never the
 * first offered producer — and must stay silent for non-continuing choices.
 */

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});

afterEach(async () => {
  await standardCleanup();
});

function stepBlock(id: string, prompt: string) {
  return {
    kind: 'step' as const,
    id,
    document: { text: prompt, references: [], attachments: [] },
    input: [],
    result: { kind: 'text' as const },
  };
}

it('keeps the named Workflow input visible in a conversation summary', async () => {
  const label = formatWorkflowConversationLabel({
    draft: createWorkflowEditorDraft({
      draftId: 'continuity-input',
      name: 'Review',
      blocks: [],
    }),
    conversation: { kind: 'input', name: 'reviewSession' },
  });
  expect(label).toEqual(expect.any(String));
  expect(label).toContain('reviewSession');
});

async function renderControls(conversation: WorkflowConversationSelection) {
  const draft = createWorkflowEditorDraft({
    draftId: 'draft-1',
    name: 'Review',
    blocks: [
      stepBlock('producer-a', 'Check the build'),
      stepBlock('consumer-b', 'Report the result'),
    ],
  });
  return renderScreen(
    <WorkflowContinuityControls
      draft={draft}
      consumerBlockId="consumer-b"
      conversation={conversation}
      workspace={{ kind: 'inherit' }}
      onChangeConversation={() => {}}
      onChangeWorkspace={() => {}}
      testIDPrefix="editor"
    />,
  );
}

describe('WorkflowContinuityControls continuation disclosure', () => {
  /** The Conversation segmented choice (the SegmentedChoiceItem element) behind a test id prefix. */
  const conversationChoice = (
    screen: Awaited<ReturnType<typeof renderScreen>>,
    prefix: string,
  ) =>
    screen.findAll(
      (node) =>
        node.props.testIDPrefix === `${prefix}-conversation` &&
        Array.isArray(node.props.options),
    )[0]! as unknown as {
      props: {
        options: ReadonlyArray<{ id: string }>;
        value: string;
        onChange: (id: string) => void;
      };
    };

  it.each(['empty', 'error'] as const)(
    'keeps pending Session intent through loading and says what happened on %s',
    async (terminal) => {
      const restore = withPopoverWebGlobals();
      try {
        const demand = vi.fn();
        const retry = vi.fn();
        const props = {
          draft: createWorkflowEditorDraft({
            draftId: 'pending',
            name: 'Review',
            blocks: [stepBlock('step', 'Review')],
          }),
          conversation: { kind: 'shared_run' as const },
          workspace: { kind: 'inherit' as const },
          onSessionOptionsDemandChange: demand,
          onRetrySessionOptions: retry,
          onBindExistingSession: async () => ({ status: 'applied' as const }),
          onChangeConversation: () => {},
          onChangeWorkspace: () => {},
          testIDPrefix: 'pending',
        };
        const options = [
          { sessionId: 'session', machineId: 'machine', label: 'Review' },
        ];
        const screen = await renderScreen(
          <WorkflowContinuityControls
            {...props}
            existingSessions={[]}
            sessionOptionsStatus="loading"
          />,
        );
        await act(async () => {
          conversationChoice(screen, 'pending').props.onChange('continue');
        });
        expect(demand.mock.calls.map(([value]) => value)).toEqual([true]);
        expect(conversationChoice(screen, 'pending').props.value).toBe(
          'continue',
        );
        expect(screen.getTextContent()).toContain(
          'workflows.conversation.sessionsLoading',
        );
        await screen.update(
          <WorkflowContinuityControls
            {...props}
            existingSessions={terminal === 'empty' ? [] : options}
            sessionOptionsStatus={terminal === 'empty' ? 'ready' : 'error'}
          />,
        );
        // A settled read retires the chooser and its demand, and says what happened where the choice was made.
        expect(demand.mock.calls.map(([value]) => value)).toEqual([
          true,
          false,
        ]);
        expect(screen.getTextContent()).toContain(
          terminal === 'empty'
            ? 'workflows.conversation.noExistingSessions'
            : 'workflows.conversation.sessionsFailedRetry',
        );
        if (terminal === 'error') {
          // The failure is the retry: it reads again and reopens the chooser.
          await screen.pressByTestIdAsync(
            'pending-conversation-session-status',
          );
          expect(retry).toHaveBeenCalledTimes(1);
          expect(conversationChoice(screen, 'pending').props.value).toBe(
            'continue',
          );
          await act(async () => {
            conversationChoice(screen, 'pending').props.onChange('fresh');
          });
        }
        expect(demand.mock.calls.at(-1)?.[0]).toBe(false);
        await screen.update(
          <WorkflowContinuityControls
            {...props}
            existingSessions={options}
            sessionOptionsStatus="ready"
          />,
        );
        expect(
          screen.findByTestId('pending-conversation-session-picker'),
        ).toBeNull();
        await screen.unmount();
      } finally {
        await standardCleanup();
        restore();
      }
    },
  );
  it('does not offer Session binding without the mounted qualified binding owner', async () => {
    const changed = vi.fn();
    const screen = await renderScreen(
      <WorkflowContinuityControls
        draft={createWorkflowEditorDraft({
          draftId: 'draft',
          name: 'Review',
          blocks: [stepBlock('step', 'Review')],
        })}
        conversation={{ kind: 'shared_run' }}
        workspace={{ kind: 'inherit' }}
        existingSessions={[
          { sessionId: 'session', machineId: 'machine', label: 'Review' },
        ]}
        onChangeConversation={changed}
        onChangeWorkspace={() => {}}
        testIDPrefix="binding"
      />,
    );
    expect(
      conversationChoice(screen, 'binding').props.options.map(
        (option) => option.id,
      ),
    ).not.toContain('continue');
    await screen.unmount();
    expect(changed).not.toHaveBeenCalled();
  });
  it('names the actually selected producer when the conversation continues a step', async () => {
    const screen = await renderControls({
      kind: 'from_step',
      producer: { blockId: 'producer-a', scope: { kind: 'current' } },
    });

    expect(
      screen.findByTestId('editor-conversation-waiting-note'),
    ).not.toBeNull();
    expect(screen.getTextContent()).toContain(
      'workflows.conversation.waitingForConversation:{"block":"workflows.editor.addStep"}',
    );
  });

  it('says nothing about waiting when the conversation is not a continuation', async () => {
    const screen = await renderControls({ kind: 'shared_run' });

    expect(screen.findByTestId('editor-conversation-waiting-note')).toBeNull();
  });

  it('keeps the explicit Workflow workspace reachable beside Default and pins it when chosen', async () => {
    const changed = vi.fn();
    const props = {
      draft: createWorkflowEditorDraft({ draftId: 'pin', name: 'Review', blocks: [stepBlock('step', 'Review')] }),
      conversation: undefined,
      inherited: { conversation: undefined, workspace: { kind: 'project_checkout' as const } },
      onChangeConversation: () => {},
      onChangeWorkspace: changed,
      testIDPrefix: 'pin',
    };
    const screen = await renderScreen(<WorkflowContinuityControls {...props} workspace={undefined} />);
    const workspace = () =>
      screen.findAll((node) => node.props.testIDPrefix === 'pin-workspace' && Array.isArray(node.props.options))[0]! as unknown as {
        props: { options: ReadonlyArray<{ id: string }>; value: string; valueSource: string; onChange: (id: string) => void };
      };
    const follows = () =>
      screen.findAll((node) => node.props.testID === 'pin-workspace-follows-field' && Array.isArray(node.props.items))[0]! as unknown as {
        props: { selectedId: string; items: ReadonlyArray<{ id: string }>; onSelect: (id: string) => void };
      };
    // The three kinds stay visible segments; Default follows the workflow and offers the explicit choice beneath.
    expect(workspace().props.options.map((option) => option.id)).toEqual(['default', 'project_checkout', 'new_worktree']);
    expect(follows().props.items.map((item) => item.id)).toEqual(['default', 'inherit']);
    expect(follows().props.selectedId).toBe('default');
    await act(async () => {
      follows().props.onSelect('inherit');
    });
    expect(changed).toHaveBeenLastCalledWith({ kind: 'inherit' });
    // Recorded, it stays the Default segment as a set value, and reselecting Default never erases it.
    await screen.update(<WorkflowContinuityControls {...props} workspace={{ kind: 'inherit' }} />);
    expect(workspace().props.value).toBe('default');
    expect(workspace().props.valueSource).toBe('set');
    expect(follows().props.selectedId).toBe('inherit');
    changed.mockClear();
    await act(async () => {
      workspace().props.onChange('default');
    });
    expect(changed).not.toHaveBeenCalled();
    await act(async () => {
      follows().props.onSelect('default');
    });
    expect(changed).toHaveBeenLastCalledWith(undefined);
    // Another kind leaves Default: no follow field.
    await screen.update(<WorkflowContinuityControls {...props} workspace={{ kind: 'project_checkout' }} />);
    expect(screen.findAll((node) => node.props.testID === 'pin-workspace-follows-field')).toHaveLength(0);
  });

  it('offers the Workflow workspace as its own segment where a Workflow has no Default', async () => {
    const screen = await renderScreen(
      <WorkflowContinuityControls
        draft={createWorkflowEditorDraft({ draftId: 'settings', name: 'Review', blocks: [stepBlock('step', 'Review')] })}
        conversation={undefined}
        workspace={undefined}
        onChangeConversation={() => {}}
        onChangeWorkspace={() => {}}
        testIDPrefix="settings"
      />,
    );
    const workspace = screen.findAll((node) => node.props.testIDPrefix === 'settings-workspace' && Array.isArray(node.props.options))[0]! as unknown as {
      props: { options: ReadonlyArray<{ id: string }>; value: string };
    };
    expect(workspace.props.options.map((option) => option.id)).toEqual(['inherit', 'project_checkout', 'new_worktree']);
    expect(workspace.props.value).toBe('inherit');
    expect(screen.findAll((node) => node.props.testID === 'settings-workspace-follows-field')).toHaveLength(0);
  });

  it('lets a recorded Session be replaced even when it is the only Continue target', async () => {
    const restore = withPopoverWebGlobals();
    try {
      const bind = vi.fn(async () => ({ status: 'applied' as const }));
      const screen = await renderScreen(
        <WorkflowContinuityControls
          draft={createWorkflowEditorDraft({
            draftId: 'change',
            name: 'Review',
            blocks: [stepBlock('step', 'Review')],
          })}
          conversation={{
            kind: 'existing_session',
            sessionId: 'first',
            machineId: 'machine',
          }}
          workspace={undefined}
          existingSessions={[
            { sessionId: 'first', machineId: 'machine', label: 'First' },
            { sessionId: 'second', machineId: 'machine', label: 'Second' },
          ]}
          sessionOptionsStatus="ready"
          onBindExistingSession={bind}
          onChangeConversation={() => {}}
          onChangeWorkspace={() => {}}
          testIDPrefix="change"
        />,
      );
      const field = screen.findAll(
        (node) =>
          node.props.testID === 'change-conversation-continue-field' &&
          Array.isArray(node.props.items),
      )[0];
      expect(
        field,
        'The recorded Session must still expose its replacement field',
      ).toBeDefined();
      await act(async () => {
        field!.props.onSelect('existing_session');
      });
      expect(
        screen.findByTestId('change-conversation-session-picker'),
      ).not.toBeNull();
      await act(async () => {
        await screen.pressByTestIdAsync('change-conversation-session-second');
      });
      expect(bind).toHaveBeenCalledWith('second');
      await screen.unmount();
    } finally {
      restore();
    }
  });


  it('lets same-titled Sessions be told apart in the chooser by their Agent mark and Agent · Machine line', async () => {
    const restore = withPopoverWebGlobals();
    try {
      const screen = await renderScreen(
        <WorkflowContinuityControls
          draft={createWorkflowEditorDraft({
            draftId: 'change',
            name: 'Review',
            blocks: [stepBlock('step', 'Review')],
          })}
          conversation={{ kind: 'existing_session', sessionId: 'first', machineId: 'machine' }}
          workspace={undefined}
          existingSessions={[
            { sessionId: 'first', machineId: 'machine', label: 'tmp', agentId: 'claude', contextLabel: 'Claude · Studio' },
            { sessionId: 'second', machineId: 'machine', label: 'tmp', agentId: 'codex', contextLabel: 'Codex · Laptop' },
            { sessionId: 'third', machineId: 'machine', label: 'tmp' },
          ]}
          sessionOptionsStatus="ready"
          onBindExistingSession={async () => ({ status: 'applied' as const })}
          onChangeConversation={() => {}}
          onChangeWorkspace={() => {}}
          testIDPrefix="identity"
        />,
      );
      const field = screen.findAll(
        (node) => node.props.testID === 'identity-conversation-continue-field' && Array.isArray(node.props.items),
      )[0];
      expect(field).toBeDefined();
      await act(async () => { field!.props.onSelect('existing_session'); });
      const list = screen.findAll((node) => node.props.rootStep?.id === 'identity-conversation-existing-session')[0];
      expect(list).toBeDefined();
      const options = list!.props.rootStep.sections[0].options as ReadonlyArray<{ id: string; subtitle?: string; icon?: unknown }>;
      expect(options.map((option) => option.subtitle)).toEqual(['Claude · Studio', 'Codex · Laptop', undefined]);
      expect(options.every((option) => option.icon !== undefined)).toBe(true);
      await screen.unmount();
    } finally {
      restore();
    }
  });
  it('shows no Continue field when its only target is a step that cannot be changed', async () => {
    // Mis-wiring guard: the field is for choosing among targets, so one fixed step target adds none.
    const screen = await renderControls({
      kind: 'from_step',
      producer: { blockId: 'producer-a', scope: { kind: 'current' } },
    });
    expect(
      screen.findAll(
        (node) => node.props.testID === 'editor-conversation-continue-field',
      ),
    ).toHaveLength(0);
  });
});

it('replaces a configured continuation identity during privacy without changing its target', async () => {
  const previous = storage.getState();
  const session = createSessionFixture({ id: 'continued-private', serverId: 'continuity-home', metadata: { name: 'Secret launch', path: '/secret', host: 'test.local' } });
  const lifetime = { scope: { serverId: 'continuity-home', accountId: 'owner' }, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) };
  storage.setState({ sessions: { [session.id]: session } });
  const conversation = { kind: 'existing_session' as const, sessionId: session.id, machineId: 'runner' };
  const hook = await renderHook(() => useWorkflowContinuedSessionLabel(conversation), {
    wrapper: ({ children }) => <WorkflowAccountLifetimeProvider value={lifetime}>{children}</WorkflowAccountLifetimeProvider>,
  });
  try {
    expect(hook.getCurrent()).toBe('Secret launch');
    await act(async () => {
      storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'continuity-home': ['private'] } });
      storage.getState().setSessionTagAssignmentsOptimistic('continuity-home', session.id, ['private']);
      setScreenSharingPrivacyActive(true);
    });
    expect(hook.getCurrent()).toBe('workflows.conversation.savedSession');
    expect(conversation.sessionId).toBe(session.id);
    await act(async () => setScreenSharingPrivacyActive(false));
    expect(hook.getCurrent()).toBe('Secret launch');
  } finally { await hook.unmount(); setScreenSharingPrivacyActive(false); storage.setState(previous); }
});
