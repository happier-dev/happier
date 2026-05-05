import {
  BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1,
  type BridgeLifecycleHookEventIdV1,
} from '@happier-dev/protocol';

export type BridgeLifecycleHookEmissionInventoryEntry = Readonly<{
  eventId: BridgeLifecycleHookEventIdV1;
  bridgeId: 'session' | 'execution_run';
  owner: string;
  seam: string;
  notes: string;
}>;

const BRIDGE_LIFECYCLE_HOOK_EMISSION_NOTES_BY_EVENT_ID_V1: Readonly<Record<BridgeLifecycleHookEventIdV1, Readonly<{
  owner: string;
  seam: string;
  notes: string;
}>>> = Object.freeze({
  'session.spawn_new': {
    owner: 'SessionHostBridge',
    seam: 'emitLifecycleHookEvent',
    notes: 'Emitted after a successful session creation flow.',
  },
  'session.message.send': {
    owner: 'SessionHostBridge',
    seam: 'emitLifecycleHookEvent',
    notes: 'Emitted after a successful message send flow.',
  },
  'execution_run.start': {
    owner: 'ExecutionRunHostBridge',
    seam: 'start',
    notes: 'Emitted after run state is registered and public state is updated.',
  },
  'execution_run.send': {
    owner: 'ExecutionRunHostBridge',
    seam: 'send',
    notes: 'Emitted after a send/resume delivery request is accepted.',
  },
  'execution_run.stop': {
    owner: 'ExecutionRunHostBridge',
    seam: 'stop',
    notes: 'Emitted after a stop request succeeds.',
  },
  'execution_run.terminal': {
    owner: 'ExecutionRunHostBridge',
    seam: 'finishRun',
    notes: 'Emitted when a run enters a terminal state.',
  },
});

function buildBridgeLifecycleHookEmissionInventoryEntry(params: Readonly<{
  eventId: BridgeLifecycleHookEventIdV1;
  bridgeId: 'session' | 'execution_run';
}>): BridgeLifecycleHookEmissionInventoryEntry {
  const details = BRIDGE_LIFECYCLE_HOOK_EMISSION_NOTES_BY_EVENT_ID_V1[params.eventId];
  return {
    eventId: params.eventId,
    bridgeId: params.bridgeId,
    owner: details.owner,
    seam: details.seam,
    notes: details.notes,
  };
}

export const BRIDGE_LIFECYCLE_HOOK_EMISSION_INVENTORY_V1: readonly BridgeLifecycleHookEmissionInventoryEntry[] = Object.freeze([
  ...BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1.session.map((eventId) => (
    buildBridgeLifecycleHookEmissionInventoryEntry({ eventId, bridgeId: 'session' })
  )),
  ...BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1.execution_run.map((eventId) => (
    buildBridgeLifecycleHookEmissionInventoryEntry({ eventId, bridgeId: 'execution_run' })
  )),
]);
