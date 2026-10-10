import { describe, expect, it } from 'vitest';

import {
  MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1,
  MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1,
  MANAGED_IDENTITY_PROVIDER_ACTION_OUTPUT_SCHEMAS_V1,
  MANAGED_IDENTITY_PROVIDER_ACTION_PATHS_V1,
} from '../identity/providers.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';

describe('managed identity-provider Action contracts', () => {
  it('registers every intent with its exact strict POST transport', () => {
    for (const id of MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1) {
      expect(ActionIdSchema.parse(id)).toBe(id);
      const spec = getActionSpec(id);
      expect(spec.serverTransport).toEqual({ method: 'POST', path: MANAGED_IDENTITY_PROVIDER_ACTION_PATHS_V1[id] });
      expect(spec.inputSchema).toBe(MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1[id]);
      expect(spec.outputSchema).toBe(MANAGED_IDENTITY_PROVIDER_ACTION_OUTPUT_SCHEMAS_V1[id]);
      expect(spec.approval).toMatchObject({ result: 'required' });
    }
  });

  it('admits provider mutation requests while retaining authenticated human execution authority', () => {
    for (const id of [
      'identity.providers.create',
      'identity.providers.update',
      'identity.providers.secret.replace',
      'identity.providers.validate',
      'identity.providers.enable',
      'identity.providers.disable',
      'identity.providers.remove',
    ] as const) {
      const spec = getActionSpec(id);
      expect(spec.requiredAuthority).toBe('present_user');
      expect(spec.surfaces).toMatchObject({ ui: true, cli: true, agent: true, mcp: true, api: false });
    }
  });

  it('publishes bounded provider test operations to account automation', () => {
    for (const id of [
      'identity.providers.test.start',
      'identity.providers.test.consume',
    ] as const) {
      const spec = getActionSpec(id);
      expect(spec.requiredAuthority).toBe('account_automation');
      expect(spec.surfaces).toMatchObject({ ui: true, cli: true, agent: true, mcp: false });
    }
  });

  it('classifies lifecycle and outbound validation effects honestly', () => {
    for (const id of [
      'identity.providers.validate',
      'identity.providers.test.start',
      'identity.providers.test.consume',
      'identity.providers.enable',
      'identity.providers.disable',
      'identity.providers.remove',
    ] as const) {
      expect(getActionSpec(id).safety).toBe('danger');
    }
    expect(getActionSpec('identity.providers.list').sideEffectClass).toBe('read');
  });

  it('requires every provider lifecycle command to select one exact saved Home', () => {
    for (const id of MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1) {
      expect(getActionSpec(id).cli?.acceptsServerId, id).toBe(true);
      expect(getActionSpec(id).cli?.requiresServerId, id).toBe(true);
    }
  });

  it('keeps the write-only client secret out of provider observations', () => {
    for (const id of [
      'identity.providers.create',
      'identity.providers.secret.replace',
    ] as const) {
      const spec = getActionSpec(id);
      const observed = spec.projectObservationInput?.({
        owner: { kind: 'home' },
        id: 'provider-1',
        expectedRevision: 3,
        displayName: 'Company login',
        clientSecret: 'super-secret-value',
      });
      expect(observed, id).toBeDefined();
      expect(JSON.stringify(observed), id).not.toContain('super-secret-value');
      expect(JSON.stringify(observed), id).not.toContain('clientSecret');
      // Redaction must not erase the non-secret facts an observer needs.
      expect(observed, id).toMatchObject({ owner: { kind: 'home' }, id: 'provider-1' });
    }
  });

  it('redacts one-time browser credentials from provider test observations', () => {
    const start = getActionSpec('identity.providers.test.start');
    const startProjection = start.projectObservationOutput?.({
      authorizeUrl: 'https://home.example/authorize?secret=one-time',
      attemptId: 'attempt-secret',
    });
    expect(startProjection).toEqual({ redacted: true });
    expect(JSON.stringify(startProjection)).not.toContain('one-time');
    expect(JSON.stringify(startProjection)).not.toContain('attempt-secret');

    const consume = getActionSpec('identity.providers.test.consume');
    const consumeProjection = consume.projectObservationInput?.({
      owner: { kind: 'account' },
      id: 'provider-1',
      resultHandle: 'result-secret',
    });
    expect(consumeProjection).toEqual({ owner: { kind: 'account' }, id: 'provider-1' });
    expect(JSON.stringify(consumeProjection)).not.toContain('result-secret');
  });
});
