import { isDeepStrictEqual } from 'node:util';
import { MachineUpdateStateResponseSchema, type MachineUpdateStateRequest } from '@happier-dev/protocol/machines/metadataUpdate';
import { parseMachinePublishedDaemonStateV1, StoredMachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import type { DaemonState, Machine } from '../types';
import type { ApiMachineDaemonStatePublicationOptions, MachinePublicationOutcome } from '../apiMachine';
import type { MachineContentCodec } from './machineStoredContent';

/** Registration returns retained content. Only the ready daemon may replace its
 * ownership, and a successor must qualify isolation again before claiming it. */
export function projectMachineDaemonRunningState(
  state: DaemonState | null,
  runtimeId: string | undefined,
): DaemonState {
  const sameRuntime = state?.pid === process.pid && state.runtimeId === runtimeId;
  const { runtimeId: _retainedRuntimeId, ...fields } = state ?? {};
  return {
    ...fields,
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    status: 'running',
    pid: process.pid,
    startedAt: sameRuntime && typeof state.startedAt === 'number' ? state.startedAt : Date.now(),
    ...(!sameRuntime ? { agentIsolation: { kind: 'unavailable' as const, code: 'provisioning_unavailable' as const } } : {}),
  };
}

type Publication = {
  handler: (state: DaemonState | null) => DaemonState;
  options?: ApiMachineDaemonStatePublicationOptions;
  resolve: (outcome: MachinePublicationOutcome) => void;
  reject: (error: unknown) => void;
};

type WriteContext = Readonly<{
  socket: Parameters<typeof emitSocketWithAck<unknown, 'machine-update-state', MachineUpdateStateRequest>>[0]['socket'];
  codec: MachineContentCodec;
  expectedDataEncryptionKey: string | null;
  isCurrent(): boolean;
}>;

/** One drain per Machine client. Pending reducers compose owner fields in arrival
 * order, so the latest value wins without losing another owner's partial update.
 * Only a conflict carrying a newer authoritative version re-enters the drain. */
export function createMachineDaemonStatePublication(context: Readonly<{
  getMachine(): Machine;
  shouldSuppress(allowWhileQuiescing?: boolean): boolean;
  prepareWrite(): Promise<WriteContext>;
  retireAndRefreshContent(): Promise<void>;
  needsPersistedIrohEndpointWithdrawal(): boolean;
  acknowledgeDaemonStatePublication(): void;
  discardUnverifiedIrohEndpoint(state: DaemonState | null): DaemonState | null;
  synchronizeIrohMachineEndpointAuthority(state: DaemonState | null, hadEndpoint: boolean): Promise<void>;
}>) {
  let pending: Publication[] = [];
  let running = false;

  const drain = async () => {
    running = true;
    let batch: Publication[] = [];
    try {
      while (batch.length || pending.length) {
        batch.push(...pending);
        pending = [];
        batch = batch.filter(publication => {
          if (!context.shouldSuppress(publication.options?.allowWhileQuiescing)) return true;
          publication.resolve('suppressed');
          return false;
        });
        if (!batch.length) continue;
        const write = await context.prepareWrite();
        const machine = context.getMachine();
        const expectedVersion = machine.daemonStateVersion;
        const current = machine.daemonState === null ? null : StoredMachinePublishedDaemonStateV1Schema.parse(machine.daemonState);
        // The exposed snapshot can already have discarded an unverified endpoint
        // while the server still retains it. That is a known content difference.
        const needsPersistedWithdrawal = context.needsPersistedIrohEndpointWithdrawal();
        let updated = current;
        const outcomes = new Map<Publication, MachinePublicationOutcome>();
        batch = batch.filter(publication => {
          if (context.shouldSuppress(publication.options?.allowWhileQuiescing)) {
            publication.resolve('suppressed');
            return false;
          }
          try {
            const next = parseMachinePublishedDaemonStateV1(publication.handler(updated));
            outcomes.set(publication, !needsPersistedWithdrawal && isDeepStrictEqual(updated, next) ? 'unchanged' : 'published');
            updated = next;
            return true;
          } catch (error) {
            publication.reject(error);
            return false;
          }
        });
        if (!batch.length) continue;
        if (!needsPersistedWithdrawal && isDeepStrictEqual(current, updated)) {
          // A successful state receipt and failed capability receipt leave only
          // the capability owner to reconcile; do not write equal content again.
          await context.synchronizeIrohMachineEndpointAuthority(current, false);
          for (const publication of batch) publication.resolve('unchanged');
          batch = [];
          continue;
        }
        if (!write.isCurrent()) throw new Error('Machine content changed before publication');
        const managedActivityChanged = batch.some(publication => publication.options?.managedActivityChanged === true)
          && !isDeepStrictEqual(current?.managedActivity, updated?.managedActivity);
        const answer = MachineUpdateStateResponseSchema.parse(await emitSocketWithAck({
          socket: write.socket, event: 'machine-update-state', timeoutMs: null,
          payload: { machineId: machine.id, daemonState: write.codec.encodeStored(updated),
            expectedVersion, expectedDataEncryptionKey: write.expectedDataEncryptionKey,
            ...(managedActivityChanged ? { managedActivityChanged: true as const } : {}) },
        }));
        if (!write.isCurrent() && !('result' in answer && answer.result === 'key-mismatch')) {
          throw Object.assign(new Error('Machine content key changed during publication'), { retryable: false });
        }
        if (!('result' in answer)) throw Object.assign(new Error('Machine content publication requires a client update'), { code: answer.error, retryable: false });
        if (answer.result === 'key-mismatch') {
          await context.retireAndRefreshContent();
          throw new Error('Machine content key mismatch');
        }
        if (answer.result === 'error') {
          throw Object.assign(new Error(`Machine daemon-state update failed: ${answer.message ?? 'Server rejected the publication'}`),
            { retryable: false });
        }
        // Same-key snapshot refreshes may replace the Machine while the ACK is pending.
        const latest = context.getMachine();
        if (answer.version > latest.daemonStateVersion
          || answer.result === 'success' && answer.version === latest.daemonStateVersion) {
          const state = answer.daemonState === null ? null : StoredMachinePublishedDaemonStateV1Schema.parse(write.codec.decodeStored(answer.daemonState));
          const hadEndpoint = latest.daemonState?.peerMediation?.iroh?.endpoint != null;
          latest.daemonState = answer.result === 'success' ? state : context.discardUnverifiedIrohEndpoint(state);
          latest.daemonStateVersion = answer.version;
          if (latest.keyBasis) latest.keyBasis = { ...latest.keyBasis, daemonStateVersion: answer.version };
          if (answer.result === 'success') {
            context.acknowledgeDaemonStatePublication();
            await context.synchronizeIrohMachineEndpointAuthority(latest.daemonState, hadEndpoint);
          }
        }
        if (answer.result === 'version-mismatch') {
          if (context.getMachine().daemonStateVersion <= expectedVersion) {
            throw new Error('Daemon state conflict did not advance the server version');
          }
          // Rebase these reducers plus the latest pending changes on the returned
          // server state immediately, with no backoff or retry of the old version.
          continue;
        }
        for (const publication of batch) publication.resolve(outcomes.get(publication) ?? 'unchanged');
        batch = [];
      }
    } catch (error) {
      // A failed transport settles this demand. A later real change/reconnect may
      // request publication; queued callers must not amplify the same failure.
      for (const publication of [...batch, ...pending]) publication.reject(error);
      pending = [];
    } finally {
      running = false;
    }
  };

  return (handler: Publication['handler'], options?: ApiMachineDaemonStatePublicationOptions): Promise<MachinePublicationOutcome> => {
    if (context.shouldSuppress(options?.allowWhileQuiescing)) return Promise.resolve('suppressed');
    return new Promise((resolve, reject) => {
      pending.push({ handler, options, resolve, reject });
      if (!running) void drain();
    });
  };
}
