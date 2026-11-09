import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { SUPPORTED_SCHEMA_VERSION } from '@/persistence';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { handleAttachCommand } from './attach';

// Keep the command, bridge, eligibility and runtime registry real. Only the
// filesystem, HTTP and OS terminal boundaries are supplied below.
describe('CLI attach without a daemon plugin runtime in its process', () => {
  it.each(['herdr', 'tmux', 'zellij', 'windows_terminal', 'windows_console'] as const)(
    'attaches the synced unified terminal (%s)', async mode => {
      const sessionId = 'unified-terminal-metadata-only';
      const terminal: NonNullable<Metadata['terminal']> = mode === 'herdr'
        ? { mode, herdr: { sessionName: 'work', socketPath: '/fixture/terminal.sock', paneId: 'pane', terminalId: 'terminal' } }
        : mode === 'tmux' ? { mode, tmux: { target: 'work:1' } }
        : mode === 'zellij' ? { mode, zellij: { sessionName: 'work' } }
        : { mode, windows: { host: mode === 'windows_terminal' ? 'windows_terminal' : 'console', windowId: 'window', title: 'Session', pid: 1001 } };
      const row = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'claude', path: '/fixture', machineId: 'this-machine', startedBy: 'daemon', terminal }) });
      const attached: NonNullable<Metadata['terminal']>[] = [];
      const attach = async ({ terminal: selected }: { terminal: NonNullable<Metadata['terminal']> }) => {
        attached.push(selected);
        return 0;
      };

      await handleAttachCommand([sessionId], {
        readCredentialsFn: async () => ({ token: 'fixture-token', encryption: null }),
        fetchSessionByIdFn: async () => row,
        getAccountEncryptionCurrentnessFn: async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
        readSettingsFn: async () => ({ schemaVersion: SUPPORTED_SCHEMA_VERSION, onboardingCompleted: true, machineId: 'this-machine' }),
        readTerminalAttachmentInfoFn: async () => null,
        runHerdrAttachFn: attach, runTmuxAttachFn: attach, runZellijAttachFn: attach,
        runWindowsTerminalAttachFn: attach, runWindowsConsoleAttachFn: attach,
      });
      expect(attached).toEqual([terminal]);
    });
});
