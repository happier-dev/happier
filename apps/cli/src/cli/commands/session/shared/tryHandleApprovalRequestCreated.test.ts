import { describe, expect, it, vi } from 'vitest';

import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';

import { tryHandleApprovalRequestCreated } from './tryHandleApprovalRequestCreated';

describe('CLI deferred approval output', () => {
  it('explains the originating Session prerequisite before the user approves a Session action', async () => {
    const output = captureConsoleText();
    try {
      const params = {
        envelopeKind: 'session_board_layout_update', json: false,
        result: { kind: 'approval_request_created', artifactId: 'approval-layout' },
        executionPlacement: resolveActionExecutionPlacementForInput(getActionSpec('session.board.layout.update'), {
          sessionId: 's1', expectedLayoutRevision: null,
          operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
        }, undefined, 'cli'),
      };
      expect(await tryHandleApprovalRequestCreated(params)).toBe(true);
    } finally {
      output.restore();
    }
    expect(output.text()).toContain('approval requested: approval-layout');
    expect(output.text()).toMatch(/originating daemon or agent session/i);
    expect(output.text()).toMatch(/standalone CLI/i);
  });

  it('keeps the pending JSON contract and reports the Session prerequisite on stderr', async () => {
    const output = captureConsoleJsonOutput();
    // Vitest intercepts console.error before process.stderr.write.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = { kind: 'approval_request_created', artifactId: 'approval-layout' };
    try {
      await tryHandleApprovalRequestCreated({ envelopeKind: 'session_board_layout_update', json: true,
        result: pending, executionPlacement: 'session' });
    } finally {
      output.restore();
    }
    expect(output.json()).toEqual({ v: 1, ok: true, kind: 'session_board_layout_update', data: pending });
    expect(stderr.mock.calls.flat().join(' ')).toMatch(/originating daemon or agent session/i);
    stderr.mockRestore();
  });
});
