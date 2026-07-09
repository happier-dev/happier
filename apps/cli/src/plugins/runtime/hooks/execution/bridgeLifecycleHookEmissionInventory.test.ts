import { describe, expect, it } from 'vitest';

import { BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1 } from '@happier-dev/protocol';

import { BRIDGE_LIFECYCLE_HOOK_EMISSION_INVENTORY_V1 } from './bridgeLifecycleHookEmissionInventory';

describe('bridgeLifecycleHookEmissionInventory', () => {
  it('stays aligned with the protocol-owned bridge lifecycle event definitions', () => {
    expect(BRIDGE_LIFECYCLE_HOOK_EMISSION_INVENTORY_V1.map((entry) => entry.eventId)).toEqual([
      ...BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1.session,
      ...BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1.executionRun,
    ]);
  });

  it('records the owning bridge for each lifecycle event', () => {
    expect(BRIDGE_LIFECYCLE_HOOK_EMISSION_INVENTORY_V1).toEqual([
      expect.objectContaining({
        bridgeId: 'session',
        eventId: 'session.spawned',
        owner: 'SessionHostBridge',
        seam: 'emitLifecycleHookEvent',
      }),
      expect.objectContaining({
        bridgeId: 'session',
        eventId: 'session.message.send',
        owner: 'SessionHostBridge',
        seam: 'emitLifecycleHookEvent',
      }),
      expect.objectContaining({
        bridgeId: 'executionRun',
        eventId: 'executionRun.started',
        owner: 'ExecutionRunHostBridge',
        seam: 'start',
      }),
      expect.objectContaining({
        bridgeId: 'executionRun',
        eventId: 'executionRun.messageSent',
        owner: 'ExecutionRunHostBridge',
        seam: 'send',
      }),
      expect.objectContaining({
        bridgeId: 'executionRun',
        eventId: 'executionRun.stopped',
        owner: 'ExecutionRunHostBridge',
        seam: 'stop',
      }),
      expect.objectContaining({
        bridgeId: 'executionRun',
        eventId: 'executionRun.completed',
        owner: 'ExecutionRunHostBridge',
        seam: 'finishRun',
      }),
    ]);
  });
});
