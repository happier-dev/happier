import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

export const qaProtocol = defineContributionProtocol({
  id: 'qa-native-sources',
  version: 1,
  descriptor: defineProtocolObject({ label: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
  operations: {},
  surfaces: {
    detail: {
      required: true,
      inputSchema: defineProtocolObject({ qaId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
      presentation: 'content',
    },
  },
});
