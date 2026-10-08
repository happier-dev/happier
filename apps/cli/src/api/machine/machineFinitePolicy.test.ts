import axios from 'axios';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { MachineMetadataSchema } from '../types';
import { createMachineFinitePolicyClient } from './machineFinitePolicy';
import { decodePlainMachineStoredContent, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachineUpdateMetadataRequestSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import type { Machine } from '../types';

describe('Machine metadata finite policy carrier', () => {
  it('retains finite admission policy when opening metadata', () => {
    expect(MachineMetadataSchema.parse({
      host: 'worker', platform: 'linux', happyCliVersion: 'dev',
      homeDir: '/home/test', happyHomeDir: '/home/test/.happier', happyLibDir: '/opt/happier',
      finitePolicyV1: { accepting: false, runAtMost: 2, futureDisplay: 'ignored' },
    })).toMatchObject({ finitePolicyV1: { accepting: false, runAtMost: 2 } });
  });

  it('refuses malformed stored policy instead of opening it as unlimited', () => {
    expect(MachineMetadataSchema.safeParse({
      host: 'worker', platform: 'linux', happyCliVersion: 'dev',
      homeDir: '/home/test', happyHomeDir: '/home/test/.happier', happyLibDir: '/opt/happier',
      finitePolicyV1: { accepting: true, runAtMost: 0 },
    }).success).toBe(false);
  });

  it('uses the incumbent plain metadata CAS, preserves sibling fields and observes unknown acknowledgement', async () => {
    let machine: Machine = { id: 'm1', encryptionMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/h', happyHomeDir: '/h/.happier', happyLibDir: '/lib' },
      metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    let writes = 0;
    const client = createMachineFinitePolicyClient({ machineId: 'm1', readMachine: async () => machine,
      updateMetadata: async (request) => {
        expect(MachineUpdateMetadataRequestSchema.parse(request).expectedDataEncryptionKey).toBe(MACHINE_PLAIN_DATA_KEY_MARKER);
        writes++;
        const metadata = MachineMetadataSchema.parse(decodePlainMachineStoredContent(request.metadata));
        expect(metadata.host).toBe('worker');
        machine = { ...machine, metadata, metadataVersion: 2 };
        throw new Error('ack lost after server accepted');
      },
    });
    expect(await client.get()).toEqual({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'default', metadataVersion: 1 });
    expect(await client.set({ expectedPolicy: { accepting: true, runAtMost: null }, expectedMetadataVersion: 1,
      policy: { accepting: false, runAtMost: 2 } })).toEqual({ status: 'satisfied', policy: { accepting: false, runAtMost: 2 }, metadataVersion: 2 });
    expect(writes).toBe(1);
  });

  it('reobserves a refused key basis before comparing policy instead of treating it as a lost acknowledgement', async () => {
    let machine: Machine = { id: 'm1', encryptionMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/h', happyHomeDir: '/h/.happier', happyLibDir: '/lib' },
      metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    let writes = 0;
    const client = createMachineFinitePolicyClient({ machineId: 'm1', readMachine: async () => machine,
      updateMetadata: async () => {
        writes++;
        machine = { ...machine, metadata: { ...machine.metadata!, finitePolicyV1: { accepting: false, runAtMost: 3 } }, metadataVersion: 2 };
        return { result: 'key-mismatch' };
      },
    });
    expect(await client.set({ expectedPolicy: { accepting: true, runAtMost: null }, expectedMetadataVersion: 1,
      policy: { accepting: false, runAtMost: 2 } })).toEqual({ status: 'conflict', policy: { accepting: false, runAtMost: 3 }, metadataVersion: 2 });
    expect(writes).toBe(1);
  });

  it('retains a verified Plain policy acknowledgement after credential retirement without inferring acceptance from the request', async () => {
    for (const acknowledgement of ['lost', 'malformed', 'mismatched', 'confirmed'] as const) {
      const machine: Machine = { id: 'm1', encryptionMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/h', happyHomeDir: '/h/.happier', happyLibDir: '/lib' },
        metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
      let credentialCurrent = true;
      let writes = 0;
      const client = createMachineFinitePolicyClient({ machineId: 'm1', readMachine: async () => machine,
        isCredentialCurrent: () => credentialCurrent,
        updateMetadata: async (request) => {
          expect(MachineUpdateMetadataRequestSchema.parse(request).expectedDataEncryptionKey).toBe(MACHINE_PLAIN_DATA_KEY_MARKER);
          expect(decodePlainMachineStoredContent(request.metadata)).toMatchObject({ finitePolicyV1: { accepting: false, runAtMost: 2 } });
          writes++;
          credentialCurrent = false;
          if (acknowledgement === 'lost') throw new Error('acknowledgement was not observed');
          return { result: 'success', version: acknowledgement === 'malformed' ? -1 : 2,
            metadata: acknowledgement === 'mismatched'
              ? encodePlainMachineStoredContent({ ...machine.metadata!, finitePolicyV1: { accepting: true, runAtMost: 3 } })
              : request.metadata };
        },
      });
      expect(await client.set({ expectedPolicy: { accepting: true, runAtMost: null }, expectedMetadataVersion: 1,
        policy: { accepting: false, runAtMost: 2 } })).toEqual(acknowledgement === 'confirmed'
          ? { status: 'applied', policy: { accepting: false, runAtMost: 2 }, metadataVersion: 2 }
          : { status: 'outcomeUnknown' });
      expect(await client.get()).toEqual({ status: 'unavailable' });
      expect(writes).toBe(1);
    }
  });

  it('refuses malformed exact metadata versions before policy disclosure or mutation', async () => {
    const machine: Machine = { id: 'm1', encryptionMode: 'plain', metadata: {
      host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/h', happyHomeDir: '/h/.happier', happyLibDir: '/lib',
    }, metadataVersion: -1, daemonState: null, daemonStateVersion: 0 };
    let writes = 0;
    const client = createMachineFinitePolicyClient({ machineId: 'm1', readMachine: async () => machine,
      updateMetadata: async () => { writes++; return { result: 'error' }; },
    });
    expect(await client.get()).toEqual({ status: 'invalid' });
    expect(await client.set({ expectedPolicy: { accepting: true, runAtMost: null }, expectedMetadataVersion: 0,
      policy: { accepting: false, runAtMost: 2 } })).toEqual({ status: 'invalid' });
    expect(writes).toBe(0);
  });

  it('opens policy with token-only plaintext credentials from the captured Home', async () => {
    const urls: string[] = [];
    let credentialCurrent = true;
    const row = MachinePublishedRowV1Schema.parse({ id: 'target', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: encodePlainMachineStoredContent({ host: 'worker', platform: 'linux', happyCliVersion: 'dev',
        homeDir: '/h', happyHomeDir: '/h/.happier', happyLibDir: '/lib' }), metadataVersion: 1,
      daemonState: null, daemonStateVersion: 0 });
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      urls.push(url);
      return url.endsWith('/v1/machines/target')
        ? { status: 200, data: { machine: row } }
        : { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    });
    onTestFinished(() => get.mockRestore());
    const { createAccountServerMachineFinitePolicyClient } = await import('./accountServerMachineFinitePolicyClient');
    const client = await createAccountServerMachineFinitePolicyClient({ machineId: 'target', credentials: { token: 'test' },
      serverHttpBaseUrl: 'https://bound-home.test', isCredentialCurrent: () => credentialCurrent,
    });
    expect(await client.get()).toEqual({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'default', metadataVersion: 1 });
    expect(urls).toEqual(['https://bound-home.test/v1/account/encryption', 'https://bound-home.test/v1/machines/target']);
    credentialCurrent = false;
    expect(await client.get()).toEqual({ status: 'unavailable' });
  });
});
