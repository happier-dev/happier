import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? null },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      colors: {
        surface: '#fff',
        divider: '#ddd',
        shadow: { color: '#000', opacity: 0.2 },
        textSecondary: '#aaa',
      },
    },
  }),
  StyleSheet: { create: (input: any) => (typeof input === 'function' ? input({ colors: { shadow: { color: '#000', opacity: 0.2 } } }) : input) },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('./ExecutionRunRow', () => ({
  ExecutionRunRow: ({ run }: { run: any }) => React.createElement('ExecutionRunRow', { runId: run?.runId ?? '' }),
}));

describe('ExecutionRunList', () => {
  it('groups runs by display.groupId when provided', async () => {
    const { ExecutionRunList } = await import('./ExecutionRunList');

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(
        React.createElement(ExecutionRunList, {
          runs: [
            { runId: 'r1', intent: 'review', backendId: 'claude', status: 'running', display: { groupId: 'g1' } },
            { runId: 'r2', intent: 'review', backendId: 'claude', status: 'running', display: { groupId: 'g1' } },
            { runId: 'r3', intent: 'plan', backendId: 'codex', status: 'succeeded' },
          ],
        }),
      );
      await Promise.resolve();
    });

    const texts = tree!.root.findAllByType('Text').map((n: any) => String(n.props.children));
    expect(texts.join('\n')).toContain('Group g1');
  });
});
