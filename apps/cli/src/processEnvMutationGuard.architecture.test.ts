import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url));

const BOOTSTRAP_MUTATION_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  'agent/runtime/readSessionAttachMetadataIdentityPolicyFromEnv.ts': 'Consumes and clears a one-shot attach policy.',
  'agent/runtime/sessionAttach.ts': 'Consumes and clears a one-shot session-attach file.',
  'capabilities/systemTasks/ssh/liveRemoteSshBootstrap.ts': 'Temporarily installs a verified remote bootstrap environment and restores it in a finally path.',
  'cli/commands/auth/login.ts': 'Sets process-wide flags before the login bootstrap owns the process.',
  'cli/commands/mcp/serve.ts': 'Isolates the dedicated MCP serve process before its runtime starts.',
  'cli/commands/relay/subcommands.ts': 'Selects a relay server for the dedicated command process and restores scoped overrides.',
  'cli/commands/resume.ts': 'Scopes one-shot attach/resume inputs and restores them in a finally path.',
  'cli/commands/self/maybeRunVersionGatedRuntimeMigration.ts': 'Scopes installer-migration bootstrap flags and restores them in a finally path.',
  'server/serverSelection.ts': 'Owns process-wide active-server selection before session execution.',
  'settings/applyAccountSettingsToProcessEnv.ts': 'Projects account-wide CLI bootstrap settings, never per-session profile/provider data.',
  'ui/auth.ts': 'Owns authenticated process-wide server selection during CLI bootstrap.',
});

const PROCESS_ENV_MUTATION_PATTERN = /(?:\bdelete\s+process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])|\bprocess\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*(?:\?\?=|\|\|=|&&=|=(?!=))|\bObject\.assign\s*\(\s*process\.env\b)/gu;

const RETIRED_MANAGED_SERVICE_ENDPOINT_PROJECTION_ENV_IDENTIFIERS = Object.freeze([
  'HAPPIER_MANAGED_SERVICE_ENDPOINT_PROJECTION_ROOT_ENV_KEY',
  'HAPPIER_MANAGED_SERVER_ENDPOINT_PROJECTION_ROOT',
]);

function listProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listProductionTypeScriptFiles(path);
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    if (
      entry.name.endsWith('.test.ts')
      || entry.name.endsWith('.spec.ts')
      || entry.name === 'vitestSetup.ts'
      || entry.name.startsWith('test-setup')
      || path.includes('/testkit/')
    ) {
      return [];
    }
    return [path];
  });
}

function mutationLocations(path: string): readonly string[] {
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(PROCESS_ENV_MUTATION_PATTERN)].map((match) => {
    const line = source.slice(0, match.index).split('\n').length;
    return `${relative(SOURCE_ROOT, path)}:${line}`;
  });
}

describe('process.env mutation architecture guard', () => {
  it('keeps managed-service endpoint projection request-scoped instead of process-global', () => {
    const offenders = listProductionTypeScriptFiles(SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return RETIRED_MANAGED_SERVICE_ENDPOINT_PROJECTION_ENV_IDENTIFIERS
        .filter((identifier) => source.includes(identifier))
        .map((identifier) => `${identifier}: ${relative(SOURCE_ROOT, path)}`);
    });

    expect(offenders).toEqual([]);
  });

  it('keeps runtime process.env mutation inside reviewed process-bootstrap owners', () => {
    const mutations = listProductionTypeScriptFiles(SOURCE_ROOT).flatMap((path) => mutationLocations(path));
    const unexpected = mutations.filter((location) => {
      const path = location.slice(0, location.lastIndexOf(':'));
      return !(path in BOOTSTRAP_MUTATION_ALLOWLIST);
    });

    expect(unexpected).toEqual([]);
    for (const allowedPath of Object.keys(BOOTSTRAP_MUTATION_ALLOWLIST)) {
      expect(mutations.some((location) => location.startsWith(`${allowedPath}:`))).toBe(true);
    }
  });
});
