import {
  BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1,
  type BridgeLifecycleHookEventIdV1,
} from '@happier-dev/protocol';

export type BridgeLifecycleHookEmissionInventoryEntry = Readonly<{
  eventId: BridgeLifecycleHookEventIdV1;
  bridgeId: 'session' | 'executionRun';
  owner: string;
  seam: string;
  notes: string;
}>;

const BRIDGE_LIFECYCLE_HOOK_EMISSION_NOTES_BY_EVENT_ID_V1: Readonly<Record<BridgeLifecycleHookEventIdV1, Readonly<{
  owner: string;
  seam: string;
  notes: string;
}>>> = Object.freeze({
  'session.spawned': {
    owner: 'SessionHostBridge',
    seam: 'emitLifecycleHookEvent',
    notes: 'Emitted after a successful session creation flow.',
  },
  'session.message.send': {
    owner: 'SessionHostBridge',
    seam: 'emitLifecycleHookEvent',
    notes: 'Emitted after a successful message send flow.',
  },
  'executionRun.started': {
    owner: 'ExecutionRunHostBridge',
    seam: 'start',
    notes: 'Emitted after run state is registered and public state is updated.',
  },
  'executionRun.messageSent': {
    owner: 'ExecutionRunHostBridge',
    seam: 'send',
    notes: 'Emitted after a send/resume delivery request is accepted.',
  },
  'executionRun.stopped': {
    owner: 'ExecutionRunHostBridge',
    seam: 'stop',
    notes: 'Emitted after a stop request succeeds.',
  },
  'executionRun.completed': {
    owner: 'ExecutionRunHostBridge',
    seam: 'finishRun',
    notes: 'Emitted when a run enters a terminal state.',
  },
});

function buildBridgeLifecycleHookEmissionInventoryEntry(params: Readonly<{
  eventId: BridgeLifecycleHookEventIdV1;
  bridgeId: 'session' | 'executionRun';
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
  ...BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1.executionRun.map((eventId) => (
    buildBridgeLifecycleHookEmissionInventoryEntry({ eventId, bridgeId: 'executionRun' })
  )),
]);
