import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

import {
  ISSUE_SURFACE_ARTIFACT_ID,
  ISSUE_SURFACE_REPACK_MODULE,
  ISSUE_SURFACE_SOURCE_ENTRY,
} from './src/uiBuildIdentity.mjs';

export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  targets: [{
    rendererId: ISSUE_SURFACE_ARTIFACT_ID,
    entry: ISSUE_SURFACE_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: ISSUE_SURFACE_REPACK_MODULE,
  }],
});

export default pluginUiBuildConfig;
