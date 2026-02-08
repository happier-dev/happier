import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SDKAssistantMessage } from '../sdk';
import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';
import { PermissionHandler } from './permissionHandler';
import { createPermissionHandlerSessionStub } from './permissionHandler.testHelpers';

describe('Claude PermissionHandler tool trace', () => {
  afterEach(() => {
    delete process.env.HAPPIER_STACK_TOOL_TRACE;
    delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    __resetToolTraceForTests();
  });

  it('records permission-request and permission-response when tool tracing is enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-tool-trace-claude-permissions-'));
    const filePath = join(dir, 'tool-trace.jsonl');
    process.env.HAPPIER_STACK_TOOL_TRACE = '1';
    process.env.HAPPIER_STACK_TOOL_TRACE_FILE = filePath;

    try {
      const { session } = createPermissionHandlerSessionStub();
      const handler = new PermissionHandler(session);

      const input = { file_path: '/etc/hosts' };
      const assistantMessage: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input }],
        },
      };
      handler.onMessage(assistantMessage);

      const controller = new AbortController();
      const permissionPromise = handler.handleToolCall('Read', input, { permissionMode: 'default' }, {
        signal: controller.signal,
      });

      handler.approveToolCall('toolu_1');
      await expect(permissionPromise).resolves.toMatchObject({ behavior: 'allow' });

      expect(existsSync(filePath)).toBe(true);
      const raw = readFileSync(filePath, 'utf8');
      const lines = raw.trim().split('\n').map((line) => JSON.parse(line));

      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'outbound',
            sessionId: 'test-session-id',
            protocol: 'claude',
            provider: 'claude',
            kind: 'permission-request',
            payload: expect.objectContaining({
              type: 'permission-request',
              permissionId: 'toolu_1',
              toolName: 'Read',
            }),
          }),
          expect.objectContaining({
            direction: 'inbound',
            sessionId: 'test-session-id',
            protocol: 'claude',
            provider: 'claude',
            kind: 'permission-response',
            payload: expect.objectContaining({
              type: 'permission-response',
              permissionId: 'toolu_1',
              approved: true,
            }),
          }),
        ]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
