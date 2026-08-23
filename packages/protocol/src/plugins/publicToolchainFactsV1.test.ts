import { describe, expect, it } from 'vitest';

import {
  PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_DESCRIPTOR,
  PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_DESCRIPTOR,
} from '../installables/definitions/pluginUiBundlers.js';
import { PLUGIN_RUNTIME_API_VERSION } from './manifest/v2.js';
import { PUBLIC_TOOLCHAIN_PROTOCOL_FACTS_V1 } from './publicToolchainFactsV1.js';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from './ui/hostApiDefinition.js';
import { PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1 } from './ui/uiArtifactsManifest.js';

describe('public toolchain Protocol facts', () => {
  it('projects the executable owners without copying their literals', () => {
    expect(PUBLIC_TOOLCHAIN_PROTOCOL_FACTS_V1).toEqual({
      runtimeApiVersion: PLUGIN_RUNTIME_API_VERSION,
      ui: {
        artifactGrammarVersion: PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1,
        hostApiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
      },
      bundlers: {
        vite: {
          packageName: PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_DESCRIPTOR.source.packageName,
          executable: PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_DESCRIPTOR.binary.commands[0],
        },
        repack: {
          packageName: PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_DESCRIPTOR.source.packageName,
          executable: PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_DESCRIPTOR.binary.commands[0],
        },
      },
    });
  });
});
