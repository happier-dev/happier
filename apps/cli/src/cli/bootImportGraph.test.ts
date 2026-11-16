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
const ROLE_ROOTS = {
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

describe('daemon, session host and finite Action start graphs', () => {
  it('have no runtime importer of a Protocol barrel', () => {
    const importerCounts = Object.fromEntries((Object.keys(START_ROOTS) as StartRole[]).map((role) => [role,
      roleGraph(role).filter((path) => (inputs[path]?.imports ?? []).some((dependency) =>
        dependency.kind !== 'dynamic-import' && !dependency.external && endsWithAny(dependency.path, PROTOCOL_BARRELS))).length]));
    expect(importerCounts).toEqual({ host: 0, daemon: 0, actions: 0 });
  });

  it('keep never-run daemon owners out of the session host', () => {
    expect(roleGraph('host').filter((path) => endsWithAny(path, HOST_NEVER_RUN_DAEMON_OWNERS)).map(normalize)).toEqual([]);
  });
});
