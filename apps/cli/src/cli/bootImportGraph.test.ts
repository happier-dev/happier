import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Metafile } from 'esbuild';

import { projectPath } from '@/projectPath';

const cliRoot = projectPath();
const { build } = createRequire(join(cliRoot, 'package.json'))('esbuild') as typeof import('esbuild');

// What the shipped daemon and session host evaluate at start: the static closure of their role
// modules (P03-RUNTIME-SHAPE: 85-93 % of the code each process loads). V8 precise coverage
// (P03-CODE-COVERAGE) runs ~10 % of it; every loaded module keeps its source text, module record
// and loader cache entries for the process lifetime (P03-BOOT-STRUCTURE).
const SESSION_RUNNER_PRELOAD = 'src/agent/runtime/lifecycle/sessionRunnerPreload.ts';
const ROLE_ROOTS = {
  preload: [SESSION_RUNNER_PRELOAD],
  host: ['src/agent/runtime/session/loop/runHostSessionRuntime.ts'],
  daemon: ['src/daemon/startDaemon.ts', 'src/api/apiMachine.ts'],
} as const;
type Role = keyof typeof ROLE_ROOTS;
const START_ROOTS = { ...ROLE_ROOTS, actions: [
  'src/cli/commands/actions.ts', 'src/session/actions/createCliActionExecutorFromCredentials.ts',
] } as const;
type StartRole = Role | 'actions';

// Protocol barrels re-export whole families. A runtime import of one evaluates every module it
// re-exports, including UI-only and generated tables no CLI process runs. Consumers import the
// declaring module's subpath (the Protocol export map publishes every public module).
const PROTOCOL_BARRELS = [
  'packages/protocol/src/index.ts',
  'packages/protocol/src/plugins/ui/index.ts',
] as const;
// Daemon owners the host reached through a shared module and never ran.
const HOST_NEVER_RUN_DAEMON_OWNERS = [
  // The automation claim/run worker; the host only resolves the Account encryption it shares.
  'src/daemon/automation/automationWorker.ts',
  // The daemon's Action operation runtime; the host's Action harness reads one confirmation predicate.
  'src/daemon/actionOperations/createHostActionOperationRuntime.ts',
  // Daemon service status and install planning; only a daemon-service system task reads them.
  'src/daemon/statusSnapshot.ts',
  'src/daemon/service/cli.ts',
] as const;

// Eager modules and source bytes measured on 2026-11-28 after the CLI deferrals.
// Headroom is just under the smallest recorded start-graph win (BOOT-STRUCTURE: 46 daemon modules /
// 0.30 MiB out of the host), so re-adding a waste of that size fails while smaller growth passes.
// Growth with a real start-time consumer raises the measured value in the same change and names the
// consumer; anything else belongs behind a dynamic import.
const HEADROOM = { modules: 45, sourceBytes: 0.29 * 1024 * 1024 };
const MEASURED_START: Record<Role, { modules: number; sourceBytes: number }> = {
  preload: { modules: 4_193, sourceBytes: 36_700_000 },
  host: { modules: 6_333, sourceBytes: 58_570_255 },
  daemon: { modules: 8_613, sourceBytes: 83_953_821 },
};
// The host runs no daemon owner of its own; daemon modules reach it only through shared owners.
const HOST_DAEMON_MODULE_BUDGET = 201;

const normalize = (path: string) => path.replaceAll('\\', '/');
let inputs: Metafile['inputs'];
const eagerGraphs = new Map<StartRole, readonly string[]>();

beforeAll(async () => {
  const { metafile } = await build({
    absWorkingDir: cliRoot, entryPoints: Object.values(START_ROOTS).flat(), outdir: 'unused-boot-import-graph',
    platform: 'node', format: 'esm', bundle: true, splitting: true, write: false, metafile: true,
    conditions: ['happier-source'], external: ['onnxruntime-node', '*.node'], logLevel: 'silent',
  });
  inputs = metafile!.inputs;
  for (const [role, roots] of Object.entries(START_ROOTS) as [StartRole, readonly string[]][]) {
    const eager = new Set<string>();
    const pending = [...roots];
    if (role === 'preload') {
      // Every direct import() is awaited by preloadSessionRunner's Promise.all.
      for (const dependency of inputs[SESSION_RUNNER_PRELOAD]!.imports) {
        if (dependency.kind === 'dynamic-import' && !dependency.external) pending.push(dependency.path);
      }
    }
    while (pending.length > 0) {
      const path = pending.pop()!;
      if (eager.has(path)) continue;
      eager.add(path);
      for (const dependency of inputs[path]?.imports ?? []) {
        if (!dependency.external && dependency.kind !== 'dynamic-import') pending.push(dependency.path);
      }
    }
    eagerGraphs.set(role, [...eager]);
  }
}, 240_000);

const roleGraph = (role: StartRole) => eagerGraphs.get(role)!;
const endsWithAny = (path: string, suffixes: readonly string[]) => suffixes.some((suffix) => normalize(path).endsWith(suffix));

describe('daemon, session host, Session runner preload and finite Action start graphs', () => {
  it('have no runtime importer of a Protocol barrel', () => {
    const importerCounts = Object.fromEntries((Object.keys(START_ROOTS) as StartRole[]).map((role) => [role,
      roleGraph(role).filter((path) => (inputs[path]?.imports ?? []).some((dependency) =>
        dependency.kind !== 'dynamic-import' && !dependency.external && endsWithAny(dependency.path, PROTOCOL_BARRELS))).length]));
    expect(importerCounts).toEqual({ preload: 0, host: 0, daemon: 0, actions: 0 });
  });

  it('keep never-run daemon owners out of the session host', () => {
    expect(roleGraph('host').filter((path) => endsWithAny(path, HOST_NEVER_RUN_DAEMON_OWNERS)).map(normalize)).toEqual([]);
  });

  it('stay within each role start budget', () => {
    const measured = Object.fromEntries((Object.keys(ROLE_ROOTS) as Role[]).map((role) => [role, {
      modules: roleGraph(role).length,
      sourceBytes: roleGraph(role).reduce((sum, path) => sum + (inputs[path]?.bytes ?? 0), 0),
    }]));
    const over = Object.fromEntries((Object.keys(ROLE_ROOTS) as Role[]).map((role) => [role, {
      modules: Math.max(0, measured[role]!.modules - MEASURED_START[role].modules - HEADROOM.modules),
      sourceBytes: Math.max(0, measured[role]!.sourceBytes - MEASURED_START[role].sourceBytes - HEADROOM.sourceBytes),
    }]));
    expect(over, `measured ${JSON.stringify(measured)}`).toEqual({
      preload: { modules: 0, sourceBytes: 0 },
      host: { modules: 0, sourceBytes: 0 },
      daemon: { modules: 0, sourceBytes: 0 },
    });
    const hostDaemonModules = roleGraph('host').filter((path) => normalize(path).startsWith('src/daemon/')).length;
    expect(Math.max(0, hostDaemonModules - HOST_DAEMON_MODULE_BUDGET), `host src/daemon modules ${hostDaemonModules}`).toBe(0);
  });
});
