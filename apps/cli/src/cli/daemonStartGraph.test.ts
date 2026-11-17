import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Metafile } from 'esbuild';

import { projectPath } from '@/projectPath';

const cliRoot = projectPath();
const repoDir = join(cliRoot, '../..');
const requireFromCli = createRequire(join(cliRoot, 'package.json'));
const esbuild = requireFromCli('esbuild') as typeof import('esbuild');

// What `happier daemon start-sync` evaluates before the Machine is online: the process path through the
// CLI entry, plus the Machine client that `api.ts` loads at start. Measured on the shipped payload
// (P03-LEAN-DAEMON-2 trace, 2026-11-17): the idle daemon loads these modules' static closure and,
// beyond it, only machine-role entries, its workers and storage maintenance.
const DAEMON_START_ROOTS = [
  'apps/cli/src/index.ts',
  'apps/cli/src/cli/compileCache.ts',
  'apps/cli/src/cli/bootstrap.ts',
  'apps/cli/src/cli/commands/daemon.ts',
  'apps/cli/src/cli/commands/daemonControl.ts',
  'apps/cli/src/daemon/startDaemon.ts',
  'apps/cli/src/api/apiMachine.ts',
] as const;

// Push, relay, Session hosting, spawn admission, local control and the plugin runtime: a person's next
// action waits on these, so they load with the daemon, never through an `import()` at first use.
const HOT_OWNERS = [
  'apps/cli/src/daemon/machine/bootstrapMachineSyncRuntime.ts',
  'apps/cli/src/daemon/peer/iroh/daemonMachineIrohRuntime.ts',
  'apps/cli/src/daemon/peer/mediation/loopback/server.ts',
  'apps/cli/src/daemon/peer/mediation/tunnel/open.ts',
  'apps/cli/src/daemon/sessionHost/daemonSessionHost.ts',
  'apps/cli/src/daemon/spawn/createSpawnConcurrencyGate.ts',
  'apps/cli/src/daemon/spawn/recoveredSpawnNonceAdmission.ts',
  'apps/cli/src/daemon/controlServer.ts',
  'apps/cli/src/plugins/daemon/runtimeOwner.ts',
] as const;

// Owners the idle daemon never runs (same trace, N=0): each loads at its own first use, in the daemon
// or in the process that owns it. A static edge from the start graph would load it in every daemon.
const COLD_OWNERS = [
  // Environment service restore and deployment Action dependencies: only a configured service, a
  // service-export binding or a deployment child RPC (P03-CODE-COVERAGE).
  'apps/cli/src/deployments/targets/ownServer/restoreOwnServerServicesForHost.ts',
  'apps/cli/src/deployments/createDaemonDeploymentActionDeps.ts',
  // Session runtime and Session MCP: the session host's, not the daemon's.
  'apps/cli/src/agent/runtime/session/loop/runHostSessionRuntime.ts',
  'apps/cli/src/agent/runtime/session/loop/lifecycle.ts',
  'apps/cli/src/mcp/startHappyServer.ts',
  'apps/cli/src/agent/acp/createAcpBackend.ts',
  // Memory indexing runs in the memory worker child.
  'apps/cli/src/daemon/memory/memoryIndexerServiceEntry.ts',
  // Legacy-secret Account repair and portable CommonJS plugin artifacts: rare paths.
  'apps/cli/src/cli/commands/auth/nativeEmail.ts',
  'apps/cli/src/plugins/runtime/portableCommonJs.ts',
  // CLI commands run in short-lived CLI processes.
  'apps/cli/src/cli/commands/mcp.ts',
  'apps/cli/src/cli/commands/actions.ts',
  'apps/cli/src/cli/commands/browser.ts',
  'apps/cli/src/cli/commands/session/index.ts',
  'apps/cli/src/cli/commands/plugins.ts',
  'apps/cli/src/cli/commands/setup.ts',
  'apps/cli/src/cli/commands/resume.ts',
] as const;

let inputs: Metafile['inputs'];
let startGraph: ReadonlySet<string>;

beforeAll(async () => {
  type SourceEntries = { readCliSourceEntries(input: object): Promise<{ entries: Record<string, string> }>;
    readWorkspacePackages(dir: string): Promise<Map<string, unknown>>; createWorkspaceSourceResolver(input: object): import('esbuild').Plugin;
    SOURCE_CONDITION: string; SOURCE_RUNTIME_OUTPUT_OPTIONS: object };
  const owner = await import(pathToFileURL(join(repoDir, 'packages/cli-common/sourceRuntimeEntries.mjs')).href) as SourceEntries;
  const manifest = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));
  const { entries } = await owner.readCliSourceEntries({ repoDir, manifest, transform: esbuild.transform });
  // The single CLI graph every shipped process loads from (every entry, one split graph).
  const { metafile } = await esbuild.build({
    absWorkingDir: repoDir, entryPoints: entries, outdir: 'unused-daemon-start-graph', write: false, metafile: true,
    bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent',
    ...owner.SOURCE_RUNTIME_OUTPUT_OPTIONS, conditions: [owner.SOURCE_CONDITION],
    plugins: [owner.createWorkspaceSourceResolver({ workspacePackages: await owner.readWorkspacePackages(repoDir),
      requireFromProject: requireFromCli })],
  });
  inputs = metafile.inputs;
  const eager = new Set<string>();
  const pending: string[] = [...DAEMON_START_ROOTS];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (eager.has(path) || !inputs[path]) continue;
    eager.add(path);
    for (const edge of inputs[path].imports ?? []) {
      if (!edge.external && edge.kind !== 'dynamic-import') pending.push(edge.path);
    }
  }
  startGraph = eager;
}, 600_000);

describe('daemon start graph in the single CLI graph', () => {
  it('starts from modules that exist in the graph', () => {
    expect(DAEMON_START_ROOTS.filter((root) => !inputs[root])).toEqual([]);
  });

  it('keeps the hot-path owners resident', () => {
    expect(HOT_OWNERS.filter((owner) => !startGraph.has(owner))).toEqual([]);
  });

  it('keeps owners the idle daemon never runs out of it', () => {
    expect(COLD_OWNERS.filter((owner) => !inputs[owner]), 'cold owners must stay bundled').toEqual([]);
    expect(COLD_OWNERS.filter((owner) => startGraph.has(owner))).toEqual([]);
  });
});
