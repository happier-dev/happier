import { describe, expect, it } from 'vitest';

import {
  BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1,
  BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1,
  EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1,
  SESSION_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1,
} from './bridgeLifecycleHookCatalog.js';

describe('bridgeLifecycleHookCatalog', () => {
  it('exposes the session bridge lifecycle hook event ids', () => {
    expect(SESSION_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1).toEqual([
      'session.spawned',
      'session.message.send',
    ]);
  });

  it('exposes the execution-run bridge lifecycle hook event ids', () => {
    expect(EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1).toEqual([
      'executionRun.started',
      'executionRun.messageSent',
      'executionRun.stopped',
      'executionRun.completed',
    ]);
  });

  it('exposes one combined bridge lifecycle hook event id list', () => {
    expect(BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1).toEqual([
      'session.spawned',
      'session.message.send',
      'executionRun.started',
      'executionRun.messageSent',
      'executionRun.stopped',
      'executionRun.completed',
    ]);
  });

  it('exposes the bridge lifecycle hook event ids grouped by owning bridge', () => {
    expect(BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1).toEqual({
      session: [
        'session.spawned',
        'session.message.send',
      ],
      executionRun: [
        'executionRun.started',
        'executionRun.messageSent',
        'executionRun.stopped',
        'executionRun.completed',
      ],
    });
  });
});
