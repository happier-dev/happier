import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: 'View',
            Text: 'Text',
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? null,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
      colors: {
        surface: '#fff',
        divider: '#ddd',
        shadow: { color: '#000', opacity: 0.2 },
        textSecondary: '#aaa',
      },
    },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            if (key === 'runs.groupLabel') {
                return `Group ${String(params?.groupId ?? '')}`.trim();
            }
            return key;
        },
    });
});

vi.mock('./ExecutionRunRow', () => ({
  ExecutionRunRow: ({ run }: { run: any }) => React.createElement('ExecutionRunRow', { runId: run?.runId ?? '' }),
}));

describe('ExecutionRunList', () => {
  it('groups runs by display.groupId when provided', async () => {
    const { ExecutionRunList } = await import('./ExecutionRunList');

    const screen = await renderScreen(React.createElement(ExecutionRunList, {
          runs: [
            { runId: 'r1', intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, status: 'running', display: { groupId: 'g1' } },
            { runId: 'r2', intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, status: 'running', display: { groupId: 'g1' } },
            { runId: 'r3', intent: 'plan', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, status: 'succeeded' },
          ],
        }));

    expect(screen.getTextContent()).toContain('Group g1');
  });
});
