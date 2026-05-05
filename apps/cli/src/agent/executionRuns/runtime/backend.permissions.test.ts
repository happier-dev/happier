import { describe, expect, it } from 'vitest';

import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';

const TEST_RECOVERY_BACKEND_ID = `${'recovery'}.${'backend'}`;

describe('execution run permission handler', () => {
  it('blocks write-like ACP tools for safe-yolo execution runs until a response is provided', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'safe-yolo',
    });

    let resolved = false;
    const pending = handler.handleToolCall('tool-1', 'bash', { command: 'bash -lc "echo hi"' }).then((result) => {
      resolved = true;
      return result;
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);

    const responder = handler as unknown as { respondToPermissionRequest?: (id: string, approved: boolean) => void };
    expect(typeof responder.respondToPermissionRequest).toBe('function');
    responder.respondToPermissionRequest?.('tool-1', true);

    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('denies write-like ACP tools for read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('tool-2', 'bash', { command: 'bash -lc "echo hi"' })).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('auto-approves read-like ACP tools for read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: TEST_RECOVERY_BACKEND_ID,
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('tool-3', 'read', { path: 'README.md' })).resolves.toEqual({
      decision: 'approved',
    });
  });

  it('denies all ACP tools for no_tools execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: TEST_RECOVERY_BACKEND_ID,
      permissionMode: 'no_tools',
    });

    await expect(handler.handleToolCall('tool-4', 'read', { path: 'README.md' })).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('still auto-approves session_title_set for no_tools execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: TEST_RECOVERY_BACKEND_ID,
      permissionMode: 'no_tools',
    });

    await expect(handler.handleToolCall('tool-5', 'session_title_set', {})).resolves.toEqual({
      decision: 'approved',
    });
  });
});
