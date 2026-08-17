import { definePlugin } from '@happier-dev/plugin-sdk';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import { triageSourcesV1 } from '@happier-dev/triage-sources-protocol/v1';

const plugin = definePlugin({
  id: 'examples.triage-source-target',
  version: '0.1.0',
  displayName: 'Triage Source Target',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  contributionPoints: {
    sources: triageSourcesV1.point(),
  },
});

export const { manifest, activate } = plugin;
