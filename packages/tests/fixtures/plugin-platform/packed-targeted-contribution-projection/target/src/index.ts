import { definePlugin } from '@happier-dev/plugin-sdk';

import { packedTargetedContributionProtocol } from './protocol.js';

const plugin = definePlugin({
  id: 'examples.packed-targeted-projection-target',
  version: '1.0.0',
  displayName: 'Packed Targeted Projection Target',
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  contributionPoints: {
    providers: packedTargetedContributionProtocol.point(),
  },
});

export const { manifest, activate } = plugin;
