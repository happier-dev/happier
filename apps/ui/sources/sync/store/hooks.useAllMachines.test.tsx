import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useAllMachines } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

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
});
