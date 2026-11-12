// Source imports use the same entry owners as the existing per-package probes.
// UI needs its canonical native-platform boundary harness; SDK needs browser
// bundling/evaluation rather than Node's different export conditions.
export const ENTRY_GRAPHS = Object.freeze([
  { id: 'daemon-entry-preparation', entry: 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', cwd: 'apps/cli', tsconfig: 'apps/cli/tsconfig.runtime.json' },
  { id: 'daemon', entry: 'apps/cli/src/daemon/startDaemon.ts', cwd: 'apps/cli', tsconfig: 'apps/cli/tsconfig.runtime.json' },
  { id: 'cli', entry: 'apps/cli/src/index.ts', cwd: 'apps/cli', tsconfig: 'apps/cli/tsconfig.runtime.json' },
  { id: 'voice-inference-worker', entry: 'apps/cli/src/daemon/voiceInference/forkedWorker/workerEntry.ts', cwd: 'apps/cli', tsconfig: 'apps/cli/tsconfig.runtime.json' },
  { id: 'server', entry: 'apps/server/sources/flavors/light/main.ts', cwd: 'apps/server', tsconfig: 'apps/server/tsconfig.json' },
  { id: 'ui-catalog', entry: 'apps/ui/sources/agents/catalog/catalog.test.ts', cwd: 'apps/ui',
    testFiles: ['sources/agents/catalog/catalog.test.ts', 'sources/voice/registry/providerRegistry.test.ts'] },
  { id: 'source-plugin-ui-producer', entry: 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs', cwd: '.', preparationComponent: 'apps/ui',
    conditions: ['happier-source'] },
  { id: 'stack-browser-start', entry: 'apps/stack/scripts/repo_local.mjs', cwd: '.', preparationComponent: 'apps/stack',
    args: ['dev-targets', 'browser', 'start', 'entry-load', '--dry-run'] },
  { id: 'protocol-service-placement-actions', entry: 'packages/protocol/src/actions/specs/projectServicePlacement.ts', cwd: 'packages/protocol' },
  { id: 'protocol-managed-credential-delivery', entry: 'packages/protocol/src/machines/managed/credentialDeliveryV1.ts', cwd: 'packages/protocol' },
  { id: 'protocol-service-placement', entry: 'packages/protocol/src/workspaces/projectServicePlacementV1.ts', cwd: 'packages/protocol' },
  { id: 'protocol-import-cycles', entry: 'apps/cli/scripts/importCycleGuard.mjs', cwd: '.', preparationComponent: 'apps/cli', args: ['--protocol'],
    diagnosticSourceRoot: 'packages/protocol/src' },
  { id: 'sdk-browser', entry: 'packages/sdk/scripts/validateBrowserConsumer.mjs', cwd: 'packages/sdk' },
]);
