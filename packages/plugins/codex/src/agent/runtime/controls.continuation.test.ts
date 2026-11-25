import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionControlContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentNativeLaunchQualifier, ExecService } from '@happier-dev/plugin-sdk/exec';
import type { PluginProtocolClientKind, PluginProtocolClientSpecByKind } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { projectProviderSessionFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { AgentRuntimeDiagnosticDataV1Schema } from '@happier-dev/protocol/runtime/agentRuntimeDiagnosticV1';
import { createStablePluginExecService, issueAgentNativeLaunchQualifierForHost } from '../../../../../../apps/cli/src/plugins/runtime/invocation/services/exec';

import { createCodexNativeAppServerClient } from './appServer/client.js';
import { withCodexNativeAttachFixture } from './appServer/runtime.nativeAttach.test-support.js';
import { CODEX_SUPPORTED_RUNTIME_VERSION } from '../cli/supportedRuntime.js';
import { createCodexNativeSessionControls } from './controls.js';

describe('Codex continuation native failure evidence', () => {
  it.skipIf(process.platform !== 'linux')('reads the retained member thread after Stop and Start with daemon launch roots', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      const memberHome = join(fixture.directory, 'member', 'native-home');
      const daemonHome = join(fixture.directory, 'daemon', 'codex');
      await Promise.all([memberHome, daemonHome].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
      const memberEnv = { CODEX_HOME: memberHome, CODEX_SQLITE_HOME: memberHome };
      const daemonEnv = { CODEX_HOME: daemonHome, CODEX_SQLITE_HOME: daemonHome };
      // The process boundary substitutes a SQLite-backed native executable and the
      // member shim's environment projection. Actual Exec and JSON-RPC run below it.
      const child = createStablePluginExecService({
        environment: {}, signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        resolveExecutable: async () => ({ command: process.execPath, args: ['--no-warnings', '-e', `
          const { DatabaseSync } = require('node:sqlite');
          const { createInterface } = require('node:readline');
          const { join } = require('node:path');
          const pin = process.argv.find(arg => arg.startsWith('sqlite_home='));
          const root = pin ? JSON.parse(pin.slice('sqlite_home='.length)) : process.env.CODEX_SQLITE_HOME;
          if (root !== process.env.CODEX_HOME) {
            process.stderr.write('SQLite unable to open database file', () => process.exit(1));
          } else {
            const db = new DatabaseSync(join(root, 'state_5.sqlite'));
            db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY)');
            const input = createInterface({ input: process.stdin });
            input.on('close', () => db.close());
            input.on('line', line => {
              const { id, method, params } = JSON.parse(line);
              if (id === undefined) return;
              if (method === 'thread/start') db.prepare('INSERT INTO threads VALUES (?)').run(params.threadId);
              const thread = method === 'thread/read' ? db.prepare('SELECT id FROM threads WHERE id = ?').get(params.threadId) : null;
              const reply = method === 'thread/read' && !thread
                ? { error: { code: -32000, message: 'Thread unavailable' } }
                : { result: thread ?? {} };
              process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...reply }) + '\\n');
            });
          }
        `, '--'] }),
        resolvePath: async () => fixture.directory,
      });
      const spawn: ExecService['clients']['spawn'] = <K extends PluginProtocolClientKind>(
        spec: PluginProtocolClientSpecByKind<K>,
        options?: { signal?: AbortSignal; nativeLaunch?: AgentNativeLaunchQualifier },
      ) => child.clients.spawn<K>(
        options?.nativeLaunch ? { ...spec, launch: { ...spec.launch, env: memberEnv } } : spec,
        options?.signal ? { signal: options.signal } : undefined,
      );
      const exec = { ...fixture.exec, clients: { ...fixture.exec.clients, spawn } };
      const threadId = '01a204bd-6690-7160-864e-3d8262d08290';
      const first = await createCodexNativeAppServerClient({ exec, processEnv: memberEnv, cwd: fixture.directory });
      try {
        await first.request('thread/start', { threadId });
        expect(await first.request('thread/read', { threadId })).toEqual({ id: threadId });
      } finally {
        await first.dispose();
      }
      const memberUid = process.getuid!() + 1;
      const nativeLaunch = issueAgentNativeLaunchQualifierForHost(exec, undefined, () => ({
        runtimeHome: join(fixture.directory, 'member'), environment: {}, selectedMaterials: [],
        nativeIdentity: { agentUid: memberUid, agentGid: memberUid, home: memberHome },
      }));
      const result = await createCodexNativeSessionControls().continuation.verify({
        kind: 'resume', sessionId: 'session-1', cwd: fixture.directory, providerSessionId: threadId,
      }, {
        signal: new AbortController().signal,
        services: { exec, logger: { warn: vi.fn(), debug: vi.fn() } },
        session: { id: 'session-1', cwd: fixture.directory, activity: 'inactive', connectedAccounts: [], nativeLaunch,
          launchEnvironment: { ...fixture.launchEnvironment, values: daemonEnv } },
      } as unknown as AgentSessionControlContext);
      expect(result).toEqual({ status: 'reachable' });
    });
  });

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
