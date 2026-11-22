import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import {
  MachineUpdateMetadataResponseSchema,
  type MachineUpdateMetadataRequest,
  type MachineUpdateMetadataResponse,
} from '@happier-dev/protocol/machines/metadataUpdate';

import { MachineMetadataSchema, type Machine } from '../types';
import { MachineContentKeyUnavailableError } from './machineDataEncryptionKey';
import { encodeMachineMetadataPublication } from './machineMetadataPublication';
import { createMachineContentCodec, type MachineContentCodec } from './machineStoredContent';

export type MachineMetadataFieldClientDependencies = Readonly<{
  machineId: string;
  readMachine: () => Promise<Machine | null>;
  updateMetadata: (request: MachineUpdateMetadataRequest) => Promise<MachineUpdateMetadataResponse>;
  signal?: AbortSignal;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
}>;

/** Exact-target metadata reads and writes share the incumbent Account-mode codec and key basis. */
export function createMachineMetadataFieldPort(dependencies: MachineMetadataFieldClientDependencies): MachineMetadataFieldPortV1 {
  const isCurrent = async () => !dependencies.signal?.aborted && (!dependencies.isCredentialCurrent || await dependencies.isCredentialCurrent());
  type WriteBasis = Pick<Machine, 'metadata' | 'metadataVersion'> & Readonly<{
    codec: MachineContentCodec;
    expectedDataEncryptionKey: string | null | undefined;
  }>;
  let basis: WriteBasis | null = null;
  const remember = (observed: WriteBasis) => {
    // Keep the opened incumbent independent of the editable snapshot returned to the caller.
    basis = { ...observed, metadata: observed.codec.mode === 'e2ee' ? structuredClone(observed.metadata) : null };
  };
  const port: MachineMetadataFieldPortV1 = {
    read: async () => {
      basis = null;
      if (!await isCurrent()) return { status: 'unavailable' };
      let machine: Machine | null;
      try { machine = await dependencies.readMachine(); } catch (error) {
        return { status: error instanceof MachineContentKeyUnavailableError ? 'locked' : 'unavailable' };
      }
      if (!machine || machine.id !== dependencies.machineId || !await isCurrent()) return { status: 'unavailable' };
      if (!machine.metadata) return { status: 'unavailable' };
      if (!Number.isSafeInteger(machine.metadataVersion) || machine.metadataVersion < 0) return { status: 'invalid' };
      const metadata = MachineMetadataSchema.safeParse(machine.metadata);
      if (!metadata.success) return { status: 'invalid' };
      // Accessible rows may expose the caller's envelope; writes bind the owner's key basis.
      const expectedDataEncryptionKey = machine.keyBasis ? machine.keyBasis.dataEncryptionKey
        : machine.access ? undefined : machine.dataEncryptionKey ?? null;
      remember({ codec: createMachineContentCodec(machine), expectedDataEncryptionKey,
        metadata: metadata.data, metadataVersion: machine.metadataVersion });
      return { status: 'ready', metadata: metadata.data, metadataVersion: machine.metadataVersion };
    },
    compareAndSwap: async input => {
      const current = basis;
      if (!current || !await isCurrent()) return { status: 'unavailable' };
      const { codec, expectedDataEncryptionKey } = current;
      if (expectedDataEncryptionKey === undefined) return { status: 'locked' };
      const request: MachineUpdateMetadataRequest = { machineId: dependencies.machineId,
        metadata: encodeMachineMetadataPublication(codec, input, current), expectedVersion: input.expectedMetadataVersion,
        expectedDataEncryptionKey };
      const parsed = MachineUpdateMetadataResponseSchema.safeParse(await dependencies.updateMetadata(request));
      if (!parsed.success) return { status: 'outcomeUnknown' };
      const answer = parsed.data;
      // A success ACK is verified with this invocation's captured codec below;
      // retirement must not erase it or authorize a replacement-Account read.
      if (!await isCurrent() && ('error' in answer || answer.result !== 'success')) return { status: 'outcomeUnknown' };
      if ('error' in answer || answer.result === 'error') return { status: 'unavailable' };
      if (answer.result === 'key-mismatch') {
        const latest = await port.read();
        return latest.status === 'ready'
          ? { status: 'conflict', metadata: latest.metadata, metadataVersion: latest.metadataVersion }
          : latest;
      }
      const opened = codec.decodeStored(answer.metadata);
      const validated = MachineMetadataSchema.safeParse(opened);
      if (!validated.success || !opened || typeof opened !== 'object' || Array.isArray(opened)) return { status: 'outcomeUnknown' };
      if (basis === current) remember({ ...current, metadata: validated.data, metadataVersion: answer.version });
      return { status: answer.result === 'success' ? 'applied' : 'conflict',
        metadata: validated.data, metadataVersion: answer.version };
    },
  };
  return port;
}
