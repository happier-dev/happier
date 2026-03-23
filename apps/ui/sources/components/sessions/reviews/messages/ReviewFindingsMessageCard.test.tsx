import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { changeTextTestInstance, findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionExecutionRunActionSpy = vi.fn(async (..._args: any[]) => ({ ok: true }));
const sendMessageSpy = vi.fn(async (..._args: any[]) => undefined);
const useExecutionRunsBackendsForSessionSpy = vi.fn<(...args: any[]) => any>((..._args: any[]) => null);
const useSessionMessagesSpy = vi.fn<(...args: any[]) => any>((..._args: any[]) => ({ messages: [], isLoaded: true }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
      colors: {
        surfaceHighest: '#111',
        divider: '#333',
        text: '#eee',
        textSecondary: '#aaa',
        link: '#06f',
        shadow: { color: '#000', opacity: 0.1 },
      },
    },
    });
});

vi.mock('@/components/markdown/MarkdownView', () => ({
  MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunAction: (...args: any[]) => sessionExecutionRunActionSpy(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: { sendMessage: (...args: any[]) => sendMessageSpy(...args) },
}));

vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
  useExecutionRunsBackendsForSession: (...args: any[]) => useExecutionRunsBackendsForSessionSpy(...args),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
    useSessionMessages: (...args: any[]) => useSessionMessagesSpy(...args),
});
});

