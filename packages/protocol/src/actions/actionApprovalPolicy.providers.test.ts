import { describe, expect, it } from 'vitest';
import type { ActionId } from './actionIds.js';

describe('Provider Settings present-user approval policy', () => {
  it('routes dangerous Provider operations through the canonical UI approval owner', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    for (const id of ['providers.connections.enabled.set', 'providers.connections.delete', 'providers.probe',
      'providers.connections.start_local', 'providers.models.load', 'providers.models.experimental.confirm'] as const satisfies readonly ActionId[]) {
      expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id),
        context: { surface: 'ui', authority: 'present_user' } })).toMatchObject({ required: true, flow: 'deferred' });
    }
  }, 60_000);
});
