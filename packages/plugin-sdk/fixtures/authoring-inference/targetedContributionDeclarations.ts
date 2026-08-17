import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  defineContributionPoint,
  defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';
import {
  defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';

const resultSchema = defineProtocolObject({}, { policy: 'closed' });

const protocol = defineContributionProtocol({
  id: 'example.declaration-target',
  version: 1,
  operations: {
    inspect: {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema,
      action: { surface: 'plugin', dangerLevel: 'safe' },
    },
  },
});

export const contributionTarget = definePlugin({
  id: 'example.declaration-target',
  version: '0.1.0',
  contributionPoints: {
    providers: defineContributionPoint([protocol]),
  },
});
