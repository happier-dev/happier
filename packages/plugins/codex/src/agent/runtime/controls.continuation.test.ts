import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionControlContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeDiagnosticDataV1Schema } from '@happier-dev/protocol/runtime/agentRuntimeDiagnosticV1';

import { withCodexNativeAttachFixture } from './appServer/runtime.nativeAttach.test-support.js';
import { createCodexNativeSessionControls } from './controls.js';

describe('Codex continuation native failure evidence', () => {
  it('retains only code/class evidence from a real JSON-RPC rejection and records it before host refusal', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      fixture.failRead();
      const warn = vi.fn();
      const context = {
        signal: new AbortController().signal,
        services: { exec: fixture.exec, logger: { warn, debug: vi.fn() } },
        session: { id: 'session-1', cwd: fixture.directory, activity: 'inactive', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
      } as unknown as AgentSessionControlContext;
      const result = await createCodexNativeSessionControls().continuation.verify({
        kind: 'resume', sessionId: 'session-1', cwd: fixture.directory, providerSessionId: 'fresh-thread',
      }, context);
      expect(result).toMatchObject({ status: 'unreachable', diagnostic: {
        code: 'codex_continuation_unreachable',
        details: { errorClass: 'JsonRpcApplicationError', errorCode: '-32000', httpStatus: null },
      } });
      expect(warn).toHaveBeenCalledWith('codex_continuation_unreachable', {
        errorClass: 'JsonRpcApplicationError', errorCode: '-32000', httpStatus: null,
      });
      if (result.status !== 'reachable') expect(AgentRuntimeDiagnosticDataV1Schema.safeParse(result.diagnostic).success).toBe(true);
      expect(JSON.stringify({ result, logs: warn.mock.calls })).not.toContain('rollout persistence failed');
      expect(fixture.requests.some(request => request.method === 'thread/resume')).toBe(false);
    });
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
        details: { errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null },
      } });
      expect(JSON.stringify({ result, logs: warn.mock.calls })).not.toMatch(/PRIVATE_TOKEN|private body/);
    });
  });
});
