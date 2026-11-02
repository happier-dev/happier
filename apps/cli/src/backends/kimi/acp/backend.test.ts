import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeKimiFixture } from '../cli/runtimeDiscovery.testkit';
import { createKimiBackend } from './backend';
import type { AgentMessage } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import { getExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendRegistry';

describe.skipIf(process.platform === 'win32')('Kimi ACP backend', () => {
  it('keeps native approvals manual across lifecycle and host policy changes while preserving ACP and MCP', async () => {
    await withTempDir('happier-kimi-backend-', async (dir) => {
      const physicalDir = realpathSync(dir);
      const command = writeKimiFixture(dir, 'current');
      let permissionMode: PermissionMode = 'yolo';
      const options = {
        cwd: dir, env: { HAPPIER_KIMI_PATH: command, KIMI_CODE_HOME: join(dir, 'kimi-home') }, permissionMode,
        getPermissionMode: () => permissionMode,
        mcpServers: { happier: { command: '/bin/echo', args: ['noop'] } },
      };
      const fresh = createKimiBackend(options);
      const events: AgentMessage[] = [];
      fresh.onMessage((event) => events.push(event));
      try {
        expect(await fresh.startSession()).toMatchObject({ sessionId: 'kimi-fixture-session' });
        expect(events.some((event) => event.type === 'event' && event.name === 'session_modes_state')).toBe(false);
        expect(events.filter((event) => event.type === 'event' && event.name === 'config_options_state'))
          .toEqual([expect.objectContaining({ payload: { configOptions: [expect.objectContaining({ id: 'model' })] } })]);
        if (!(fresh instanceof AcpBackend)) throw new Error('Expected shared ACP backend');
        await expect(fresh.setSessionMode('kimi-fixture-session', 'yolo')).rejects.toThrow(/disabled/);
        await expect(fresh.setSessionConfigOption('kimi-fixture-session', 'mode', 'auto')).rejects.toThrow(/disabled/);
        for (const nextMode of ['default', 'plan', 'yolo'] as const) {
          permissionMode = nextMode;
          await fresh.sendPrompt('kimi-fixture-session', 'fixture policy change');
          await fresh.waitForResponseComplete();
        }
      } finally { await fresh.dispose(); }
      const resumed = createKimiBackend(options);
      try {
        expect(await resumed.loadSession?.('kimi-fixture-session')).toMatchObject({ sessionId: 'kimi-fixture-session' });
      } finally { await resumed.dispose(); }
      const requests = readFileSync(join(dir, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(requests.filter((request) => ['session/new', 'session/load'].includes(request.method))).toEqual([
        expect.objectContaining({ method: 'session/new', cwd: physicalDir, args: ['acp'], params: expect.objectContaining({ mcpServers: [expect.objectContaining({ name: 'happier', command: '/bin/echo' })] }) }),
        expect.objectContaining({ method: 'session/load', cwd: physicalDir, args: ['acp'], params: expect.objectContaining({ sessionId: 'kimi-fixture-session', mcpServers: [expect.objectContaining({ name: 'happier' })] }) }),
      ]);
      expect(requests.filter((request) => request.method === 'session/set_mode').map((request) => request.params))
        .toEqual([
          { sessionId: 'kimi-fixture-session', modeId: 'default' },
          { sessionId: 'kimi-fixture-session', modeId: 'default' },
        ]);
      const forked = createKimiBackend(options);
      try {
        if (!(forked instanceof AcpBackend)) throw new Error('Expected shared ACP backend');
        expect(await forked.forkSession({ sessionId: 'kimi-fixture-session' }))
          .toMatchObject({ sessionId: 'kimi-fixture-fork' });
      } finally { await forked.dispose(); }
      const executionRunBackendFactory = getExecutionRunBackendFactory('kimi');
      if (!executionRunBackendFactory) throw new Error('Expected Kimi execution-run backend factory');
      const executionRun = executionRunBackendFactory({
        backendId: 'kimi', cwd: dir, modelId: 'kimi-for-coding', permissionMode: 'default',
        permissionHandler: { handleToolCall: async () => ({ decision: 'denied' }) },
        isolation: { env: { HAPPIER_KIMI_PATH: command, KIMI_CODE_HOME: join(dir, 'kimi-home') } },
      });
      try {
        expect(await executionRun.startSession()).toMatchObject({ sessionId: 'kimi-fixture-session' });
      } finally { await executionRun.dispose(); }
      const executionRunRequests = readFileSync(join(dir, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(executionRunRequests).toContainEqual(expect.objectContaining({
        method: 'session/set_config_option',
        params: expect.objectContaining({ sessionId: 'kimi-fixture-session', configId: 'model', value: 'kimi-for-coding' }),
      }));
      expect(executionRunRequests.some((request) => request.method === 'session/set_model')).toBe(false);
      expect(executionRunRequests.filter((request) => request.method === 'session/set_mode').map((request) => request.params))
        .toEqual([
          { sessionId: 'kimi-fixture-session', modeId: 'default' },
          { sessionId: 'kimi-fixture-session', modeId: 'default' },
          { sessionId: 'kimi-fixture-fork', modeId: 'default' },
          { sessionId: 'kimi-fixture-session', modeId: 'default' },
        ]);
    });
  });
});
