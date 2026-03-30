import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { installSessionExecutionRunListCommonModuleMocks } from './sessionExecutionRunListTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionExecutionRunListCommonModuleMocks({
    text: async () => ({
        ...createTextModuleMock({
            translate: (key: string, params?: { groupId?: string }) => {
                if (key === 'runs.groupLabel') {
                    return `Group ${String(params?.groupId ?? '')}`.trim();
                }

                return key;
            },
        }),
    }),
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
