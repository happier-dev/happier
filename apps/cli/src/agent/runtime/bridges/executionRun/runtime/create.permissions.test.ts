import { describe, expect, it } from 'vitest';

import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';

const TEST_RECOVERY_BACKEND_ID = `${'recovery'}.${'backend'}`;

describe('execution run permission handler', () => {
  it('does not let a broader execution-run mode exceed its admitted causal ceiling', () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'yolo',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    });

    expect(handler.getImmediateDecision('causal-ceiling-run-1', 'bash', {
      command: 'bash -lc "echo hi"',
    })).toBeNull();
  });

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

  it('does not let a buffered approval bypass a narrower effective mode', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'read_only',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    });

    handler.respondToPermissionRequest('tool-buffered-read-only', true);

    await expect(handler.handleToolCall(
      'tool-buffered-read-only',
      'bash',
      { command: 'bash -lc "echo hi"' },
    )).resolves.toEqual({ decision: 'denied' });
  });

  it('does not let a buffered approval authorize malformed causal authority', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'yolo',
    });

    handler.respondToPermissionRequest('tool-buffered-malformed-authority', true);

    await expect(handler.handleToolCall(
      'tool-buffered-malformed-authority',
      'bash',
      { command: 'bash -lc "echo hi"' },
      {
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'unexpected-mode',
        } as never,
      },
    )).resolves.toEqual({ decision: 'denied' });
  });

  it('does not let a buffered approval authorize a missing active-turn authority', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'yolo',
    });

    handler.respondToPermissionRequest('tool-buffered-missing-authority', true);

    await expect(handler.handleToolCall(
      'tool-buffered-missing-authority',
      'bash',
      { command: 'bash -lc "echo hi"' },
      { causalPermissionAuthority: null } as never,
    )).resolves.toEqual({ decision: 'denied' });
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

  it('denies unknown, external MCP, and punctuation aliases in read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: TEST_RECOVERY_BACKEND_ID,
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('tool-db', 'mcp__db__drop_table', {})).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('tool-k8s', 'mcp__k8s__apply_manifest', {})).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('tool-punctuation', 'r-e-a-d', {})).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('allows only curated exact git inspection commands in read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'claude',
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('git-status', 'bash', { command: 'git status' })).resolves.toEqual({
      decision: 'approved',
    });
    await expect(handler.handleToolCall('git-env', 'bash', { command: 'PATH=/tmp/evil git status' })).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('git-args', 'bash', { command: 'git status --porcelain' })).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('git-compound', 'bash', { command: 'git status && id' })).resolves.toEqual({
      decision: 'denied',
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
