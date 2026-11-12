import { describe, expect, it } from 'vitest';

describe('Usage and visual Action approval parity', () => {
  it('keeps retained mutations discoverable and approval-default with explicit user waivers', async () => {
    const [
      { getActionSpec }, { resolveActionSurfaceAvailability },
      { isApprovalRequiredByActionsSettings }, { ActionsSettingsV1Schema },
    ] = await Promise.all([
      import('./actionSpecs.js'), import('./actionSurfaceAvailability.js'),
      import('./actionApprovalPolicy.js'), import('./actionSettings.js'),
    ]);
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });
    for (const id of [
      'settings.set', 'widgets.item.add', 'widgets.item.remove', 'widgets.item.inputs.set',
      'widgets.area.layout.create', 'widgets.area.layout.rename', 'widgets.area.layout.delete',
      'usage.coach.apply', 'usage.coach.undo',
      'usage.sources.consent.set', 'usage.sources.stop', 'usage.sources.history.delete',
      'connectedServices.subscription.price.set', 'widgets.definition.saveFromSession',
      'widgets.item.network.set',
    ] as const) {
      const spec = getActionSpec(id);
      expect(spec.safety, id).toBe('danger');
      for (const surface of ['agent', 'mcp'] as const) {
        expect(resolveActionSurfaceAvailability({ actionId: id, surface, requireToolBinding: true }).available, id).toBe(true);
        expect(isApprovalRequiredByActionsSettings(id, settings, { surface }), id).toBe(true);
        const waived = ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: { [id]: [surface] } });
        expect(isApprovalRequiredByActionsSettings(id, waived, { surface }), id).toBe(false);
      }
    }
    expect(getActionSpec('usage.query').approval).toMatchObject({ result: 'none' });
    expect(getActionSpec('usage.coach.apply').approval).toMatchObject({ result: 'required' });
    for (const id of ['usage.coach.dismiss', 'usage.coach.snooze'] as const) {
      expect(getActionSpec(id).approval).toMatchObject({ result: 'none' });
      expect(isApprovalRequiredByActionsSettings(id, settings, { surface: 'cli' })).toBe(false);
    }
  }, 60_000);
});
