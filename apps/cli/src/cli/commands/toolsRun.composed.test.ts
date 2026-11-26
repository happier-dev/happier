import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { buildHappierToolsShellBridgeCommand, parseTrustedHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';
import { codeModeStdioServer, createCodeModePermissionFixture, openCodeModeMcpFixture } from '@/mcp/runtime/codeModeMcp.testkit';
import { SESSION_MCP_CONTEXT_FILE_ENV } from '@/mcp/runtime/sessionMcpLocalContext';
import * as sessionMcpClient from '@/mcp/runtime/sessionMcpLocalClient';
import { handleToolsCommand } from './tools';

describe('tools run', () => {
  it.runIf(process.platform === 'linux')('calls an Action, reuses a stateful stdio server, and awaits a real tool approval on one socket', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const { permission, permissionSession, permissionRpc, getActiveTurnAdmissionWitness } = createCodeModePermissionFixture();
    const fileRoot = await mkdtemp(join(tmpdir(), 'happier-tools-run-'));
    const fixture = await openCodeModeMcpFixture({ featureEnabled: true,
      servers: [{ ...codeModeStdioServer('records', ['count', 'write']),
        tools: { default: 'allow_all', overrides: { write: 'ask' }, loading: 'on_demand' },
      }],
      profile: { scriptRunnerEnabled: true, mcpPermissionHandler: permission },
      session: { getActiveTurnAdmissionWitness },
    });
    const contextFile = join(fileRoot, 'context.json');
    await writeFile(contextFile, JSON.stringify(fixture.profile.sessionMcpContext), { mode: 0o600 });
    vi.stubEnv(SESSION_MCP_CONTEXT_FILE_ENV, contextFile);
    const connect = vi.spyOn(sessionMcpClient, 'connectSessionMcpClient');
    const output = captureStdoutJsonOutput();
    const stderr = vi.spyOn(process.stderr, 'write');
    const exitCode = process.exitCode;
    const controller = new AbortController();
    const script = handleToolsCommand(['run', '--agent-bridge', '--code', `
      const actions = await happier.action.spec.search({ query: 'session.title.set', limit: 1 });
      console.log('processing records');
      const record = { namespace: 'test', key: 'record-1' };
      const values = [
        await mcp.records.count(record),
        await mcp.records.count(record),
        await mcp.records.write(record)
      ];
      return { action: actions.actionSpecs[0].id, counter: values.map(value => value.content[0].text) };
    `], undefined, controller.signal);
    try {
      await Promise.race([
        vi.waitFor(() => expect(Object.keys(permissionSession.__getAgentState().requests ?? {})).toHaveLength(1),
          { timeout: 50_000 }),
        script.then(() => { throw new Error(`Script completed before approval: ${JSON.stringify(output.json())}`); }),
      ]);
      const [id, request] = Object.entries(permissionSession.__getAgentState().requests ?? {})[0]!;
      expect(request).toMatchObject({ mcpTool: { server: 'records', tool: 'write' } });
      const offer = request.nativeChoices!;
      await permissionRpc.handlers.get('session.permission.respond')!({ id, turnId: request.turnId,
        nativeChoice: { requirementId: offer.requirementId, choiceId: 'approved' }, approved: true });
      await script;
      expect(output.json()).toMatchObject({ ok: true, result: { action: 'session.title.set', counter: ['1', '2', '3'] },
        calls: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      });
      expect(stderr.mock.calls.some(([value]) => String(value).includes('processing records'))).toBe(true);
      expect(JSON.stringify(output.json())).not.toContain('processing records');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(permissionSession.__getAgentState().completedRequests?.[id]).toMatchObject({ decision: 'approved',
        nativeChoice: { requirementId: offer.requirementId, choiceId: 'approved' },
      });
    } finally {
      controller.abort();
      await script.catch(() => undefined);
      process.exitCode = exitCode;
      output.restore();
      connect.mockRestore();
      stderr.mockRestore();
      vi.unstubAllEnvs();
      await permission.reset();
      await fixture.close();
      await rm(fileRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a Windows Agent bridge before opening Account credentials and cannot become a trusted shell call', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const exitCode = process.exitCode;
    const output = captureStdoutJsonOutput();
    const readCredentials = vi.fn(async () => null);
    try {
      const argv = ['run', '--code', 'return 1'];
      const command = buildHappierToolsShellBridgeCommand(argv);
      expect(parseTrustedHappierToolsShellBridgeCommand(command)).toBeNull();
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      await handleToolsCommand(['run', '--agent-bridge', '--json'], { readCredentials });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'session_requester_unavailable' } });
      expect(readCredentials).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
      process.exitCode = exitCode;
      output.restore();
    }
  });
});
