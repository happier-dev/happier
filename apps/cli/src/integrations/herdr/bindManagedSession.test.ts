import { EventEmitter } from 'node:events';
import { Console } from 'node:console';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { bindHerdrAgentIfNeeded, bindManagedHerdrSession, createHerdrResumeArgv } from './bindManagedSession';
import { logger } from '@/ui/logger';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

function createLifecycleSession() {
  return Object.assign(new EventEmitter(), { getAgentStateSnapshot: () => null });
}

describe('bindManagedHerdrSession', () => {
  it.each(['retired', 'replacement'] as const)('retires only the old terminal reporter after optional presentation %s', async transition => {
    const terminal = { mode: 'herdr' as const, herdr: { sessionName: 'work', socketPath: '/external/socket', terminalId: 'old-terminal' },
      controlServiceabilityV1: { v: 1 as const, state: 'servable' as const, attachmentId: 'old-attachment', observedAt: 1 } };
    let metadata = createTestMetadata({ terminal });
    const session = Object.assign(createLifecycleSession(), { getMetadataSnapshot: () => metadata });
    const request = vi.fn(async (_method: string, _params: unknown) => ({}));
    bindManagedHerdrSession({ session, client: {
      findPane: async () => ({ paneId: 'old-pane', terminalId: 'old-terminal', workspaceId: 'work', tabId: 'tab' }), request,
    }, terminalId: 'old-terminal', agent: 'codex', sessionId: 'optional-session', preserveHostOnClose: true });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('pane.report_agent', expect.anything()));
    metadata = { ...metadata, terminal: transition === 'retired'
      ? { ...terminal, controlServiceabilityV1: { ...terminal.controlServiceabilityV1, retired: true } }
      : { ...terminal, herdr: { ...terminal.herdr, terminalId: 'new-terminal' } } };
    session.emit('metadata-updated');
    expect(session.listenerCount('local-presence')).toBe(0);
    expect(session.listenerCount('metadata-updated')).toBe(0);
    session.emit('local-presence', { thinking: true });
    await Promise.resolve();
    expect(request).not.toHaveBeenCalledWith('pane.release_agent', expect.anything());
    expect(request.mock.calls.filter(([method]) => method === 'pane.report_agent')).toHaveLength(1);
  });
  it('records failed Herdr reporting in the file without writing to the agent terminal', async () => {
    logger.flushSync();
    const previousLogLength = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8').length : 0;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    // Vitest buffers console output; use Node's real console to exercise the OS stream boundary.
    const nodeConsole = new Console({ stdout: process.stdout, stderr: process.stderr });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(nodeConsole.log.bind(nodeConsole));
    try {
      bindManagedHerdrSession({
        session: createLifecycleSession(),
        client: {
          findPane: async () => ({ paneId: 'w1:p2', terminalId: 'term_42', workspaceId: 'w1', tabId: 'w1:t1' }),
          // Herdr is an external process boundary; preserve the real reporter and logger beneath it.
          request: async () => { throw new Error('private-launch-credential'); },
        },
        terminalId: 'term_42',
        agent: 'codex',
        sessionId: 'session-report-failed',
      });
      await vi.waitFor(() => {
        logger.flushSync();
        const diagnostic = readFileSync(logger.getLogPath(), 'utf8').slice(previousLogLength);
        expect(diagnostic).toContain('[herdr] Failed to report managed agent state');
        expect(stdout).not.toHaveBeenCalled();
        expect(diagnostic).not.toContain('private-launch-credential');
      });
    } finally {
      consoleLog.mockRestore();
      stdout.mockRestore();
    }
  });

  it.each([
    { heldPhase: 'report', endSession: false },
    { heldPhase: 'release', endSession: false },
    { heldPhase: 'release', endSession: true },
  ] as const)('preserves reporter lifetime with predecessor $heldPhase pending and session closed=$endSession', async ({ heldPhase, endSession }) => {
    let terminal: NonNullable<ReturnType<typeof createTestMetadata>['terminal']> = {
      mode: 'herdr',
      herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_42' },
    };
    const session = Object.assign(createLifecycleSession(), {
      getMetadataSnapshot: () => createTestMetadata({ terminal }),
    });
    let finishHeldRequest!: () => void;
    const heldRequest = new Promise<void>((resolve) => { finishHeldRequest = resolve; });
    let reports = 0;
    let releaseStarted = false;
    let releaseCompleted = false;
    let reported = false;
    // Herdr transport is the external boundary. Its delayed completion must
    // not let predecessor cleanup erase the replacement's agent/resume state.
    const params = {
      session,
      client: {
        findPane: async () => ({ paneId: 'w1:p2', terminalId: 'term_42', workspaceId: 'w1', tabId: 'w1:t1' }),
        request: async (method: string) => {
          if (method === 'pane.report_agent') {
            reports += 1;
            reported = true;
            if (heldPhase === 'report' && reports === 1) await heldRequest;
          } else if (method === 'pane.release_agent') {
            releaseStarted = true;
            if (heldPhase === 'release') await heldRequest;
            reported = false;
            releaseCompleted = true;
          }
          return {};
        },
      },
      terminalId: 'term_42', agent: 'codex', sessionId: 'session-rebound',
    };
    try {
      bindManagedHerdrSession(params);
      await vi.waitFor(() => expect(reports).toBe(1));
      terminal = { ...terminal, controlServiceabilityV1: { v: 1, attachmentId: 'old-attachment',
        state: 'unknown', observedAt: 1, retired: true, reason: 'attachment_retired' } };
      session.emit('metadata-updated');
      if (heldPhase === 'release') await vi.waitFor(() => expect(releaseStarted).toBe(true));
      terminal = { ...terminal, controlServiceabilityV1: { v: 1, attachmentId: 'new-attachment',
        state: 'unknown', observedAt: 2 } };
      bindManagedHerdrSession(params);
      if (endSession) session.emit('local-closed');
      finishHeldRequest();
      await vi.waitFor(() => {
        expect(releaseCompleted).toBe(true);
        if (!endSession) expect(reports).toBe(2);
        expect(reported).toBe(!endSession);
      });
      if (endSession) expect(session.listenerCount('local-presence')).toBe(0);
    } finally {
      finishHeldRequest();
      session.emit('local-closed');
    }
  });

  it('uses the installed release-channel command for Herdr cold restore', () => {
    expect(createHerdrResumeArgv('session-123', 'stable')).toEqual(['happier', '--runtime-context', expect.any(String), 'resume', 'session-123']);
    expect(createHerdrResumeArgv('session-123', 'preview')).toEqual(['hprev', '--runtime-context', expect.any(String), 'resume', 'session-123']);
    expect(createHerdrResumeArgv('session-123', 'publicdev')).toEqual(['hdev', '--runtime-context', expect.any(String), 'resume', 'session-123']);
  });

  it('reports the exact terminal, follows session presence, and releases it on close', async () => {
    const session = createLifecycleSession();
    const request = vi.fn(async () => ({}));
    const client = {
      findPane: vi.fn(async () => ({ paneId: 'w1:p2', terminalId: 'term_42', workspaceId: 'w1', tabId: 'w1:t1' })),
      request,
    };
    bindManagedHerdrSession({
      session,
      client,
      terminalId: 'term_42',
      agent: 'codex',
      sessionId: 'session-123',
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('pane.report_agent', expect.objectContaining({
      pane_id: 'w1:p2', source: 'happier', agent: 'codex', state: 'idle',
      resume_argv: ['happier', '--runtime-context', expect.any(String), 'resume', 'session-123'],
    })));
    session.emit('local-presence', { thinking: true, mode: 'remote' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('pane.report_agent', expect.objectContaining({ state: 'working' })));
    session.emit('local-closed');
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('pane.release_agent', {
      pane_id: 'w1:p2', source: 'happier', agent: 'codex',
    }));
  });

  it('keeps one lifecycle reporter when the same session terminal is bound twice', async () => {
    const session = createLifecycleSession();
    const request = vi.fn(async () => ({}));
    const params = {
      session,
      client: {
        findPane: vi.fn(async () => ({ paneId: 'w1:p2', terminalId: 'term_42', workspaceId: 'w1', tabId: 'w1:t1' })),
        request,
      },
      terminalId: 'term_42',
      agent: 'claude',
      sessionId: 'session-123',
    } as const;

    bindManagedHerdrSession(params);
    bindManagedHerdrSession(params);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    session.emit('local-presence', { thinking: true, mode: 'remote' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith('pane.report_agent', expect.objectContaining({ state: 'working' }));
  });

  it('reuses the daemon-bound attachment when a hosted runner only knows its Herdr mode', async () => {
    const session = createLifecycleSession();
    const request = vi.fn(async () => ({}));
    await bindHerdrAgentIfNeeded({
      session,
      sessionId: 'session-hosted',
      agent: 'codex',
      terminal: { mode: 'herdr' },
      client: {
        findPane: async () => ({ paneId: 'w1:p2', terminalId: 'term_42', workspaceId: 'w1', tabId: 'w1:t1' }),
        request,
      },
      readTerminalAttachmentInfoFn: async () => ({
        version: 1,
        sessionId: 'session-hosted',
        terminal: {
          mode: 'herdr',
          herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_42' },
        },
        updatedAt: 1,
      }),
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('pane.report_agent', expect.objectContaining({
      pane_id: 'w1:p2', agent: 'codex', resume_argv: ['happier', '--runtime-context', expect.any(String), 'resume', 'session-hosted'],
    })));
  });

  it('preserves a recoverable provider pane when its controller closes', async () => {
    const session = createLifecycleSession();
    const request = vi.fn(async () => ({}));
    bindManagedHerdrSession({
      session,
      client: {
        findPane: async () => ({ paneId: 'w1:p2', terminalId: 'term_42', workspaceId: 'w1', tabId: 'w1:t1' }),
        request,
      },
      terminalId: 'term_42',
      agent: 'claude',
      sessionId: 'session-123',
      preserveHostOnClose: true,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('pane.report_agent', expect.anything()));
    session.emit('local-closed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(request).not.toHaveBeenCalledWith('pane.release_agent', expect.anything());
  });
});
