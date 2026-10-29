import { afterEach, expect, it, vi } from 'vitest';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { readRetiredPlainRunnerObservation, retireObservedSessionRunnerMetadata } from './plainRunnerRetirement';

afterEach(() => vi.restoreAllMocks());

it.each(['plain runner', 'live process', 'terminal descriptor', 'hosted launch'] as const)(
  'publishes plain process absence only for proven plain topology (%s)', async topology => {
    await withConfiguredDaemonTestHome({ prefix: 'plain-retirement-proof-' }, async ({ homeDir }) => {
      // The process probe is an OS boundary; metadata projection and descriptor storage are real.
      vi.spyOn(process, 'kill').mockImplementation(() => {
        if (topology !== 'live process') throw Object.assign(new Error('Process absent'), { code: 'ESRCH' });
        return true;
      });
      const sessionId = 'plain-proof';
      if (topology === 'terminal descriptor') await writeTerminalHostAttachmentInfo({
        happyHomeDir: homeDir, sessionId, handle: { kind: 'zellij', sessionName: 'retained-host',
          paneId: 'terminal_1', socketDir: homeDir, attachMetadata: { attachStrategy: 'terminal_host',
            topology: 'shared', locality: 'same_machine', liveProbe: 'required' } },
      });
      const metadata = { hostPid: 1234, hostProcessStartTimeMs: 1, lifecycleState: 'running', lifecycleStateSince: 1 };
      const retired = await retireObservedSessionRunnerMetadata({ metadata, sessionId, happyHomeDir: homeDir,
        expectedRunner: { pid: 1234, startTimeMs: 1 }, trackedSession: { pid: 1234, startedBy: 'daemon',
          ...(topology === 'hosted launch' ? { hostedTerminal: { mode: 'tmux' } } : {}) },
      });
      expect(retired).not.toHaveProperty('hostPid');
      expect(retired).not.toHaveProperty('lifecycleState');
      if (topology === 'plain runner') {
        expect(readRetiredPlainRunnerObservation(retired)).toEqual(expect.any(Number));
        expect(retired.terminal).toMatchObject({ mode: 'plain', controlServiceabilityV1: { retired: true } });
        expect(await retireObservedSessionRunnerMetadata({ metadata: retired, sessionId, happyHomeDir: homeDir,
          expectedRunner: { pid: 1234, startTimeMs: 1 }, trackedSession: { pid: 1234, startedBy: 'daemon' },
        })).toBe(retired);
      } else {
        expect(readRetiredPlainRunnerObservation(retired)).toBeNull();
        expect(retired).not.toHaveProperty('terminal');
      }
    });
  });
