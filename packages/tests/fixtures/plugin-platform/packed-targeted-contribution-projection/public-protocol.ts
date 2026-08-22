import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import {
  defineProtocolObject,
  defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';

export const packedTargetedSetupResultSchema = defineProtocolObject(
  {},
  { policy: 'closed' },
);

/**
 * This source is copied unchanged into each separately packed external plugin.
 * It relies only on the published SDK authoring surface; the target owns the
 * protocol semantics and the contributor owns its Action and renderer.
 */
export const packedTargetedContributionProtocol = defineContributionProtocol({
  id: 'packed-targeted-projection',
  version: 1,
  descriptor: defineProtocolObject({
    providerId: defineProtocolString(),
  }, { policy: 'additive-open/drop' }),
  operations: {
    setup: {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema: packedTargetedSetupResultSchema,
      action: { surface: 'plugin', dangerLevel: 'safe' },
    },
  },
  surfaces: {
    detail: {
      required: true,
      inputSchema: defineProtocolObject({
        reviewId: defineProtocolString(),
      }, { policy: 'closed' }),
      presentation: 'content',
    },
  },
});
