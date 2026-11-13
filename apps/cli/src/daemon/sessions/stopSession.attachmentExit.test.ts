import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import type { TerminalHostAdapter } from '@happier-dev/agents';
import { configuration, reloadConfiguration } from '@/configuration';
import { createTerminalAttachmentId, readTerminalHostAttachmentState, writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { readProcessIdentityByPid } from '../processIdentity';
import type { TrackedSession } from '../types';
import { createStopSession } from './stopSession';
import { retireExactTerminalControlServiceability } from './retireTerminalControlServiceability';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  reloadConfiguration();
});

describe('Stop attachment retirement after real runner exit', () => {
  it.skipIf(process.platform === 'win32').each([
    { lifecycle: 'owned' as const, descriptor: 'absent' as const, serviceabilitySuperseded: false },
    { lifecycle: 'borrowed' as const, descriptor: 'absent' as const, serviceabilitySuperseded: false },
    { lifecycle: 'borrowed' as const, descriptor: 'unreadable' as const, serviceabilitySuperseded: false },
    ...((process.getuid?.() === 0) ? [] : [{ lifecycle: 'borrowed' as const, descriptor: 'present-readonly' as const, serviceabilitySuperseded: false }]),
    { lifecycle: 'owned' as const, descriptor: 'absent' as const, serviceabilitySuperseded: true },
    { lifecycle: 'borrowed' as const, descriptor: 'absent' as const, serviceabilitySuperseded: true },
  ])('handles $lifecycle runner-exit descriptor $descriptor with superseded serviceability=$serviceabilitySuperseded', async ({ lifecycle, descriptor, serviceabilitySuperseded }) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-stop-attachment-exit-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    reloadConfiguration();
    const sessionId = `real-runner-${lifecycle}-${descriptor}`;
    const attachmentId = createTerminalAttachmentId();
    const events: string[] = [];
    const adapter: TerminalHostAdapter = {
      kind: 'herdr',
      createOrAttachHost: async () => { throw new Error('not a launch'); },
      injectUserPrompt: async () => { throw new Error('not a prompt'); },
      interruptTurn: async () => undefined,
      evaluateLiveness: async () => ({ paneAlive: true, observedAt: Date.now() }),
      // Genuine external terminal-host OS boundary; never close a borrowed pane.
      dispose: async () => { events.push('dispose'); },
    };
    const attachment = await writeTerminalHostAttachmentInfo({
      happyHomeDir: configuration.happyHomeDir,
      sessionId,
      lifecycle,
      handle: {
        attachmentId, kind: 'herdr', sessionName: 'default', paneId: 'pane-owned', terminalId: 'terminal-owned',
        socketPath: join(home, 'herdr.sock'),
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
      },
    });
    // A real runner performs its ordinary exit cleanup before Stop observes exit.
    const child = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => {
        const fs = require('node:fs');
        if (process.argv[2] === 'unreadable') fs.writeFileSync(process.argv[1], '{');
        else if (process.argv[2] !== 'present-readonly') fs.unlinkSync(process.argv[1]);
        process.exit(0);
      });
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `, join(home, 'terminal', 'sessions', `${sessionId}.host.json`), descriptor], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      if (!child.stdout) throw new Error('missing runner stdout');
      await once(child.stdout, 'data');
      if (!child.pid) throw new Error('missing runner PID');
      const identity = await readProcessIdentityByPid(child.pid);
      if (typeof identity?.processStartTimeMs !== 'number') throw new Error('missing real process generation');
      const tracked: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(child.pid), startedBy: 'daemon', pid: child.pid, childProcess: child, happySessionId: sessionId,
        processStartTimeMs: identity.processStartTimeMs,
        spawnOptions: { directory: home, terminal: { mode: 'herdr' } },
      };
      if (serviceabilitySuperseded) {
        // Genuine HTTP boundary: the canonical metadata retirement owner sees
        // a replacement attachment, rather than mocking its typed outcome.
        const responseBase = { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
        vi.spyOn(axios, 'get')
          .mockResolvedValueOnce({ ...responseBase, data: { session: createSessionRecordFixture({
            id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 0,
            metadata: JSON.stringify({ path: '/repo', terminal: { mode: 'herdr', controlServiceabilityV1: {
              v: 1, attachmentId: 'replacement-attachment', state: 'servable', observedAt: 1,
            } } }), metadataVersion: 4, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
          }) } })
          .mockResolvedValueOnce({ ...responseBase, data: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          } });
      }
      const stop = createStopSession({
        trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
        terminalHostAdapters: { herdr: adapter },
        expectedTerminalAttachmentId: attachment.attachmentId,
        ...(serviceabilitySuperseded ? {
          retireExactTerminalControlServiceability: ({ attachmentInfo, terminalMode }) => retireExactTerminalControlServiceability({
            credentials: { token: 'test-token', encryption: null }, sessionId,
            attachmentId: attachmentInfo.attachmentId, terminalMode,
          }),
        } : {}),
        // Actual process observation, not a mocked domain exit decision.
        waitForTrackedRunnersExit: async () => {
          await exited;
          events.push('exited');
          if (descriptor === 'present-readonly') await chmod(join(home, 'terminal', 'sessions'), 0o500);
          return true;
        },
      });
      await expect(stop(sessionId)).resolves.toEqual(descriptor === 'unreadable'
        ? { status: 'incomplete', reason: 'missing_topology_proof' }
        : descriptor === 'present-readonly'
          ? { status: 'incomplete', reason: 'terminal_attachment_descriptor_retirement_failed' }
        : { status: 'stopped' });
      expect(events).toEqual(lifecycle === 'owned' ? ['exited', 'dispose'] : ['exited']);
      await expect(readTerminalHostAttachmentState({ happyHomeDir: home, sessionId })).resolves.toMatchObject({
        status: descriptor === 'present-readonly' ? 'present' : descriptor,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await chmod(join(home, 'terminal', 'sessions'), 0o700);
      await rm(home, { recursive: true, force: true });
    }
  });
});
