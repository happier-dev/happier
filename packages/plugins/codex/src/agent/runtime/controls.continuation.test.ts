import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionControlContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { projectProviderSessionFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { AgentRuntimeDiagnosticDataV1Schema } from '@happier-dev/protocol/runtime/agentRuntimeDiagnosticV1';

import { withCodexNativeAttachFixture } from './appServer/runtime.nativeAttach.test-support.js';
import { CODEX_SUPPORTED_RUNTIME_VERSION } from '../cli/supportedRuntime.js';
import { createCodexNativeSessionControls } from './controls.js';

describe('Codex continuation native failure evidence', () => {
  it('logs the retained thread and app-server launch facts on a rejected lookup', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      fixture.failRead();
      const warn = vi.fn();
      const threadId = '01a204bd-6690-7160-864e-3d8262d08290';
      const sqliteHome = join(fixture.directory, 'sqlite');
      const launchEnvironment = { ...fixture.launchEnvironment, values: {
        CODEX_HOME: join(fixture.directory, 'requested-home'), CODEX_SQLITE_HOME: sqliteHome, OPENAI_API_KEY: 'PRIVATE_LAUNCH_VALUE',
      } };
      const context = {
        signal: new AbortController().signal,
        services: { exec: fixture.exec, logger: { warn, debug: vi.fn() } },
        session: { id: 'session-1', cwd: fixture.directory, activity: 'inactive', connectedAccounts: [], launchEnvironment },
      } as unknown as AgentSessionControlContext;
      const result = await createCodexNativeSessionControls().continuation.verify({
        kind: 'resume', sessionId: 'session-1', cwd: fixture.directory, providerSessionId: threadId,
      }, context);
      expect(result).toMatchObject({ status: 'unreachable', diagnostic: {
        code: 'codex_continuation_unreachable',
        details: { failureCause: {
          phase: 'codex.thread_read', errorClass: 'JsonRpcApplicationError', errorCode: '-32000', httpStatus: null,
        } },
      } });
      expect(warn).toHaveBeenCalledWith('codex_continuation_unreachable', {
        phase: 'codex.thread_read', errorClass: 'JsonRpcApplicationError', errorCode: '-32000', httpStatus: null,
        threadId, executablePath: '/fixture/codex', nativeVersion: CODEX_SUPPORTED_RUNTIME_VERSION,
        codexHome: fixture.directory, requestedSqliteHome: sqliteHome,
      });
      if (result.status !== 'reachable') expect(AgentRuntimeDiagnosticDataV1Schema.safeParse(result.diagnostic).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain(threadId);
      expect(JSON.stringify(result)).not.toContain(fixture.directory);
      expect(JSON.stringify({ result, logs: warn.mock.calls })).not.toMatch(/rollout persistence failed|PRIVATE_LAUNCH_VALUE/);
      expect(fixture.requests.some(request => request.method === 'thread/resume')).toBe(false);
    });
  });

  it('omits opaque thread handles from lookup logs', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      fixture.failRead();
      const warn = vi.fn();
      const context = {
        signal: new AbortController().signal,
        services: { exec: fixture.exec, logger: { warn, debug: vi.fn() } },
        session: { id: 'session-1', cwd: fixture.directory, activity: 'inactive', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
      } as unknown as AgentSessionControlContext;
      const result = await createCodexNativeSessionControls().continuation.verify({
        kind: 'resume', sessionId: 'session-1', cwd: fixture.directory, providerSessionId: 'PRIVATE_OPAQUE_HANDLE',
      }, context);
      expect(result.status).toBe('unreachable');
      expect(warn).toHaveBeenCalledWith('codex_continuation_unreachable', expect.objectContaining({
        phase: 'codex.thread_read', requestedSqliteHome: null,
      }));
      expect(JSON.stringify({ result, logs: warn.mock.calls })).not.toContain('PRIVATE_OPAQUE_HANDLE');
    });
  });

  it.each([
    {
      title: 'RPC rejection', options: { initializeFailure: { code: -32000, message: 'Initialization failed: api_key=PRIVATE_INITIALIZE' } },
      errorClass: 'JsonRpcApplicationError', errorCode: '-32000', nativeErrorReason: 'stderr_unavailable',
      localMessage: 'Initialization failed',
    },
    {
      title: 'native child exit', options: { nativeProxyStderr: 'SQLite initialization failed: unable to open database file; api_key=PRIVATE_INITIALIZE' },
      errorClass: 'Error', errorCode: expect.stringMatching(/^PLUGIN_EXEC_CLIENT_(EXITED|PROTOCOL_ERROR|WRITE_FAILED)$/u),
      nativeErrorReason: 'stderr_sqlite',
      localMessage: 'SQLite initialization failed',
    },
  ])('retains safe diagnostics on initialize failure after $title', async ({ title, options, localMessage, ...expected }) => {
    await withCodexNativeAttachFixture(async fixture => {
      const warn = vi.fn();
      const debug = vi.fn();
      const launchEnvironment = { ...fixture.launchEnvironment, values: {
        HOME: fixture.directory, USERPROFILE: fixture.directory, CODEX_HOME: join(fixture.directory, 'private-native-home'),
        CODEX_SQLITE_HOME: join(fixture.directory, 'private-sqlite-root'),
      } };
      const context = {
        signal: new AbortController().signal,
        services: { exec: fixture.exec, logger: { warn, debug } },
        session: { id: 'session-1', cwd: fixture.directory, activity: 'inactive', connectedAccounts: [], launchEnvironment },
      } as unknown as AgentSessionControlContext;
      const result = await createCodexNativeSessionControls().continuation.verify({
        kind: 'resume', sessionId: 'session-1', cwd: fixture.directory, providerSessionId: 'fresh-thread',
      }, context);
      const digest = (relativePath: string) => createHash('sha256').update(relativePath).digest('hex');
      const actionCause = {
        phase: 'codex.app_server_initialize', httpStatus: null, ...expected,
        codexLaunchPathIdentity: { codexHome: digest('private-native-home'), sqliteHome: digest('private-sqlite-root') },
      };
      expect(result).toMatchObject({ status: 'unreachable', diagnostic: {
        code: 'codex_continuation_unreachable', details: { failureCause: actionCause },
      } });
      if (result.status === 'reachable') throw new Error('Expected an initialization refusal');
      const diagnostic = AgentRuntimeDiagnosticDataV1Schema.parse(result.diagnostic);
      expect(projectProviderSessionFailureCause(diagnostic, 'client_start', { diagnosticCode: diagnostic.code }))
        .toMatchObject({ phase: 'client_start', actionCause });
      expect(fixture.requests.some(request => request.method === 'thread/read')).toBe(false);
      expect(JSON.stringify({ result, warnings: warn.mock.calls })).not.toMatch(/PRIVATE_INITIALIZE|private-native-home|private-sqlite-root|Initialization failed|unable to open database file/i);
      expect(JSON.stringify(debug.mock.calls)).toContain(localMessage);
      expect(JSON.stringify(debug.mock.calls)).not.toContain('PRIVATE_INITIALIZE');
    }, options);
  });

  it('reads the thread through the target Session native launch identity, as its runtime does', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      // On a separated-users Machine only the member UID can read its 0700 native home.
      // Process creation is the system boundary; the continuation owner stays real.
      const nativeLaunch = Object.freeze({}) as never;
      const launches: unknown[] = [];
      const exec = { ...fixture.exec, clients: { ...fixture.exec.clients, spawn: async (request: never, options?: { nativeLaunch?: unknown }) => {
        launches.push(options?.nativeLaunch);
        return await (fixture.exec.clients.spawn as (request: never, options?: unknown) => Promise<unknown>)(request, options);
      } } };
      const context = {
        signal: new AbortController().signal, services: { exec, logger: { warn: vi.fn(), debug: vi.fn() } },
        session: { id: 'session-1', cwd: fixture.directory, activity: 'inactive', connectedAccounts: [],
          launchEnvironment: fixture.launchEnvironment, nativeLaunch },
      } as unknown as AgentSessionControlContext;
      const result = await createCodexNativeSessionControls().continuation.verify({
        kind: 'resume', sessionId: 'session-1', cwd: fixture.directory, providerSessionId: 'fresh-thread',
      }, context);
      expect(result).toEqual({ status: 'reachable' });
      expect(launches).toEqual([nativeLaunch]);
    });
  });

  it('retains a transport code without publishing upstream prose, data or credentials', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      const warn = vi.fn();
      // Process/IPC creation is the system boundary; the continuation owner stays real.
      const exec = { ...fixture.exec, clients: { ...fixture.exec.clients, spawn: async () => {
        throw Object.assign(new Error('PRIVATE_TOKEN and private body'), {
          code: 'ECONNRESET', data: { secret: 'PRIVATE_TOKEN' },
        });
      } } };
      const context = {
        signal: new AbortController().signal, services: { exec, logger: { warn, debug: vi.fn() } },
        session: { id: 'session-1', cwd: fixture.directory, activity: 'inactive', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
      } as unknown as AgentSessionControlContext;
      const result = await createCodexNativeSessionControls().continuation.verify({
        kind: 'resume', sessionId: 'session-1', cwd: fixture.directory, providerSessionId: 'fresh-thread',
      }, context);
      expect(result).toMatchObject({ status: 'unreachable', diagnostic: {
        details: { failureCause: {
          phase: 'codex.app_server_spawn', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null,
        } },
      } });
      expect(JSON.stringify({ result, logs: warn.mock.calls })).not.toMatch(/PRIVATE_TOKEN|private body/);
    });
  });
});
