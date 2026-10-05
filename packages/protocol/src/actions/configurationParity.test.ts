import { describe, expect, it } from 'vitest';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import { getActionSpec, listActionCliCommandDeclarations, listActionSpecs } from './actionSpecs.js';
import { createActionExecutor } from './actionExecutor.js';
import { listActionSpecsForCatalogSurface, serializeActionSpec } from './actionCatalog.js';
import { resolveActionSurfaceAvailability } from './actionSurfaceAvailability.js';

describe('client Action placement and CLI availability', () => {
  it('excludes client-owned Actions from CLI discovery without hiding their Agent declarations', () => {
    const cliIds = new Set(listActionSpecsForCatalogSurface({ surface: 'cli' }).map((spec) => spec.id));
    const agentIds = new Set(listActionSpecsForCatalogSurface({ surface: 'agent' }).map((spec) => spec.id));
    const clientSpecs = listActionSpecs().filter((spec) => spec.executionPlacement === 'client');
    const commandIds = new Set(listActionCliCommandDeclarations().map(({ spec }) => spec.id));
    expect(clientSpecs.length).toBeGreaterThan(0);
    for (const spec of clientSpecs) {
      expect(serializeActionSpec(spec).surfaces.cli, spec.id).toBe(false);
      expect(cliIds.has(spec.id), spec.id).toBe(false);
      expect(commandIds.has(spec.id), spec.id).toBe(false);
      expect(resolveActionSurfaceAvailability({ actionId: spec.id, surface: 'cli' }), spec.id).toMatchObject({
        available: false, reason: 'unsupported_surface',
      });
      if (spec.surfaces.agent) expect(agentIds.has(spec.id), spec.id).toBe(true);
    }
    expect(cliIds.has('machines.list')).toBe(true);
    expect(agentIds.has('settings.set')).toBe(true);
  });

  it('reports unsupported CLI settings discovery and execution through the same admission owner', async () => {
    const executor = createActionExecutor({});
    for (const [actionId, input] of [
      ['action.spec.get', { id: 'settings.set' }],
      ['settings.list', { pageId: 'appearance' }],
    ] as const) {
      await expect(executor.execute(actionId, input, { surface: 'cli' })).resolves.toMatchObject({
        ok: false, errorCode: 'action_disabled',
        details: { actionId: actionId === 'action.spec.get' ? 'settings.set' : actionId,
          surface: 'cli', reason: 'unsupported_surface' },
      });
    }
    await expect(executor.execute('settings.list', {}, { surface: 'agent' })).resolves.toMatchObject({
      ok: false, errorCode: 'unsupported_action',
    });
  });
});

describe('notification configuration and app update Action parity', () => {
  it('admits the UI operations through strict, discoverable client Action rows', async () => {
    for (const id of ['notifications.webhooks.list', 'notifications.webhooks.add', 'notifications.webhooks.update',
      'notifications.webhooks.remove', 'notifications.webhooks.signingSecret.set', 'notifications.webhooks.signingSecret.clear',
      'app.updates.get', 'app.updates.check', 'app.updates.update', 'app.updates.retry', 'app.updates.restart', 'app.updates.skip']) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
      const spec = getActionSpec(id as ActionId);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces.agent, id).toBe(true);
      expect(spec.inputSchema.safeParse({ unrelated: true }).success, id).toBe(false);
    }
  });

  it('refuses an unavailable client owner rather than claiming a configured webhook or update', async () => {
    const executor = createActionExecutor({ isApprovalRequired: () => false });
    for (const [id, input] of [['notifications.webhooks.add', { url: 'https://hooks.example.test/notify' }],
      ['app.updates.restart', {}]] as const) {
      await expect(executor.execute(id as ActionId, input, { surface: 'ui', authority: 'present_user' })).resolves.toMatchObject({
        ok: false, errorCode: 'unsupported_action',
      });
    }
  });

  it('keeps signing material out of observers and durable approval custody', async () => {
    const spec = getActionSpec('notifications.webhooks.signingSecret.set' as ActionId);
    expect(spec.inputHints?.fields.find(field => field.path === 'secret')?.widget).toBe('secret');
    expect(spec.projectObservationInput?.({ channelId: 'hook', secret: 'test-only-secret' })).toEqual({ channelId: 'hook' });
    expect(spec.approvalInputCustody).toBe('live_only');
  });
});
