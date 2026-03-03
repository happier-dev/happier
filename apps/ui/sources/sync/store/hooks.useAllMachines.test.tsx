import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useAllMachines, useMachineListByServerId } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushEffects(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('useAllMachines', () => {
  it('includes offline machines and sorts online machines first', async () => {
    const previousState = storage.getState();
    try {
      storage.setState((state) => ({
        ...state,
        isDataReady: true,
        machines: {
          'm-online': {
            id: 'm-online',
            seq: 1,
            createdAt: 1000,
            updatedAt: 1000,
            active: true,
            activeAt: 1000,
            metadata: { host: 'online', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
          },
          'm-offline': {
            id: 'm-offline',
            seq: 1,
            createdAt: 2000,
            updatedAt: 2000,
            active: false,
            activeAt: 2000,
            metadata: { host: 'offline', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
          },
        },
      }));

      const seen: string[][] = [];

      function Test() {
        const machines = useAllMachines();
        React.useEffect(() => {
          seen.push(machines.map((m) => m.id));
        }, [machines]);
        return null;
      }

      let tree: renderer.ReactTestRenderer | null = null;
      await act(async () => {
        tree = renderer.create(React.createElement(Test));
        await flushEffects(4);
      });

      expect(seen.at(-1)).toEqual(['m-online', 'm-offline']);

      await act(async () => {
        tree?.unmount();
        await flushEffects(2);
      });
    } finally {
      storage.setState(previousState);
    }
  });

  it('excludes revoked machines from visible machine lists', async () => {
    const previousState = storage.getState();
    try {
      storage.setState((state) => ({
        ...state,
        isDataReady: true,
        machines: {
          'm-online': {
            id: 'm-online',
            seq: 1,
            createdAt: 1000,
            updatedAt: 1000,
            active: true,
            activeAt: 1000,
            metadata: { host: 'online', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            revokedAt: null,
          },
          'm-revoked': {
            id: 'm-revoked',
            seq: 1,
            createdAt: 1200,
            updatedAt: 1200,
            active: false,
            activeAt: 1200,
            metadata: { host: 'revoked', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            revokedAt: 1700000000000,
          },
        },
        machineListByServerId: {
          'server-a': [
            { id: 'm-online', active: true, activeAt: 1000, createdAt: 1000, updatedAt: 1000, metadata: { host: 'online' }, revokedAt: null } as any,
            { id: 'm-revoked', active: false, activeAt: 1200, createdAt: 1200, updatedAt: 1200, metadata: { host: 'revoked' }, revokedAt: 1700000000000 } as any,
          ],
        },
      }));

      const seenAll: string[][] = [];
      const seenByServer: string[][] = [];

      function Test() {
        const machines = useAllMachines();
        const machineListByServerId = useMachineListByServerId();
        React.useEffect(() => {
          seenAll.push(machines.map((m) => m.id));
          const serverMachines = machineListByServerId['server-a'] ?? [];
          seenByServer.push(serverMachines.map((m) => m.id));
        }, [machines, machineListByServerId]);
        return null;
      }

      let tree: renderer.ReactTestRenderer | null = null;
      await act(async () => {
        tree = renderer.create(React.createElement(Test));
        await flushEffects(4);
      });

      expect(seenAll.at(-1)).toEqual(['m-online']);
      expect(seenByServer.at(-1)).toEqual(['m-online']);

      await act(async () => {
        tree?.unmount();
        await flushEffects(2);
      });
    } finally {
      storage.setState(previousState);
    }
  });

  it('prefers the active-server machine cache over global machine map entries', async () => {
    const previousState = storage.getState();
    try {
      const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
      storage.setState((state) => ({
        ...state,
        isDataReady: true,
        machines: {
          'm-active': {
            id: 'm-active',
            seq: 1,
            createdAt: 1000,
            updatedAt: 1000,
            active: true,
            activeAt: 1000,
            metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            revokedAt: null,
          },
          'm-stale': {
            id: 'm-stale',
            seq: 1,
            createdAt: 900,
            updatedAt: 900,
            active: true,
            activeAt: 900,
            metadata: { host: 'stale', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            revokedAt: null,
          },
        },
        machineListByServerId: {
          [activeServerId]: [
            {
              id: 'm-active',
              seq: 1,
              createdAt: 1000,
              updatedAt: 1000,
              active: true,
              activeAt: 1000,
              metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
              metadataVersion: 1,
              daemonState: null,
              daemonStateVersion: 0,
              revokedAt: null,
            } as any,
          ],
        },
      }));

      const seen: string[][] = [];

      function Test() {
        const machines = useAllMachines();
        React.useEffect(() => {
          seen.push(machines.map((m) => m.id));
        }, [machines]);
        return null;
      }

      let tree: renderer.ReactTestRenderer | null = null;
      await act(async () => {
        tree = renderer.create(React.createElement(Test));
        await flushEffects(4);
      });

      expect(seen.at(-1)).toEqual(['m-active']);

      await act(async () => {
        tree?.unmount();
        await flushEffects(2);
      });
    } finally {
      storage.setState(previousState);
    }
  });
});
