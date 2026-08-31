// @ts-check

// Central registry for release components.
// Keep this as the single source of truth for:
// - changed-path classification (release planning)
// - version file locations (version bumps)
//
// This is intentionally JS (not YAML) so both scripts and workflows can consume it.

export const releaseTargets = Object.freeze([
  'ui',
  'server',
  'website',
  'docs',
  'cli',
  'stack',
  'server_runner',
]);

export const components = Object.freeze({
  ui: {
    id: 'ui',
    changedPrefixes: ['apps/ui/'],
  },
  bootstrap: {
    id: 'bootstrap',
    changedPrefixes: ['apps/bootstrap/'],
  },
  cli: {
    id: 'cli',
    changedPrefixes: ['apps/cli/'],
  },
  cliCommon: {
    id: 'cliCommon',
    changedPrefixes: ['packages/cli-common/'],
  },
  connectionSupervisor: {
    id: 'connectionSupervisor',
    changedPrefixes: ['packages/connection-supervisor/'],
  },
  transfers: {
    id: 'transfers',
    changedPrefixes: ['packages/transfers/'],
  },
  releaseRuntime: {
    id: 'releaseRuntime',
    changedPrefixes: ['packages/release-runtime/'],
  },
  audioStreamNative: {
    id: 'audioStreamNative',
    changedPrefixes: ['packages/audio-stream-native/'],
  },
  sherpaNative: {
    id: 'sherpaNative',
    changedPrefixes: ['packages/sherpa-native/'],
  },
  server: {
    id: 'server',
    changedPrefixes: ['apps/server/', 'packages/relay-server/', 'packages/privacy-kit/'],
  },
  stack: {
    id: 'stack',
    changedPrefixes: ['apps/stack/'],
  },
  website: {
    id: 'website',
    changedPrefixes: ['apps/website/', 'scripts/release/installers/'],
    // sync-installers.mjs is a website-facing artifact pipeline.
    changedFiles: ['scripts/pipeline/release/sync-installers.mjs'],
  },
  docs: {
    id: 'docs',
    changedPrefixes: ['apps/docs/'],
  },
  shared: {
    id: 'shared',
    changedPrefixes: ['packages/agents/', 'packages/protocol/'],
  },
  workspaceGraph: {
    id: 'workspaceGraph',
    changedFiles: ['package.json', 'yarn.lock'],
  },
});

export const versionedComponents = Object.freeze({
  app: {
    id: 'app',
    baselineTagPrefix: 'ui-web-v',
    changedWhen: ['ui', 'bootstrap', 'shared', 'workspaceGraph', 'cliCommon', 'connectionSupervisor', 'transfers', 'releaseRuntime', 'audioStreamNative', 'sherpaNative'],
  },
  cli: {
    id: 'cli',
    baselineTagPrefix: 'cli-v',
    changedWhen: ['cli', 'shared', 'workspaceGraph', 'cliCommon', 'connectionSupervisor', 'transfers', 'releaseRuntime'],
  },
  stack: {
    id: 'stack',
    baselineTagPrefix: 'stack-v',
    changedWhen: ['stack', 'shared', 'workspaceGraph', 'cliCommon', 'connectionSupervisor', 'releaseRuntime'],
  },
  server: {
    id: 'server',
    baselineTagPrefix: 'server-v',
    changedWhen: ['server', 'shared', 'workspaceGraph', 'cliCommon', 'releaseRuntime'],
  },
});

export function classifyChangedPaths(paths) {
  const flags = Object.create(null);
  for (const key of Object.keys(components)) flags[key] = false;

  for (const p of paths) {
    if (!p) continue;
    for (const [key, def] of Object.entries(components)) {
      if (def.changedFiles && def.changedFiles.includes(p)) {
        flags[key] = true;
        continue;
      }
      for (const prefix of def.changedPrefixes ?? []) {
        if (p.startsWith(prefix)) {
          flags[key] = true;
          break;
        }
      }
    }
  }

  return flags;
}

export function deriveVersionedComponentChanges(classified) {
  const flags = Object.create(null);
  for (const [key, def] of Object.entries(versionedComponents)) {
    flags[key] = def.changedWhen.some((componentKey) => Boolean(classified[componentKey]));
  }
  return flags;
}
