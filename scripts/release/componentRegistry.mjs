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
    changedPrefixes: ['apps/server/'],
  },
  stack: {
    id: 'stack',
    changedPrefixes: ['apps/stack/'],
  },
  website: {
    id: 'website',
    changedPrefixes: ['apps/website/', 'scripts/release/installers/'],
    // sync-installers.mjs is a website-facing artifact pipeline.
    changedFiles: ['scripts/release/sync-installers.mjs'],
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
