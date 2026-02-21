import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionExecutionRunActionSpy = vi.fn(async (..._args: any[]) => ({ ok: true }));

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      colors: {
        surfaceHighest: '#111',
        divider: '#333',
        text: '#eee',
        textSecondary: '#aaa',
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
            shadow: { color: '#000', opacity: 0.1 },
          },
        })
        : input,
  },
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunAction: (...args: any[]) => sessionExecutionRunActionSpy(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: { sendMessage: vi.fn(async () => undefined) },
}));

describe('ReviewFindingsMessageCard', () => {
  it('includes triage comment in review.triage input payload when present', async () => {
    sessionExecutionRunActionSpy.mockClear();

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

    const pressables = tree!.root.findAllByType('Pressable');
    const applyTriage = pressables.find((p: any) => {
      const texts = p.findAllByType?.('Text') ?? [];
      return texts.some((t: any) => String(t.props.children ?? '').includes('Apply triage'));
    });

    expect(applyTriage).toBeDefined();

    await act(async () => {
      await applyTriage!.props.onPress?.();
    });

    expect(sessionExecutionRunActionSpy).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        runId: 'run_1',
        actionId: 'review.triage',
        input: {
          findings: [{ id: 'f1', status: 'needs_refinement', comment: 'please clarify' }],
        },
      }),
    );
  });
});
