import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import {
  getActionSpec,
  type PluginActionInputById,
  type PluginActionResultById,
  type PluginInvocableActionId,
} from './actionSpecs.js';
import {
  PluginWebhookActionInputSchemasV1,
  PluginWebhookActionOutputSchemasV1,
  type PluginWebhookActionIdV1,
  type PluginWebhookPresentUserActionIdV1,
} from '../plugins/webhooks/endpointV1.js';

type PluginWebhookPluginActionIdV1 = Exclude<
  PluginWebhookActionIdV1,
  PluginWebhookPresentUserActionIdV1
>;

const PRESENT_USER_ACTION_IDS = [
  'plugin.webhook.endpoint.ensure',
  'plugin.webhook.endpoint.read',
  'plugin.webhook.endpoint.revoke',
  'plugin.webhook.endpoint.retarget',
  'plugin.webhook.delivery.movePending',
  'plugin.webhook.endpoint.credential.configure',
  'plugin.webhook.endpoint.credential.rotate',
  'plugin.webhook.endpoint.credential.finishRotation',
] as const;

describe('webhook endpoint ActionSpecs', () => {
  it('exposes lifecycle and Account-route credential operations only to present-user surfaces', () => {
    for (const actionId of PRESENT_USER_ACTION_IDS) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces).toEqual(expect.objectContaining({
        ui: true,
        cli: true,
        plugin: false,
      }));
      expect(spec.inputSchema).toBeDefined();
      expect(spec.outputSchema).toBeDefined();
    }
  });

  it('keeps correspondence on the plugin surface only', () => {
    const spec = getActionSpec('plugin.webhook.endpoint.checkCorrespondence');
    expectTypeOf<Extract<PluginInvocableActionId, PluginWebhookPluginActionIdV1>>()
      .toEqualTypeOf<PluginWebhookPluginActionIdV1>();
    expectTypeOf<PluginActionInputById[PluginWebhookPluginActionIdV1]>()
      .toEqualTypeOf<z.input<typeof PluginWebhookActionInputSchemasV1[PluginWebhookPluginActionIdV1]>>();
    expectTypeOf<PluginActionResultById[PluginWebhookPluginActionIdV1]>()
      .toEqualTypeOf<z.output<typeof PluginWebhookActionOutputSchemasV1[PluginWebhookPluginActionIdV1]>>();
    expect(spec.surfaces).toEqual(expect.objectContaining({
      ui: false,
      cli: false,
      plugin: true,
    }));
  });
});
