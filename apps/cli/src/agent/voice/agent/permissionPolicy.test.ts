import { describe, expect, it } from 'vitest';

import { createVoiceAgentAcpPermissionHandler, permissionModeForVoiceAgentPolicy } from './permissionPolicy';

describe('voice agent permission policy', () => {
  it('always maps voice agent policies to read-only mode', () => {
    expect(permissionModeForVoiceAgentPolicy('read_only')).toBe('read-only');
    expect(permissionModeForVoiceAgentPolicy('no_tools')).toBe('read-only');
  });

  it('approves non-write-like tools in read_only policy', async () => {
    const handler = createVoiceAgentAcpPermissionHandler('read_only');
    await expect(handler.handleToolCall('t1', 'fetch', {})).resolves.toMatchObject({ decision: 'approved' });
    await expect(handler.handleToolCall('t2', 'read_file', {})).resolves.toMatchObject({ decision: 'approved' });
  });

  it('denies write-like tools in read_only policy', async () => {
    const handler = createVoiceAgentAcpPermissionHandler('read_only');
    await expect(handler.handleToolCall('t1', 'write_file', {})).resolves.toMatchObject({ decision: 'denied' });
    await expect(handler.handleToolCall('t2', 'Bash', {})).resolves.toMatchObject({ decision: 'denied' });
    await expect(handler.handleToolCall('t3', 'unknown tool', {})).resolves.toMatchObject({ decision: 'denied' });
  });

  it('denies all tools in no_tools policy', async () => {
    const handler = createVoiceAgentAcpPermissionHandler('no_tools');
    await expect(handler.handleToolCall('t1', 'fetch', {})).resolves.toMatchObject({ decision: 'denied' });
    await expect(handler.handleToolCall('t2', 'write_file', {})).resolves.toMatchObject({ decision: 'denied' });
  });
});
