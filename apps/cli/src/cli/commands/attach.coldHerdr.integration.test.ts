import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { SUPPORTED_SCHEMA_VERSION } from '@/persistence';
import { acquireSessionRunnerLock, sessionRunnerLockPathForSessionId } from '@/daemon/sessionRunnerLock';
import { createTerminalAttachmentId, writeTerminalAttachmentInfo, writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { Metadata } from '@/api/types';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const transport = vi.hoisted(() => ({ rpc: vi.fn(async () => false) }));
// Remote Session RPC is the genuine transport boundary. Eligibility, local
// owner metadata, locks and command dispatch below remain real.
vi.mock('@/session/transport/rpc/sessionRpc', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/sessionRpc')>(),
  callSessionRpc: transport.rpc,
}));

import { handleAttachCommand } from './attach';

describe('recorded Herdr restoration through shared native attachment', () => {
  it.each(['herdr', 'windows', 'windows-replaced'] as const)(
    'attaches only the current committed display after the controller Switch (%s)', async display => {
      const home = await mkdtemp(join(tmpdir(), 'happier-03-switch-attach-'));
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
      env.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      const sessionId = 'switched-shared-controller';
      const currentHerdr = { sessionName: 'work', socketPath: join(home, 'recorded.sock'),
        paneId: 'current-pane', terminalId: 'current-runtime-terminal' };
      const recordedWindows = { host: 'windows_terminal' as const, windowId: 'recorded-window', title: 'Recorded session', pid: 1001 };
      const terminal: NonNullable<Metadata['terminal']> = display === 'herdr'
        ? { mode: 'herdr', herdr: { sessionName: 'work', socketPath: join(home, 'recorded.sock'),
          paneId: 'old-pane', terminalId: 'old-runtime-terminal' } }
        : { mode: 'windows_terminal', windows: recordedWindows };
      const current: NonNullable<Metadata['terminal']> = display === 'herdr'
        ? { mode: 'herdr', herdr: currentHerdr }
        : { mode: 'windows_terminal', windows: { ...recordedWindows,
          ...(display === 'windows-replaced' ? { windowId: 'unrelated-window' } : {}) } };
      await writeTerminalAttachmentInfo({ happyHomeDir: home, sessionId, terminal });
      const row = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'opencode', path: home, machineId: 'this-machine', terminal,
          agentRuntimeCapabilitiesV1: { localControl: { supported: true, topology: 'shared', attachStrategy: 'provider_attach', remoteWritable: true } } }) });
      const lock = await acquireSessionRunnerLock({ happyHomeDir: home, sessionId, pid: process.pid });
      if (!lock.ok) throw new Error('Could not admit fixture controller');
      const attached: NonNullable<Metadata['terminal']>[] = [];
      transport.rpc.mockImplementation(async () => {
        // The remote controller is the boundary. Its successful receipt comes
        // after the real local attachment owner commits the selected display.
        if (display === 'herdr') await writeTerminalHostAttachmentInfo({ happyHomeDir: home, sessionId, lifecycle: 'owned',
          handle: { kind: 'herdr', ...currentHerdr, attachmentId: createTerminalAttachmentId(),
            attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } } });
        else await writeTerminalAttachmentInfo({ happyHomeDir: home, sessionId, terminal: current });
        return true;
      });
      try {
        const result = handleAttachCommand([sessionId], {
          readCredentialsFn: async () => ({ token: 'fixture-token', encryption: null }),
          fetchSessionByIdFn: async () => row,
          getAccountEncryptionCurrentnessFn: async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
          readSettingsFn: async () => ({ schemaVersion: SUPPORTED_SCHEMA_VERSION, onboardingCompleted: true, machineId: 'this-machine' }),
          runHerdrAttachFn: async ({ terminal: host }) => { attached.push(host); return 0; },
          runWindowsTerminalAttachFn: async ({ terminal: host }) => { attached.push(host); return 0; },
        });
        if (display === 'windows-replaced') {
          await expect(result).rejects.toThrow('no exact attachment');
          expect(attached).toEqual([]);
        } else {
          await expect(result).resolves.toBeUndefined();
          expect(attached).toHaveLength(1);
          expect(attached[0]).toMatchObject(current);
        }
      } finally {
        transport.rpc.mockImplementation(async () => false);
        await lock.release();
        env.restore(); reloadConfiguration();
        await rm(home, { recursive: true, force: true });
      }
    });

  it.each((['absent', 'present', 'unknown'] as const).flatMap(presence => [true, false].map(localDescriptor => ({ presence, localDescriptor }))))(
    'opens only a positively absent controller candidate without a switch RPC ($presence, local descriptor: $localDescriptor)', async ({ presence, localDescriptor }) => {
      const home = await mkdtemp(join(tmpdir(), 'happier-03-cold-attach-'));
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
      env.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      transport.rpc.mockClear();
      const sessionId = 'cold-shared-controller';
      const terminal = { mode: 'herdr' as const, herdr: { sessionName: 'work', socketPath: join(home, 'recorded.sock'),
        paneId: 'recorded-pane', terminalId: 'old-runtime-terminal' } };
      if (localDescriptor) await writeTerminalAttachmentInfo({ happyHomeDir: home, sessionId, terminal });
      const row = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'opencode', path: home, machineId: 'this-machine', startedBy: 'daemon', terminal,
          agentRuntimeCapabilitiesV1: { localControl: { supported: true, topology: 'shared', attachStrategy: 'provider_attach', remoteWritable: true } } }) });
      const lock = presence === 'present' ? await acquireSessionRunnerLock({ happyHomeDir: home, sessionId, pid: process.pid }) : null;
      if (lock && !lock.ok) throw new Error('Could not admit fixture controller');
      if (presence === 'unknown') {
        const path = sessionRunnerLockPathForSessionId({ happyHomeDir: home, sessionId });
        if (!path) throw new Error('Missing canonical lock path');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '{invalid');
      }
      const opened: string[] = [];
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('OS exit requested'); }) as typeof process.exit);
      try {
        const result = handleAttachCommand([sessionId], {
          readCredentialsFn: async () => ({ token: 'fixture-token', encryption: null }),
          fetchSessionByIdFn: async () => row,
          getAccountEncryptionCurrentnessFn: async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
          readSettingsFn: async () => ({ schemaVersion: SUPPORTED_SCHEMA_VERSION, onboardingCompleted: true, machineId: 'this-machine' }),
          runHerdrAttachFn: async ({ terminal: host }) => { opened.push(host.herdr?.paneId ?? ''); return 0; },
        });
        if (presence === 'absent') {
          await expect(result).resolves.toBeUndefined();
          expect(opened).toEqual(['recorded-pane']);
          expect(transport.rpc).not.toHaveBeenCalled();
        } else {
          await expect(result).rejects.toBeInstanceOf(Error);
          expect(opened).toEqual([]);
          expect(transport.rpc).toHaveBeenCalled();
        }
      } finally {
        exit.mockRestore();
        if (lock?.ok) await lock.release();
        env.restore();
        reloadConfiguration();
        await rm(home, { recursive: true, force: true });
      }
    });
});
