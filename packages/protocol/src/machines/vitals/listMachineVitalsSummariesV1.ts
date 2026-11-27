import { MachineVitalsSnapshotV1Schema } from './machineVitalsRpcV1.js';
import { MachineVitalsHostFactsV1Schema, type MachineVitalsHostFactsV1 } from './machineVitalsSampleV1.js';
import { isRpcMethodNotFoundError, isRpcMethodNotFoundResult, readRpcErrorCode } from '../../rpc/errors.js';
import { readActionErrorCodeV1 } from '../../actions/actionErrorClassV1.js';
import { readActionFailureEnvelope } from '../../actions/executor/actionFailureEnvelope.js';
import { MachineResourceAttentionV1Schema, projectMachineResourceSummaryV1, type MachineResourceAttentionV1, type MachineResourceSummaryV1 } from '../resources/machineResourceSummaryV1.js';

/** Already opened, share-safe synced Machine facts; the publication owner supplies attention. */
export type MachineVitalsSummaryTargetV1 = Readonly<{
  machineId: string;
  name: string;
  online: boolean;
  resources?: Readonly<{ vitals: Readonly<{ state: 'reporting' | 'unavailable' }>; attention?: MachineResourceAttentionV1; host?: MachineVitalsHostFactsV1 }> | null;
  unavailable?: boolean;
}>;

export type MachineVitalsSummaryListItemV1 = Readonly<{
  machineId: string;
  name: string;
  presence: 'online' | 'offline';
  state: 'reporting' | 'unavailable' | 'not_reporting' | 'offline';
  errorCode?: string;
  attention?: MachineResourceAttentionV1;
  summary?: MachineResourceSummaryV1;
}>;

/** Narrow read projection; the VU3 publication schema remains the complete document owner. */
export function readMachineVitalsResourcesProjectionV1(daemonState: unknown): MachineVitalsSummaryTargetV1['resources'] {
  if (!daemonState || typeof daemonState !== 'object') return undefined;
  const resources: unknown = Reflect.get(daemonState, 'resources');
  if (!resources || typeof resources !== 'object') return undefined;
  const vitals: unknown = Reflect.get(resources, 'vitals');
  const state: unknown = vitals && typeof vitals === 'object' ? Reflect.get(vitals, 'state') : undefined;
  if (state !== 'reporting' && state !== 'unavailable') return undefined;
  const attention = MachineResourceAttentionV1Schema.safeParse(Reflect.get(resources, 'attention'));
  const host = MachineVitalsHostFactsV1Schema.safeParse(Reflect.get(resources, 'host'));
  return { vitals: { state }, ...(attention.success ? { attention: attention.data } : {}), ...(host.success ? { host: host.data } : {}) };
}

/** Each reporting online Machine is its own sample authority; synced attention is never recomputed here. */
export async function listMachineVitalsSummariesV1(input: Readonly<{
  machines: readonly MachineVitalsSummaryTargetV1[];
  readSummary: (machineId: string) => Promise<unknown>;
  signal?: AbortSignal;
}>): Promise<readonly MachineVitalsSummaryListItemV1[]> {
  input.signal?.throwIfAborted();
  return await Promise.all(input.machines.map(async (machine): Promise<MachineVitalsSummaryListItemV1> => {
    const base = { machineId: machine.machineId, name: machine.name, presence: machine.online ? 'online' as const : 'offline' as const,
      ...(machine.resources?.attention === undefined ? {} : { attention: machine.resources.attention }) };
    if (!machine.online) return { ...base, state: 'offline' };
    if (machine.unavailable || machine.resources?.vitals.state === 'unavailable') return { ...base, state: 'unavailable' };
    if (!machine.resources) return { ...base, state: 'not_reporting' };
    let refusalCode: string | undefined;
    try {
      const raw = await input.readSummary(machine.machineId);
      input.signal?.throwIfAborted();
      if (isRpcMethodNotFoundResult(raw)) return { ...base, state: 'not_reporting' };
      const parsed = MachineVitalsSnapshotV1Schema.safeParse(raw);
      if (parsed.success) {
        const summary = projectMachineResourceSummaryV1({ ...parsed.data, attention: machine.resources.attention }, machine.resources.host);
        return { ...base, state: parsed.data.state, ...(summary ? { summary } : {}) };
      }
      refusalCode = readActionFailureEnvelope(raw, { treatReturnedErrorEnvelopeAsFailure: true })?.errorCode;
    } catch (error) {
      input.signal?.throwIfAborted();
      if (isRpcMethodNotFoundError(error)) return { ...base, state: 'not_reporting' };
      refusalCode = readRpcErrorCode(error) ?? readActionFailureEnvelope(error)?.errorCode;
    }
    const errorCode = readActionErrorCodeV1({ errorCode: refusalCode });
    return { ...base, state: 'unavailable', ...(errorCode ? { errorCode } : {}) };
  }));
}
