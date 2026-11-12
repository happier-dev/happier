import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { assertStartupFailureThroughCli } from '@/session/services/createSpawnedSession.startupFailure.testkit';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession } from './createPublicAcpSession';
import { createPublicAcpDiagnostic } from './diagnostic';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { runInstalledFirstConversationRuntime } from '@/daemon/testkit/firstConversationRuntime.testkit';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
vi.mock('@/daemon/controlServer', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlServer')>(),
  // Only listening on the OS socket is replaced; the daemon router stays real.
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); boundary.control = null; });

it('retains a non-ACP executable transport refusal in the public startup diagnostic consumed by host publication', async () => {
  // Portable equivalent of Account A's /bin/echo exact-argument fixture: stdout
  // contains ordinary text and the process exits before an ACP handshake.
  const nativeSource = `process.stdout.write(' two words   padded  \\n');`;
  await withTempDir('acp-native-transport-refusal-', async directory => {
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'echo.mjs', source: nativeSource });
    const lifetime = new AbortController();
    const publications = createNativeAgentSessionPublications({ agentId: 'acp-start-canary', session: null,
      signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, supportsInFlightSteer: false });
    try {
      const refusal: unknown = await createPublicAcpSession({ kind: 'create',
        sessionId: 'c1234567890123456789012345', cwd: directory }, {
        transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'native-cli' }, args: [] },
      }, {
        pluginId: 'acme.start-canary', agentId: 'acp-start-canary', signal: lifetime.signal,
        isCurrent: () => !lifetime.signal.aborted,
        // The installed executable lookup is the OS boundary; ACP and failure
        // classification run their production implementations.
        systemTools: { resolve: async () => ({ toolId: 'native-cli', launch: { kind: 'binary',
          executablePath: process.execPath, args: [script], env: {} } }) },
        interactions: { async request() { throw new Error('Unexpected ACP interaction'); } },
        media: { async registerSourceRoot() { throw new Error('Unexpected ACP media'); } },
        models: publications.services.models, modes: publications.services.modes,
      }).then(async session => { await session.dispose(); throw new Error('Non-ACP command unexpectedly opened'); }, error => error);
      expect(refusal).toMatchObject({ code: 'agent_startup_transport_failed' });
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: refusal })).toMatchObject({
        code: 'agent_startup_transport_failed', source: 'agent_session_error', status: 'failed',
      });
    } finally { lifetime.abort(); publications.dispose(); }
  });
});

