import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
  createTestSessionTranscriptSource,
  renderWithSessionTranscriptSource,
  standardCleanup,
} from '@/dev/testkit';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

installPermissionShellCommonModuleMocks();

const { PermissionFooter } = await import('./PermissionFooter');
const { PermissionAnswerOutcomeStatus } =
  await import('@/components/tools/shell/presentation/ToolOutcomeStatus');
const { resolveNativePermissionAnswer } =
  await import('@/components/approvals/approvalStatusLabel');

afterEach(standardCleanup);

// Four offered choices in the agent's own order and words (lab mb B `mbAppr:four`).
const nativeChoices = {
  requirementId: 'occurrence-7',
  source: 'native-test',
  choices: [
    {
      id: 'opaque:once',
      label: 'Allow once',
      decision: 'approved' as const,
      scope: 'once' as const,
      response: { approved: true as const },
    },
    {
      id: 'opaque:session',
      label: 'Allow edits this session',
      decision: 'approved_for_session' as const,
      scope: 'session' as const,
      response: { approved: true as const },
    },
    {
      id: 'opaque:always',
      label: 'Always allow edits',
      decision: 'approved' as const,
      scope: 'localPersistent' as const,
      response: { approved: true as const },
    },
    {
      id: 'opaque:reject',
      label: 'Reject',
      decision: 'denied' as const,
      scope: 'once' as const,
      response: { approved: false as const },
    },
  ],
};

function createSource(respondToPermission = vi.fn(async () => {})) {
  return createTestSessionTranscriptSource({
    sessionId: 's1',
    agentState: null,
    interaction: { canApprovePermissions: true, canSendMessages: true },
    actions: {
      respondToPermission,
      answerUserAction: vi.fn(),
      abort: vi.fn(),
      submitMessage: vi.fn(),
    },
  });
}

async function renderFooter(
  input: Readonly<{
    availability?: readonly {
      choiceId: string;
      allowed: boolean;
      reason?: 'owner_required';
    }[];
    respondToPermission?: ReturnType<typeof vi.fn>;
    onRender?: () => void;
  }> = {},
) {
  const source = createSource(input.respondToPermission as never);
  const element = (
    <PermissionFooter
      sessionId="s1"
      toolName="Edit"
      metadata={{ flavor: 'native-test' }}
      canApprovePermissions
      permission={{
        id: 'edit-1',
        turnId: 'turn-3',
        status: 'pending',
        nativeChoices,
        ...(input.availability
          ? { nativeChoiceAvailability: input.availability }
          : {}),
      }}
    />
  );
  const screen = await renderWithSessionTranscriptSource(
    input.onRender ? (
      <React.Profiler id="footer" onRender={input.onRender}>
        {element}
      </React.Profiler>
    ) : (
      element
    ),
    source,
  );
  return { screen, source };
}

function choiceButtons(
  screen: Awaited<ReturnType<typeof renderFooter>>['screen'],
) {
  return screen.findAll(
    (node) =>
      typeof node.type === 'string' &&
      typeof node.props.testID === 'string' &&
      node.props.testID.startsWith('permission-footer.choice.'),
  );
}

async function layOut(
  screen: Awaited<ReturnType<typeof renderFooter>>['screen'],
  width: number,
) {
  // The footer and its choices each measure their own column; a phone column is narrow for both.
  const columns = screen.findAll(
    (node) =>
      node.type === 'View' &&
      typeof node.props.onLayout === 'function',
  );
  await act(async () => {
    for (const column of columns) column.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
  });
}

