import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleToolsCommand } from './tools';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readHappierActionToolFailure } from '@happier-dev/protocol/actions/happierActionToolResult';
import { parseHappierToolsShellBridgeCommand } from '@happier-dev/protocol/tools/happierToolsShellBridge';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetActiveAccountSettingsSnapshotForTests();
});

describe('Windows current-user Agent tools compatibility', () => {
  it.each([
    { outcome: 'success', result: { ok: true, result: { title: 'Windows Session' } },
      expected: { ok: true, data: { output: { title: 'Windows Session' } } } },
    { outcome: 'workflow refusal', result: { ok: false, errorCode: 'action_interception_rejected', error: 'PRIVATE',
      details: { message: 'Review the check Run.', stderr: 'PRIVATE' } },
      expected: { ok: false, error: { code: 'action_interception_rejected',
        message: 'Workflow-supplied reason (untrusted): "Review the check Run."',
        details: { message: 'Review the check Run.', messageTrust: 'workflow_supplied_untrusted' } } } },
    { outcome: 'permission refusal', result: { ok: false, errorCode: 'permission_denied', error: 'Permission is required.' },
      expected: { ok: false, error: { code: 'permission_denied', message: 'Permission is required.' } } },
  ])('keeps the credentialed Session RPC route and typed $outcome without Unix context', async ({ result, expected }) => {
    const sessionId = 'c123456789012345678901234';
    const app = fastify({ logger: false });
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
      metadata: JSON.stringify({ t: 'plain', v: {} }), machineId: 'machine-1' });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    app.get('/v1/sessions/:id', async () => ({ session }));
    app.get('/v2/sessions/:id', async () => ({ session }));
    await app.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
    const channel = await createRequesterCurrentnessSocketHarness();
    const requests: unknown[] = [];
    channel.server.on('connection', socket => socket.on('rpc-call', (request, acknowledge) => {
      requests.push(request);
      acknowledge({ ok: true, result });
    }));
    // Only the OS fact is substituted. CLI dispatch, lookup, RPC framing and
    // response normalization remain real; the established network is loopback.
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    vi.stubEnv('HAPPIER_SESSION_MCP_CONTEXT_FILE', '');
    const readCredentials = vi.fn(async () => ({ token: 'hap_v1_windows', encryption: null }));
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    try {
      await handleToolsCommand(['call', '--agent-bridge', '--session-id', sessionId,
        '--source', 'happier', '--tool', 'change_title', '--args-json', '{"title":"Windows Session"}',
        '--tool-call-id', 'native-windows-call', '--json'], { readCredentials });
      expect(output.json()).toMatchObject(expected);
      expect(JSON.stringify(output.json())).not.toContain('PRIVATE');
      if (result.ok === false && result.errorCode === 'action_interception_rejected') {
        const command = 'happier tools call --agent-bridge --source happier --tool change_title --args-json "{}" --json';
        expect(readHappierActionToolFailure('Bash', {
          command,
          _happier: { v: 2, protocol: 'acp', provider: 'codex', rawToolName: 'Bash', canonicalToolName: 'change_title' },
          happierToolsShellBridge: parseHappierToolsShellBridgeCommand(command),
        }, { stdout: JSON.stringify(output.json()), exit_code: 1 })).toMatchObject({
          code: 'action_interception_rejected', outcome: 'refused', message: 'Review the check Run.',
          messageTrust: 'workflow_supplied_untrusted',
        });
      }
      expect(requests).toEqual([expect.objectContaining({ method: `${sessionId}:${SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1}`,
        params: { toolName: 'change_title', args: { title: 'Windows Session' }, toolCallId: 'native-windows-call' } })]);
      expect(readCredentials).toHaveBeenCalled();
    } finally {
      output.restore(); process.exitCode = previousExitCode;
      await channel.close(); restoreHttp(); await app.close();
    }
  });

  it('keeps friendly Agent commands credentialed on Windows before the existing authentication refusal', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    vi.stubEnv('HAPPIER_SESSION_MCP_CONTEXT_FILE', '');
    const readCredentialsFn = vi.fn(async () => null);
    const command = findCompiledActionCliCommand(['skills', 'read'], listCompiledActionCliCommands());
    if (!command) throw new Error('Missing canonical skills.read command');
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    try {
      await runCompiledActionCliCommand({ command, argv: ['skills', 'read', '--input-json', '{"skillId":"review"}', '--json'],
        agentBridgeSessionId: 'windows-session', deps: { readCredentialsFn } });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'not_authenticated' } });
      expect(readCredentialsFn).toHaveBeenCalled();
    } finally { output.restore(); process.exitCode = previousExitCode; }
  });
});
