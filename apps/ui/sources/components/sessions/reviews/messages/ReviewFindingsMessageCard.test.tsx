import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionExecutionRunActionSpy = vi.fn(async (..._args: any[]) => ({ ok: true }));
const sendMessageSpy = vi.fn(async (..._args: any[]) => undefined);
const useExecutionRunsBackendsForSessionSpy = vi.fn<(...args: any[]) => any>((..._args: any[]) => null);
const useSessionMessagesSpy = vi.fn<(...args: any[]) => any>((..._args: any[]) => ({ messages: [], isLoaded: true }));

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
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
  }),
  StyleSheet: {
    create: (input: any) =>
      typeof input === 'function'
        ? input({
          colors: {
            surfaceHighest: '#111',
            divider: '#333',
            text: '#eee',
            textSecondary: '#aaa',
            link: '#06f',
            shadow: { color: '#000', opacity: 0.1 },
          },
        })
        : input,
  },
}));

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

vi.mock('@/sync/domains/state/storage', () => ({
  useSessionMessages: (...args: any[]) => useSessionMessagesSpy(...args),
}));

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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    });

    const findingHeader = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('T'));
    });
    expect(findingHeader).toBeDefined();
    await act(async () => {
      findingHeader!.props.onPress?.();
    });

    const texts = tree!.root.findAllByType('Text').map((node: any) => String(node.props.children ?? ''));
    expect(texts.some((text) => text.includes('Ask reviewer'))).toBe(false);
    expect(texts.some((text) => text.includes('Answer reviewer'))).toBe(false);
    expect(texts.some((text) => text.includes('Answer question'))).toBe(false);
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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    });

    const findingHeader = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('T'));
    });
    expect(findingHeader).toBeDefined();
    await act(async () => {
      findingHeader!.props.onPress?.();
    });

    const texts = tree!.root.findAllByType('Text').map((node: any) => String(node.props.children ?? ''));
    expect(texts.some((text) => text.includes('Ask reviewer'))).toBe(false);
    expect(texts.some((text) => text.includes('Answer question'))).toBe(false);
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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    });

    const findingHeader = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('T'));
    });
    expect(findingHeader).toBeDefined();
    await act(async () => {
      findingHeader!.props.onPress?.();
    });

    const texts = tree!.root.findAllByType('Text').map((node: any) => String(node.props.children ?? ''));
    expect(texts.some((text) => text.includes('Ask reviewer'))).toBe(false);
    expect(texts.some((text) => text.includes('Answer question'))).toBe(false);
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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    });

    const findingHeader = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('T'));
    });
    expect(findingHeader).toBeDefined();

    await act(async () => {
      findingHeader!.props.onPress?.();
    });

    const inputs = tree!.root.findAllByType('TextInput');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.props.value).toBe('please clarify');

    const appliedButton = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Applied'));
    });
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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    });

    const header = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('T'));
    });
    expect(header).toBeDefined();

    await act(async () => {
      header!.props.onPress?.();
    });

    const pressables = tree!.root.findAllByType('Pressable');
    const clarify = pressables.find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Ask for clarification'));
    });
    const ignore = pressables.find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Ignore'));
    });
    const implementFix = pressables.find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Implement fix'));
    });
    const applyReviewActions = pressables.find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Apply review actions'));
    });

    expect(clarify).toBeDefined();
    expect(ignore).toBeDefined();
    expect(implementFix).toBeDefined();
    expect(applyReviewActions).toBeDefined();

    await act(async () => {
      clarify!.props.onPress?.();
    });

    const inputs = tree!.root.findAllByType('TextInput');
    expect(inputs).toHaveLength(1);

    await act(async () => {
      inputs[0]!.props.onChangeText?.('please clarify the impact');
    });

    await act(async () => {
      await applyReviewActions!.props.onPress?.();
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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    });

    const findingHeader = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('T'));
    });
    expect(findingHeader).toBeDefined();

    await act(async () => {
      findingHeader!.props.onPress?.();
    });

    const ignore = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Ignore'));
    });
    expect(ignore).toBeDefined();

    await act(async () => {
      ignore!.props.onPress?.();
    });

    let applyReviewActions = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Apply review actions'));
    });
    expect(applyReviewActions).toBeDefined();
    expect(applyReviewActions!.props.disabled).toBe(false);

    await act(async () => {
      await applyReviewActions!.props.onPress?.();
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

    const appliedButton = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Applied'));
    });
    expect(appliedButton).toBeDefined();
    expect(appliedButton!.props.disabled).toBe(true);

    const decideLater = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Decide later'));
    });
    expect(decideLater).toBeDefined();

    await act(async () => {
      decideLater!.props.onPress?.();
    });

    applyReviewActions = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Apply review actions'));
    });
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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    });

    const findingHeader = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('T'));
    });
    expect(findingHeader).toBeDefined();
    await act(async () => {
      findingHeader!.props.onPress?.();
    });

    const askReviewer = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => {
        const text = String(t.props.children ?? '');
        return text.includes('Ask reviewer') || text.includes('askReviewer');
      });
    });
    expect(askReviewer).toBeDefined();

    await act(async () => {
      askReviewer!.props.onPress?.();
    });

    const inputs = tree!.root.findAllByType('TextInput');
    expect(inputs.length).toBeGreaterThan(0);
    await act(async () => {
      inputs.at(-1)!.props.onChangeText?.('Please clarify why this matters.');
    });

    const sendFollowUp = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => {
        const text = String(t.props.children ?? '');
        return text.includes('Send follow-up') || text.includes('sendFollowUp');
      });
    });
    expect(sendFollowUp).toBeDefined();
    await act(async () => {
      await sendFollowUp!.props.onPress?.();
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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    });

    const publish = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Implement selected fixes'));
    });
    expect(publish).toBeDefined();

    await act(async () => {
      await publish!.props.onPress?.();
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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(ReviewFindingsMessageCard, { payload, sessionId: 'sess_1' }));
    });

    const findingHeader = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Merged finding'));
    });
    expect(findingHeader).toBeDefined();

    await act(async () => {
      findingHeader!.props.onPress?.();
    });

    const allText = tree!.root.findAllByType('Text').map((node: any) => String(node.props.children ?? ''));
    expect(allText.some((text) => text.includes('Merged summary'))).toBe(true);

    const publish = tree!.root.findAllByType('Pressable').find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Implement selected fixes'));
    });
    expect(publish).toBeDefined();

    await act(async () => {
      await publish!.props.onPress?.();
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
