import { describe, expect, it } from 'vitest';
import { createTargetActionCurrentIntentAdapter } from './targetActionCurrentIntent';

describe('target action current-intent adapter', () => {
  it('persists the exact subject and admits only the matching durable approval', async () => {
    let stored: any;
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => { stored = request; return { artifactId: 'approval-1' }; },
      read: async () => ({ ...stored, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 } }),
    });
    await expect(adapter({
      action: { qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', generation: '7', dangerLevel: 'destructive', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 }, policyFingerprint: 'b'.repeat(64) },
      fingerprint: 'a'.repeat(64), surface: 'cli',
    })).resolves.toEqual({ status: 'approved', fingerprint: 'a'.repeat(64) });
    expect(stored).toMatchObject({ kind: 'plugin_target_action', qualifiedActionId: 'acme.alpha/actions/run', generation: '7', policyFingerprint: 'b'.repeat(64) });
  });

  it('rejects a durable decision whose subject fields changed under the same fingerprint', async () => {
    let stored: any;
    const adapter = createTargetActionCurrentIntentAdapter({
      now: () => 1,
      create: async (request) => { stored = request; return { artifactId: 'approval-2' }; },
      read: async () => ({
        ...stored, generation: '8', status: 'approved', updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
      }),
    });
    await expect(adapter({
      action: { qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', generation: '7', dangerLevel: 'destructive', scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { x: 1 }, policyFingerprint: 'b'.repeat(64) },
      fingerprint: 'a'.repeat(64), surface: 'cli',
    })).resolves.toEqual({ status: 'unavailable', code: 'plugin_action_current_intent_mismatch' });
  });
});
