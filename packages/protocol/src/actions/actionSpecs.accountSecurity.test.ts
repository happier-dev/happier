import { describe, expect, it } from 'vitest';

import type { ActionId } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionSurfaceAvailability } from './actionSurfaceAvailability.js';

const operations = [
  ['account.security.get', 'GET', '/v1/account/security'],
  ['account.security.terminalPresentUser.set', 'POST', '/v1/account/security/terminal-present-user'],
  ['account.password.enroll', 'POST', '/v1/account/password/enroll'],
  ['account.password.change', 'POST', '/v1/account/password/change'],
  ['account.password.remove', 'POST', '/v1/account/password/remove'],
  ['account.email.change.request', 'POST', '/v1/account/email/change/request'],
] as const;

describe('Account Security Action admission', () => {
  it('admits the present-user UI and trusted interactive CLI journeys through the declared Account transport', () => {
    for (const [id, method, path] of operations) {
      const spec = getActionSpec(id as ActionId);
      expect(spec).toBeDefined();
      expect(spec.requiredAuthority).toBe(id === 'account.security.get' ? 'account_automation' : 'present_user');
      expect(spec.executionPlacement).toBe('account');
      expect(spec.serverTransport).toEqual({ method, path });
      expect(resolveActionSurfaceAvailability({ actionId: id, surface: 'ui' }).available).toBe(true);
      expect(resolveActionSurfaceAvailability({ actionId: id, surface: 'cli' }).available).toBe(true);
      // Agent/MCP/plugin exposure admits an approval request, not present-user
      // execution authority. Human-secret mutations stay off API-token ingress.
      for (const surface of ['agent', 'mcp', 'voice', 'rpc'] as const) {
        expect(resolveActionSurfaceAvailability({ actionId: id, surface }).available, `${id} on ${surface}`)
          .toBe(surface === 'agent' || surface === 'mcp');
      }
      for (const surface of ['api', 'plugin'] as const) {
        expect(resolveActionSurfaceAvailability({ actionId: id, surface }).available, `${id} on ${surface}`)
          .toBe(surface === 'plugin' || id === 'account.security.get');
      }
    }
  });

  it('projects human-secret inputs out of Action observations', () => {
    const spec = getActionSpec('account.password.change');
    const input = {
      v: 1,
      kind: 'plain',
      expectedCredentialRevision: 7,
      currentPassword: 'current highly secret password',
      newPassword: 'replacement highly secret password',
    };
    const projected = spec.projectObservationInput?.(input);
    expect(projected).toEqual({ v: 1, kind: 'plain', expectedCredentialRevision: 7 });
    expect(JSON.stringify(projected)).not.toContain('secret');
  });
});
