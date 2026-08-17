import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate, manifest } from './index.js';
import { exerciseActionsService } from './actions.js';
import { activate as manualActivate, manifest as manualManifest } from './manual.js';
import {
  managedProviderActivate,
  managedProviderManifest,
  managedProviderRuntime,
} from './managedProvider.js';
import { exercisePublicServices } from './publicServices.js';
import { exerciseTestkit } from './testing.js';

if (manifest.id !== 'example.inference' || typeof activate !== 'function') {
  throw new Error('definePlugin did not expose the expected named ABI');
}
if (!manifest.contributes.promptAssets.some((entry) => (
  entry.id === 'external-skills'
  && entry.adapterDescriptor?.id === 'example.inference.skill'
))) {
  throw new Error('definePlugin did not project the external Prompt Asset authoring fixture');
}
if (manualManifest.id !== 'example.manual' || typeof manualActivate !== 'function') {
  throw new Error('manual authoring did not expose the expected named ABI');
}

const managedProviderTestkit = await createPluginTestkit({
  manifest: managedProviderManifest,
  module: { activate: managedProviderActivate },
});
try {
  const registeredProviderRuntime = managedProviderTestkit.registration('providers', 'gateway');
  if (!registeredProviderRuntime
    || registeredProviderRuntime === managedProviderRuntime
    || registeredProviderRuntime.start === managedProviderRuntime.start) {
    throw new Error('Provider-only fixture did not publish a host-owned runtime snapshot');
  }
  let invokedDeclaredRuntime = false;
  try {
    await registeredProviderRuntime.start({} as never, {} as never);
  } catch (error) {
    invokedDeclaredRuntime = error instanceof Error
      && error.message === 'Fixture does not start the managed Provider';
  }
  if (!invokedDeclaredRuntime) {
    throw new Error('Provider-only fixture did not invoke its exact declared runtime callback');
  }
} finally {
  await managedProviderTestkit.dispose();
}

await exerciseTestkit();
await exerciseActionsService();
await exercisePublicServices();