it('retains a native ACP authentication refusal through host publication, attestation and the strict CLI spawn sink', async () => {
  await withTempDir('acp-native-start-refusal-', async directory => {
    const nativeSource = `
      import { createInterface } from 'node:readline';
      import { writeFileSync } from 'node:fs';
      const methods = [];
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        methods.push(request.method);
        writeFileSync(process.env.STARTCANARY_ACP_CAPTURE ?? ${JSON.stringify(join(directory, 'host-refused.json'))}, JSON.stringify(methods));
        const error = request.method === 'session/new' && process.env.STARTCANARY_ACP_REFUSE !== '0'
          ? { code: -32000, message: 'Authentication required' } : null;
        const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
          : request.method === 'session/new' ? { sessionId: 'native-start-positive' } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }) + '\\n');
      }
    `;
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'native.mjs', source: nativeSource });
    // An authored Agent declares its executable entrypoint. A raw Node binary
    // is a runtime, so the real system-tool resolver correctly refuses it.
    const nativeCli = join(directory, process.platform === 'win32' ? 'native-agent.cmd' : 'native-agent');
    await writeExecutableScript(nativeCli, process.platform === 'win32'
      ? '@echo off\r\n"' + process.execPath + '" %*\r\n'
      : '#!/bin/sh\nexec \'' + process.execPath.replaceAll("'", "'\\''") + '\' "$@"\n');
    const lifetime = new AbortController();
    const publications = createNativeAgentSessionPublications({ agentId: 'acp-start-canary', session: null,
      signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, supportsInFlightSteer: false });
    const open = async (refuse: boolean) => await createPublicAcpSession({ kind: 'create',
      sessionId: 'c1234567890123456789012345', cwd: directory }, {
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'native-cli' }, args: [] },
    }, {
      pluginId: 'acme.start-canary', agentId: 'acp-start-canary', signal: lifetime.signal,
      isCurrent: () => !lifetime.signal.aborted,
      systemTools: { resolve: async () => ({ toolId: 'native-cli', launch: { kind: 'binary',
        executablePath: process.execPath, args: [script], env: {
          STARTCANARY_ACP_CAPTURE: join(directory, refuse ? 'refused.json' : 'positive.json'), STARTCANARY_ACP_REFUSE: refuse ? '1' : '0',
        } } }) },
      interactions: { async request() { throw new Error('Unexpected ACP interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected ACP media'); } },
      models: publications.services.models, modes: publications.services.modes,
    });
    try {
      // The same real owner/OS protocol must accept an ordinary Session first.
      const positive = await open(false);
      await positive.dispose();
      expect(JSON.parse(await readFile(join(directory, 'positive.json'), 'utf8'))).toEqual(['initialize', 'session/new']);
      const refusal: unknown = await open(true).then(async session => {
        await session.dispose();
        throw new Error('Native authentication refusal unexpectedly opened a Session');
      }, error => error);
      expect(refusal).toMatchObject({ code: -32000, diagnostic: { details: { requestErrorCode: -32000,
        v: 1, source: 'auth_error',
      } } });
      expect(JSON.parse(await readFile(join(directory, 'refused.json'), 'utf8'))).toEqual(['initialize', 'session/new']);
      const home = 'srv_native_start_refusal';
      const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true,
        createFirstConversationAgentFixture('UNADMITTED_NATIVE_INPUT', {
          nativeReply: { executableNames: [nativeCli], args: [] }, nativeAcp: { source: nativeSource },
        }), undefined, {
          externalActionAccountId: 'requester', homeServerIdentityId: home, ordinaryAccountSession: true,
          resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
          agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
        });
      const control = boundary.control;
      if (!control) throw new Error('Installed daemon control boundary was not started');
      await assertStartupFailureThroughCli({ preparationCode: 'provider_endpoint_auth_required', settlementKind: 'returned',
        expectedRetryable: false,
        sessionId: h.sessionId,
        // This raw refusal has no declared phase; the shared startup classifier owns it.
        expectedFailureCause: { phase: 'client_start', failureReason: 'authentication_required', providerErrorCode: -32000 },
        publishFailure: async persist => {
          const runtime = await runInstalledFirstConversationRuntime({ fixture: h, homeServerIdentityId: home, control,
            persistTurnMutation: persist });
          await Promise.race([runtime.failed.promise, runtime.outcome]);
          await runtime.stop();
          await runtime.outcome.catch(() => undefined);
          expect(runtime.assistant).toEqual([]);
          expect(runtime.turns).toContainEqual(expect.objectContaining({ action: 'fail',
            issue: expect.objectContaining({ code: 'provider_endpoint_auth_required', source: 'auth_error',
              sanitizedPreview: 'Sign in to Conversation fixture or choose a Conversation fixture account.',
              failureCause: expect.objectContaining({ failureReason: 'authentication_required', providerErrorCode: -32000 }) }) }));
          // A definite native rejection settles without repeating session/new
          // or admitting the initial prompt.
          expect(JSON.parse(await readFile(join(directory, 'host-refused.json'), 'utf8'))).toEqual(['initialize', 'session/new']);
        } });
    } finally {
      lifetime.abort(); publications.dispose();
    }
  });
});

it.each(['authentication', 'thread_open', 'turn'] as const)('retains the shared classifier cause through ACP diagnostics (%s)', phase => {
  const failureCause = { phase, failureReason: 'authentication_required' as const, providerErrorCode: -32000,
    providerErrorMessage: 'Authentication required token=synthetic-private-token' };
  const error = Object.assign(new Error('Authentication required'), { code: -32000, details: { failureCause } });
  const issue = classifyPrimarySessionRuntimeIssue({ cause: 'status_error', fallbackSource: 'agent_session_error', error });
  const diagnostic = createPublicAcpDiagnostic('acp_turn_failed', error.message, error);
  expect(diagnostic.details).toMatchObject({ v: 1, source: issue.source, failureCause: issue.failureCause });
  expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: diagnostic }).failureCause).toEqual(issue.failureCause);
  expect(JSON.stringify(diagnostic)).not.toContain('synthetic-private-token');
});