describe('PermissionFooter offered native choices', () => {
  it('renders every offered choice verbatim in one row that reads inward from the end edge', async () => {
    const { screen } = await renderFooter();
    expect(
      choiceButtons(screen).map((node) =>
        node.props.testID.replace('permission-footer.choice.', ''),
      ),
    ).toEqual([
      'opaque:reject',
      'opaque:always',
      'opaque:session',
      'opaque:once',
    ]);
    const text = screen.getTextContent();
    for (const choice of nativeChoices.choices)
      expect(text).toContain(choice.label);
  });

  it('lists the choices in the agent order on a phone, each approval saying what its scope means', async () => {
    const { screen } = await renderFooter();
    await layOut(screen, 360);
    expect(
      choiceButtons(screen).map((node) =>
        node.props.testID.replace('permission-footer.choice.', ''),
      ),
    ).toEqual(nativeChoices.choices.map((choice) => choice.id));
    expect(screen.getTextContent()).toContain(
      'capabilities.session.toolAsk.untilSessionEnds',
    );
    expect(screen.getTextContent()).toContain(
      'capabilities.session.toolAsk.savedForLater',
    );
  });

  it('withholds a lasting choice from a shared approver with its reason, while once and session still answer', async () => {
    const respondToPermission = vi.fn(async () => {});
    const { screen } = await renderFooter({
      respondToPermission,
      availability: [
        { choiceId: 'opaque:always', allowed: false, reason: 'owner_required' },
      ],
    });
    const always = screen.findByTestId(
      'permission-footer.choice.opaque:always',
    );
    expect(always?.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getTextContent()).toContain(
      'capabilities.session.toolAsk.ownerRequired',
    );
    await screen.pressByTestIdAsync('permission-footer.choice.opaque:once');
    expect(respondToPermission).toHaveBeenCalledTimes(1);
    expect(respondToPermission).toHaveBeenCalledWith({
      id: 'edit-1',
      turnId: 'turn-3',
      nativeChoice: { requirementId: 'occurrence-7', choiceId: 'opaque:once' },
    });
  });

  it('opens the feedback field for a choice that accepts feedback and sends the words with that choice', async () => {
    const respondToPermission = vi.fn(async () => {});
    const feedbackChoices = {
      ...nativeChoices,
      choices: nativeChoices.choices.map((choice) =>
        choice.id === 'opaque:reject' ? { ...choice, label: 'Reject, and say why', allowsFeedback: true } : choice),
    };
    const source = createSource(respondToPermission as never);
    const screen = await renderWithSessionTranscriptSource(
      <PermissionFooter
        sessionId="s1"
        toolName="Edit"
        metadata={{ flavor: 'native-test' }}
        canApprovePermissions
        permission={{ id: 'edit-1', turnId: 'turn-3', status: 'pending', nativeChoices: feedbackChoices }}
      />,
      source,
    );
    await screen.pressByTestIdAsync('permission-footer.choice.opaque:reject');
    expect(respondToPermission).not.toHaveBeenCalled();
    expect(choiceButtons(screen)).toHaveLength(0);
    await act(async () => {
      screen.changeTextByTestId('permission-footer.feedback', '  Use the staging schema instead  ');
    });
    await screen.pressByTestIdAsync('permission-footer.feedback.send');
    expect(respondToPermission).toHaveBeenCalledTimes(1);
    expect(respondToPermission).toHaveBeenCalledWith({
      id: 'edit-1',
      turnId: 'turn-3',
      nativeChoice: { requirementId: 'occurrence-7', choiceId: 'opaque:reject', feedback: 'Use the staging schema instead' },
    });
  });

  it('does not re-render the decisions for an unrelated transcript update', async () => {
    let commits = 0;
    const { source } = await renderFooter({
      onRender: () => {
        commits++;
      },
    });
    commits = 0;
    await act(async () =>
      source.update({
        messages: [
          {
            kind: 'agent-text',
            id: 'm1',
            localId: null,
            createdAt: 1,
            text: 'Unrelated progress',
          } as never,
        ],
        agentState: null,
        metadata: null,
        reducerState: null,
      }),
    );
    expect(commits).toBe(0);
  });
});

describe('present but malformed native offer', () => {
  it('never falls back to the generic allow and deny controls', async () => {
    const screen = await renderWithSessionTranscriptSource(
      <PermissionFooter sessionId="s1" toolName="Edit" metadata={{ flavor: 'claude' }} canApprovePermissions
        permission={{ id: 'edit-2', status: 'pending', nativeChoices: null as never }} />, createSource());
    const buttons = screen.findAll(node => typeof node.type === 'string' && typeof node.props.onPress === 'function'
      && typeof node.props.testID === 'string' && node.props.testID.startsWith('permission-footer.'));
    expect(buttons).toHaveLength(0);
  });
});

describe('answered native decision', () => {
  const answered = {
    id: 'edit-1',
    status: 'approved' as const,
    nativeChoices,
    date: Date.UTC(2026, 10, 9, 13, 32),
    nativeChoice: { requirementId: 'occurrence-7', choiceId: 'opaque:session' },
  };

  it('collapses to the exact chosen label, and refusals read as refusals', () => {
    expect(resolveNativePermissionAnswer(answered)).toEqual({
      label: 'Allow edits this session',
      refused: false,
    });
    expect(
      resolveNativePermissionAnswer({
        ...answered,
        status: 'denied',
        nativeChoice: {
          requirementId: 'occurrence-7',
          choiceId: 'opaque:reject',
        },
      }),
    ).toEqual({ label: 'Reject', refused: true });
    expect(
      resolveNativePermissionAnswer({ ...answered, nativeChoice: undefined }),
    ).toBeNull();
    expect(
      resolveNativePermissionAnswer({ ...answered, status: 'canceled' }),
    ).toBeNull();
  });

  it('renders one line with the label first and the time after it', async () => {
    const screen = await renderWithSessionTranscriptSource(
      <PermissionAnswerOutcomeStatus permission={answered} />,
      createSource(),
    );
    const line = screen.findByTestId('tool-timeline-row-native-answer');
    expect(line?.props.accessibilityLabel).toMatch(
      /^Allow edits this session · /,
    );
  });
});