describe('ReviewFindingsMessageCard', () => {
  it('falls back to disabling follow-up affordances for coderabbit when backend capabilities are unavailable', async () => {
    sessionExecutionRunActionSpy.mockClear();
    useExecutionRunsBackendsForSessionSpy.mockReturnValue(null);

    const { ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard');

    const payload: any = {
      runRef: { runId: 'run_1', callId: 'call_1', backendId: 'coderabbit' },
      summary: 'summary',
      overviewMarkdown: '## Overview',
      generatedAtMs: 1,
      findings: [
        { id: 'f1', title: 'T', severity: 'low', category: 'style', summary: 'S', filePath: 'a.ts', startLine: 1, endLine: 1 },
      ],
      questions: [{ id: 'q1', text: 'Need context?', status: 'open' }],
      assumptions: [],
    };

    const screen = await renderScreen(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    const tree = screen.tree;

    const findingHeader = findTestInstanceByTypeContainingText(screen, 'Pressable', 'T');
    expect(findingHeader).toBeDefined();
    await act(async () => {
      await pressTestInstanceAsync(findingHeader!);
    });

    expect(screen.getTextContent()).not.toContain('Ask reviewer');
    expect(screen.getTextContent()).not.toContain('Answer reviewer');
    expect(screen.getTextContent()).not.toContain('Answer question');
  });

  it('hides follow-up affordances when retention metadata is missing (fail closed)', async () => {
    sessionExecutionRunActionSpy.mockClear();
    useExecutionRunsBackendsForSessionSpy.mockReturnValue(null);

    const { ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard');

    const payload: any = {
      runRef: { runId: 'run_1', callId: 'call_1', backendId: 'coderabbit' },
      summary: 'summary',
      overviewMarkdown: '## Overview',
      generatedAtMs: 1,
      findings: [
        { id: 'f1', title: 'T', severity: 'low', category: 'style', summary: 'S', filePath: 'a.ts', startLine: 1, endLine: 1 },
      ],
      questions: [{ id: 'q1', text: 'Need context?', status: 'open' }],
      assumptions: [],
    };

    const screen = await renderScreen(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    const tree = screen.tree;

    const findingHeader = findTestInstanceByTypeContainingText(screen, 'Pressable', 'T');
    expect(findingHeader).toBeDefined();
    await act(async () => {
      await pressTestInstanceAsync(findingHeader!);
    });

    expect(screen.getTextContent()).not.toContain('Ask reviewer');
    expect(screen.getTextContent()).not.toContain('Answer question');
  });

  it('hides follow-up affordances when the run retention policy is ephemeral', async () => {
    sessionExecutionRunActionSpy.mockClear();
    useExecutionRunsBackendsForSessionSpy.mockReturnValue(null);

    const { ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard');

    const payload: any = {
      runRef: { runId: 'run_1', callId: 'call_1', backendId: 'claude', retentionPolicy: 'ephemeral' },
      summary: 'summary',
      overviewMarkdown: '## Overview\n\nNeeds review.',
      generatedAtMs: 1,
      findings: [
        { id: 'f1', title: 'T', severity: 'low', category: 'style', summary: 'S', filePath: 'a.ts', startLine: 1, endLine: 1 },
      ],
      questions: [],
      assumptions: [],
    };

    const screen = await renderScreen(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    const tree = screen.tree;

    const findingHeader = findTestInstanceByTypeContainingText(screen, 'Pressable', 'T');
    expect(findingHeader).toBeDefined();
    await act(async () => {
      await pressTestInstanceAsync(findingHeader!);
    });

    expect(screen.getTextContent()).not.toContain('Ask reviewer');
    expect(screen.getTextContent()).not.toContain('Answer question');
  });

  it('preloads persisted clarification comments and treats them as already applied', async () => {
    sessionExecutionRunActionSpy.mockClear();
    useExecutionRunsBackendsForSessionSpy.mockReturnValue(null);

    const { ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard');

    const payload: any = {
      runRef: { runId: 'run_1', callId: 'call_1', backendId: 'coderabbit' },
      summary: 'summary',
      generatedAtMs: 1,
      findings: [
        { id: 'f1', title: 'T', severity: 'low', category: 'style', summary: 'S', filePath: 'a.ts', startLine: 1, endLine: 1 },
      ],
      triage: { findings: [{ id: 'f1', status: 'needs_refinement', comment: 'please clarify' }] },
    };

    const screen = await renderScreen(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    const tree = screen.tree;

    const findingHeader = findTestInstanceByTypeContainingText(screen, 'Pressable', 'T');
    expect(findingHeader).toBeDefined();

    await act(async () => {
      await pressTestInstanceAsync(findingHeader!);
    });

    const inputs = screen.findAllByType('TextInput');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.props.value).toBe('please clarify');

    const appliedButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Applied');
    expect(appliedButton).toBeDefined();
    expect(appliedButton!.props.disabled).toBe(true);
    expect(sessionExecutionRunActionSpy).not.toHaveBeenCalled();
  });

  it('surfaces clarify, ignore, and implement-fix actions and maps clarification to needs_refinement', async () => {
    sessionExecutionRunActionSpy.mockClear();
    useExecutionRunsBackendsForSessionSpy.mockReturnValue(null);

    const { ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard');

    const payload: any = {
      runRef: { runId: 'run_1', callId: 'call_1', backendId: 'coderabbit' },
      summary: 'summary',
      generatedAtMs: 1,
      findings: [
        { id: 'f1', title: 'T', severity: 'low', category: 'style', summary: 'S', filePath: 'a.ts', startLine: 1, endLine: 1 },
      ],
    };

    const screen = await renderScreen(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    const tree = screen.tree;

    const header = findTestInstanceByTypeContainingText(screen, 'Pressable', 'T');
    expect(header).toBeDefined();

    await act(async () => {
      await pressTestInstanceAsync(header!);
    });

    const clarify = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Ask for clarification');
    const ignore = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Ignore');
    const implementFix = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Implement fix');
    const applyReviewActions = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Apply review actions');

    expect(clarify).toBeDefined();
    expect(ignore).toBeDefined();
    expect(implementFix).toBeDefined();
    expect(applyReviewActions).toBeDefined();

    await act(async () => {
      await pressTestInstanceAsync(clarify!);
    });

    const inputs = screen.findAllByType('TextInput');
    expect(inputs).toHaveLength(1);

    await act(async () => {
      changeTextTestInstance(inputs[0]!, 'please clarify the impact');
    });

    await act(async () => {
      await pressTestInstanceAsync(applyReviewActions!);
    });

    expect(sessionExecutionRunActionSpy).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        runId: 'run_1',
        actionId: 'review.triage',
        input: {
          findings: [{ id: 'f1', status: 'needs_refinement', comment: 'please clarify the impact' }],
        },
      }),
    );
  });

  it('shows applied state and disables redundant triage saves until the draft changes again', async () => {
    sessionExecutionRunActionSpy.mockClear();
    useExecutionRunsBackendsForSessionSpy.mockReturnValue(null);

    const { ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard');

    const payload: any = {
      runRef: { runId: 'run_1', callId: 'call_1', backendId: 'claude' },
      summary: 'summary',
      overviewMarkdown: '## Overview',
      generatedAtMs: 1,
      findings: [
        { id: 'f1', title: 'T', severity: 'low', category: 'style', summary: 'S', filePath: 'a.ts', startLine: 1, endLine: 1 },
      ],
      questions: [],
      assumptions: [],
    };

    const screen = await renderScreen(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));

    const findingHeader = findTestInstanceByTypeContainingText(screen, 'Pressable', 'T');
    expect(findingHeader).toBeDefined();

    await act(async () => {
      await pressTestInstanceAsync(findingHeader!);
    });

    const ignore = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Ignore');
    expect(ignore).toBeDefined();

    await act(async () => {
      await pressTestInstanceAsync(ignore!);
    });

    let applyReviewActions = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Apply review actions');
    expect(applyReviewActions).toBeDefined();
    expect(applyReviewActions!.props.disabled).toBe(false);

    await act(async () => {
      await pressTestInstanceAsync(applyReviewActions!);
    });

    expect(sessionExecutionRunActionSpy).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        runId: 'run_1',
        actionId: 'review.triage',
        input: {
          findings: [{ id: 'f1', status: 'reject' }],
        },
      }),
    );

    const appliedButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Applied');
    expect(appliedButton).toBeDefined();
    expect(appliedButton!.props.disabled).toBe(true);

    const decideLater = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Decide later');
    expect(decideLater).toBeDefined();

    await act(async () => {
      await pressTestInstanceAsync(decideLater!);
    });

    applyReviewActions = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Apply review actions');
    expect(applyReviewActions).toBeDefined();
    expect(applyReviewActions!.props.disabled).toBe(false);
  });

  it('sends review.follow_up when asking the reviewer for clarification', async () => {
    sessionExecutionRunActionSpy.mockClear();
    useExecutionRunsBackendsForSessionSpy.mockReturnValue(null);

    const { ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard');

    const payload: any = {
      runRef: { runId: 'run_1', callId: 'call_1', backendId: 'claude', retentionPolicy: 'resumable' },
      summary: 'summary',
      overviewMarkdown: '## Overview\n\nNeeds review.',
      generatedAtMs: 1,
      findings: [
        { id: 'f1', title: 'T', severity: 'low', category: 'style', summary: 'S', filePath: 'a.ts', startLine: 1, endLine: 1 },
      ],
      questions: [],
      assumptions: [],
    };

    const screen = await renderScreen(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));

    const findingHeader = findTestInstanceByTypeContainingText(screen, 'Pressable', 'T');
    expect(findingHeader).toBeDefined();
    await act(async () => {
      await pressTestInstanceAsync(findingHeader!);
    });

    const askReviewer = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Ask reviewer')
      ?? findTestInstanceByTypeContainingText(screen, 'Pressable', 'askReviewer');
    expect(askReviewer).toBeDefined();

    await act(async () => {
      await pressTestInstanceAsync(askReviewer!);
    });

    const inputs = screen.findAllByType('TextInput');
    expect(inputs.length).toBeGreaterThan(0);
    await act(async () => {
      changeTextTestInstance(inputs.at(-1)!, 'Please clarify why this matters.');
    });

    const sendFollowUp = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Send follow-up')
      ?? findTestInstanceByTypeContainingText(screen, 'Pressable', 'sendFollowUp');
    expect(sendFollowUp).toBeDefined();
    await act(async () => {
      await pressTestInstanceAsync(sendFollowUp!);
    });

    expect(sessionExecutionRunActionSpy).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        runId: 'run_1',
        actionId: 'review.follow_up',
        input: {
          findingIds: ['f1'],
          messageMarkdown: 'Please clarify why this matters.',
        },
      }),
    );
  });

  it('publishes accepted findings via structured review_publish_request.v1 metadata', async () => {
    sendMessageSpy.mockClear();
    useExecutionRunsBackendsForSessionSpy.mockReturnValue(null);
    useSessionMessagesSpy.mockReturnValue({ messages: [], isLoaded: true });

    const { ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard');

    const payload: any = {
      runRef: { runId: 'run_1', callId: 'call_1', backendId: 'claude' },
      summary: 'summary',
      overviewMarkdown: '## Overview',
      generatedAtMs: 1,
      findings: [
        {
          id: 'f1',
          title: 'T',
          severity: 'low',
          category: 'style',
          summary: 'S',
          whyItMatters: 'W',
          evidence: 'E',
          confidence: 0.5,
          filePath: 'a.ts',
          startLine: 1,
          endLine: 1,
        },
      ],
      questions: [],
      assumptions: [],
      triage: { findings: [{ id: 'f1', status: 'accept' }] },
    };

    const screen = await renderScreen(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    const tree = screen.tree;

    const publish = screen.findByTestId('review-findings-publish-accepted');
    expect(publish).toBeDefined();

    await act(async () => {
      await pressTestInstanceAsync(publish!);
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const metaOverrides = sendMessageSpy.mock.calls[0]?.[3];
    expect(metaOverrides).toEqual({
      happier: {
        kind: 'review_publish_request.v1',
        payload: expect.objectContaining({
          sourceRunRef: { runId: 'run_1', callId: 'call_1', backendId: 'claude' },
          findingIds: ['f1'],
        }),
      },
    });
  });

  it('publishes accepted findings using the latest follow-up snapshot for the same review run', async () => {
    sendMessageSpy.mockClear();
    useExecutionRunsBackendsForSessionSpy.mockReturnValue(null);
    useSessionMessagesSpy.mockReturnValue({
      isLoaded: true,
      messages: [
        {
          id: 'follow_up_1',
          kind: 'agent-text',
          localId: null,
          createdAt: 2,
          text: '',
          meta: {
            happier: {
              kind: 'review_follow_up.v1',
              payload: {
                parentRunRef: { runId: 'run_1', callId: 'call_1', backendId: 'claude' },
                threadId: 'thread_1',
                requestMarkdown: 'Please clarify',
                answerMarkdown: 'Use the merged version.',
                updatedFindings: [
                  {
                    id: 'f1',
                    title: 'Merged finding',
                    severity: 'high',
                    category: 'correctness',
                    summary: 'Merged summary',
                    whyItMatters: 'Merged impact',
                    evidence: 'Merged evidence',
                    confidence: 0.9,
                    filePath: 'a.ts',
                    startLine: 1,
                    endLine: 2,
                  },
                ],
                generatedAtMs: 2,
              },
            },
          },
        },
      ],
    });

    const { ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard');

    const payload: any = {
      runRef: { runId: 'run_1', callId: 'call_1', backendId: 'claude' },
      summary: 'summary',
      overviewMarkdown: '## Overview',
      generatedAtMs: 1,
      findings: [
        {
          id: 'f1',
          title: 'Original finding',
          severity: 'low',
          category: 'style',
          summary: 'Original summary',
          whyItMatters: 'Original impact',
          evidence: 'Original evidence',
          confidence: 0.5,
          filePath: 'a.ts',
          startLine: 1,
          endLine: 1,
        },
      ],
      questions: [],
      assumptions: [],
      triage: { findings: [{ id: 'f1', status: 'accept' }] },
    };

    const screen = await renderScreen(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    const tree = screen.tree;

    const findingHeader = screen.findByTestId('review-findings-header:f1');
    expect(findingHeader).toBeDefined();

    await act(async () => {
      await pressTestInstanceAsync(findingHeader!);
    });

    expect(screen.getTextContent()).toContain('Merged summary');

    const publish = screen.findByTestId('review-findings-publish-accepted');
    expect(publish).toBeDefined();

    await act(async () => {
      await pressTestInstanceAsync(publish!);
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const [, text, , metaOverrides] = sendMessageSpy.mock.calls[0] as any[];
    expect(String(text)).toContain('Merged finding');
    expect(metaOverrides).toEqual({
      happier: {
        kind: 'review_publish_request.v1',
        payload: expect.objectContaining({
          sourceRunRef: { runId: 'run_1', callId: 'call_1', backendId: 'claude' },
          findingIds: ['f1'],
          threadRefs: ['thread_1'],
          publishedFindings: [
            expect.objectContaining({
              id: 'f1',
              summary: 'Merged summary',
            }),
          ],
        }),
      },
    });
  });
});
