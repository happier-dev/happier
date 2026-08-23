import {
  PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_DESCRIPTOR,
  PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_DESCRIPTOR,
} from '../installables/definitions/pluginUiBundlers.js';
import type { InstallableDependencyDescriptor } from '../installables/descriptor.js';
import { PLUGIN_RUNTIME_API_VERSION } from './manifest/v2.js';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from './ui/hostApiDefinition.js';
import { PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1 } from './ui/uiArtifactsManifest.js';

function projectBundler(
  descriptor: InstallableDependencyDescriptor,
): Readonly<{ packageName: string; executable: string }> {
  const packageName = descriptor.source.kind === 'managed_package'
    ? descriptor.source.packageName
    : undefined;
  const executable = descriptor.binary.commands[0];
  if (!packageName || !executable) {
    throw new Error(`Public Plugin UI bundler ${descriptor.id} has no managed package command`);
  }
  return Object.freeze({ packageName, executable });
}

/** Executable Protocol-owned facts consumed by the public authoring packet. */
export const PUBLIC_TOOLCHAIN_PROTOCOL_FACTS_V1 = Object.freeze({
  runtimeApiVersion: PLUGIN_RUNTIME_API_VERSION,
  ui: Object.freeze({
    artifactGrammarVersion: PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1,
    hostApiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
  }),
  bundlers: Object.freeze({
    vite: projectBundler(PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_DESCRIPTOR),
    repack: projectBundler(PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_DESCRIPTOR),
  }),
});
