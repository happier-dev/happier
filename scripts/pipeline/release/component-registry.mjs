// @ts-check

// Central registry for release components.
// Keep this as the single source of truth for:
// - changed-path classification (release planning)
// - version file locations (version bumps)
//
// This is intentionally JS (not YAML) so both scripts and workflows can consume it.

export const components = Object.freeze({
  ui: {
    id: 'ui',
    changedPrefixes: ['apps/ui/'],
  },
  cli: {
    id: 'cli',
    changedPrefixes: ['apps/cli/'],
  },
  server: {
    id: 'server',
    changedPrefixes: ['apps/server/', 'packages/relay-server/', 'packages/privacy-kit/'],
  },
  stack: {
    id: 'stack',
    changedPrefixes: ['apps/stack/'],
  },
  cli_stack_shared: {
    id: 'cli_stack_shared',
    changedPrefixes: ['packages/cli-common/'],
  },
  ui_dependencies: {
    id: 'ui_dependencies',
    changedPrefixes: [
      'packages/audio-stream-native/',
      'packages/connection-supervisor/',
      'packages/peer-mediation/',
      'packages/plugin-sdk/',
      'packages/plugin-ui/',
      'packages/plugins/auggie/',
      'packages/plugins/claude/',
      'packages/plugins/codex/',
      'packages/plugins/elevenlabs/',
      'packages/plugins/google/',
      'packages/plugins/opencode/',
      'packages/plugins/openai/',
      'packages/plugins/openai-compat/',
      'packages/plugins/pi/',
      'packages/plugins/xai/',
      'packages/release-runtime/',
      'packages/sherpa-native/',
      'packages/ssh-native/',
      'packages/terminal-native/',
      'packages/transfers/',
      'packages/voice-modelpacks/',
    ],
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
});

export const versionedComponents = Object.freeze({
  app: {
    id: 'app',
    baselineTagPrefix: 'ui-web-v',
    changedWhen: ['ui', 'shared', 'cli_stack_shared', 'ui_dependencies'],
  },
  cli: {
    id: 'cli',
    baselineTagPrefix: 'cli-v',
    changedWhen: ['cli', 'shared', 'cli_stack_shared'],
  },
  stack: {
    id: 'stack',
    baselineTagPrefix: 'stack-v',
    changedWhen: ['stack', 'shared', 'cli_stack_shared'],
  },
  server: {
    id: 'server',
    baselineTagPrefix: 'server-v',
    changedWhen: ['server', 'shared', 'cli_stack_shared'],
  },
});

// Release dispatch targets are broader than versioned components: website,
// docs, and the server runner can be selected without adding a versioned
// component entry. Keep the local CLI and public release contract aligned here.
export const releaseTargets = Object.freeze([
  'ui',
  'server',
  'website',
  'docs',
  'cli',
  'stack',
  'server_runner',
]);

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
