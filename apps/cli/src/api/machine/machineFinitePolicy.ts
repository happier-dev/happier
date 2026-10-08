import {
  getMachineFinitePolicyV1,
  mutateMachineFinitePolicyV1,
  type MachineFinitePolicyMetadataPortV1,
  type MachineFinitePolicyGetResultV1,
  type MachineFinitePolicyMutationResultV1,
} from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import {
  MachineUpdateMetadataResponseSchema,
  type MachineUpdateMetadataRequest,
  type MachineUpdateMetadataResponse,
} from '@happier-dev/protocol/machines/metadataUpdate';

import { MachineMetadataSchema, type Machine } from '../types';
import { MachineContentKeyUnavailableError } from './machineDataEncryptionKey';
import { createMachineContentCodec, type MachineContentCodec } from './machineStoredContent';
import { parseMachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

export type MachineFinitePolicyClient = Readonly<{
  get: () => Promise<MachineFinitePolicyGetResultV1>;
  set: (input: unknown) => Promise<MachineFinitePolicyMutationResultV1>;
}>;

/** Exact-target reader and socket writer retain the incumbent mode/key/Manage admission. */
export function createMachineFinitePolicyClient(dependencies: Readonly<{
  machineId: string;
  readMachine: () => Promise<Machine | null>;
  updateMetadata: (request: MachineUpdateMetadataRequest) => Promise<MachineUpdateMetadataResponse>;
  signal?: AbortSignal;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
}>): MachineFinitePolicyClient {
  const isCurrent = async () => !dependencies.signal?.aborted && (!dependencies.isCredentialCurrent || await dependencies.isCredentialCurrent());
  const createPort = (): MachineFinitePolicyMetadataPortV1 => {
    let codec: MachineContentCodec | null = null;
    let expectedDataEncryptionKey: string | null | undefined;
    const port: MachineFinitePolicyMetadataPortV1 = {
    read: async () => {
      codec = null;
      expectedDataEncryptionKey = undefined;
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
      codec = createMachineContentCodec(machine);
      // Accessible rows may expose the caller's envelope; writes bind the owner's key basis.
      expectedDataEncryptionKey = machine.keyBasis ? machine.keyBasis.dataEncryptionKey
        : machine.access ? undefined : machine.dataEncryptionKey ?? null;
      return { status: 'ready', metadata: metadata.data, metadataVersion: machine.metadataVersion };
    },
    compareAndSwap: async ({ metadata, expectedMetadataVersion }) => {
      const currentCodec = codec;
      if (!currentCodec || !await isCurrent()) return { status: 'unavailable' };
      if (expectedDataEncryptionKey === undefined) return { status: 'locked' };
      const request: MachineUpdateMetadataRequest = { machineId: dependencies.machineId,
        metadata: currentCodec.encodeStored(parseMachinePublishedMetadataV1(metadata)), expectedVersion: expectedMetadataVersion,
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
      const opened = currentCodec.decodeStored(answer.metadata);
      const validated = MachineMetadataSchema.safeParse(opened);
      if (!validated.success || !opened || typeof opened !== 'object' || Array.isArray(opened)) return { status: 'outcomeUnknown' };
      return { status: answer.result === 'success' ? 'applied' : 'conflict',
        metadata: validated.data, metadataVersion: answer.version };
    },
    };
    return port;
  };
  return {
    get: () => getMachineFinitePolicyV1(createPort()),
    set: (input: unknown) => mutateMachineFinitePolicyV1(input, createPort(), { signal: dependencies.signal }),
  };
}
