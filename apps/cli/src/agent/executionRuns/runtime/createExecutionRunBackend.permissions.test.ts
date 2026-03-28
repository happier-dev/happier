import { describe, expect, it } from 'vitest';

import { createExecutionRunPermissionHandler } from './createExecutionRunBackend';

describe('createExecutionRunPermissionHandler', () => {
  it('auto-approves write-like ACP tools for safe-yolo execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'safe-yolo',
    });

    await expect(handler.handleToolCall('tool-1', 'bash', { command: 'bash -lc "echo hi"' })).resolves.toEqual({
      decision: 'approved_for_session',
    });
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
      backendId: 'opencode',
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('tool-3', 'read', { path: 'README.md' })).resolves.toEqual({
      decision: 'approved_for_session',
    });
  });

  it('denies all ACP tools for no_tools execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'opencode',
      permissionMode: 'no_tools',
    });

    await expect(handler.handleToolCall('tool-4', 'read', { path: 'README.md' })).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('still auto-approves session_title_set for no_tools execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'opencode',
      permissionMode: 'no_tools',
    });

    await expect(handler.handleToolCall('tool-5', 'session_title_set', {})).resolves.toEqual({
      decision: 'approved_for_session',
    });
  });
});
