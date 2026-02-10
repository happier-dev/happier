import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonState, Machine, MachineMetadata } from '@/api/types';
import { MachineIdConflictError } from '../api';

vi.mock('@/ui/logger', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ensureMachineRegistered', () => {
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;

  afterEach(() => {
    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    if (previousActiveServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
    vi.resetModules();
  });

  it('rotates machine id and retries once on machine_id_conflict', async () => {
    // Defensive: other test files may enable fake timers and forget to restore them.
    // ensureMachineRegistered can perform real setTimeout-based retry/backoff work.
    vi.useRealTimers();

    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-machine-conflict-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';

    try {
      const oldMachineId = 'machine-old';
      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
              cloud: {
                id: 'cloud',
                name: 'cloud',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: {
              cloud: oldMachineId,
            },
            machineIdConfirmedByServerByServerId: {
              cloud: true,
            },
            lastChangesCursorByServerIdByAccountId: {},
          },
          null,
          2,
        ),
        'utf8',
      );

      vi.resetModules();
      const { readSettings } = await import('@/persistence');
      const { ensureMachineRegistered } = await import('./ensureMachineRegistered');

      const calls: string[] = [];
      const api = {
        getOrCreateMachine: async (opts: { machineId: string; metadata: MachineMetadata; daemonState?: DaemonState }): Promise<Machine> => {
          calls.push(opts.machineId);
          if (calls.length === 1) {
            throw new MachineIdConflictError(opts.machineId);
          }
          return {
            id: opts.machineId,
            encryptionKey: new Uint8Array(),
            encryptionVariant: 'legacy',
            metadata: opts.metadata,
            metadataVersion: 0,
            daemonState: opts.daemonState ?? null,
            daemonStateVersion: 0,
          };
        },
      };

      const { machine, machineId } = await ensureMachineRegistered({
        api: api as any,
        machineId: oldMachineId,
        metadata: { host: 'host1' } as any,
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe(oldMachineId);
      expect(calls[1]).not.toBe(oldMachineId);
      expect(machineId).toBe(calls[1]);
      expect(machine.id).toBe(calls[1]);

      const settings = await readSettings();
      expect(settings.machineId).toBe(calls[1]);
      expect(settings.machineIdConfirmedByServer).toBeUndefined();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not rotate again if another process already rotated the active server machine id', async () => {
    // Defensive: other test files may enable fake timers and forget to restore them.
    vi.useRealTimers();

    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-machine-conflict-cas-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';

    try {
      const staleMachineId = 'machine-stale';
      const alreadyRotated = 'machine-rotated-by-other-process';
      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
              cloud: {
                id: 'cloud',
                name: 'cloud',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: {
              cloud: alreadyRotated,
            },
            machineIdConfirmedByServerByServerId: {
              cloud: true,
            },
            lastChangesCursorByServerIdByAccountId: {},
          },
          null,
          2,
        ),
        'utf8',
      );

      vi.resetModules();
      const { readSettings } = await import('@/persistence');
      const { ensureMachineRegistered } = await import('./ensureMachineRegistered');

      const calls: string[] = [];
      const api = {
        getOrCreateMachine: async (opts: { machineId: string; metadata: MachineMetadata; daemonState?: DaemonState }): Promise<Machine> => {
          calls.push(opts.machineId);
          if (calls.length === 1) {
            throw new MachineIdConflictError(opts.machineId);
          }
          return {
            id: opts.machineId,
            encryptionKey: new Uint8Array(),
            encryptionVariant: 'legacy',
            metadata: opts.metadata,
            metadataVersion: 0,
            daemonState: opts.daemonState ?? null,
            daemonStateVersion: 0,
          };
        },
      };

      const { machine, machineId } = await ensureMachineRegistered({
        api: api as any,
        machineId: staleMachineId,
        metadata: { host: 'host1' } as any,
      });

      expect(calls).toEqual([staleMachineId, alreadyRotated]);
      expect(machineId).toBe(alreadyRotated);
      expect(machine.id).toBe(alreadyRotated);

      const settings = await readSettings();
      expect(settings.machineId).toBe(alreadyRotated);
      // Another process may have already confirmed the rotated id; do not clobber that state.
      expect(settings.machineIdConfirmedByServer).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
