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
      'session.spawn_new',
      'session.message.send',
    ]);
  });

  it('exposes the execution-run bridge lifecycle hook event ids', () => {
    expect(EXECUTION_RUN_BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1).toEqual([
      'execution_run.start',
      'execution_run.send',
      'execution_run.stop',
      'execution_run.terminal',
    ]);
  });

  it('exposes one combined bridge lifecycle hook event id list', () => {
    expect(BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1).toEqual([
      'session.spawn_new',
      'session.message.send',
      'execution_run.start',
      'execution_run.send',
      'execution_run.stop',
      'execution_run.terminal',
    ]);
  });

  it('exposes the bridge lifecycle hook event ids grouped by owning bridge', () => {
    expect(BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_BY_BRIDGE_V1).toEqual({
      session: [
        'session.spawn_new',
        'session.message.send',
      ],
      execution_run: [
        'execution_run.start',
        'execution_run.send',
        'execution_run.stop',
        'execution_run.terminal',
      ],
    });
  });
});
