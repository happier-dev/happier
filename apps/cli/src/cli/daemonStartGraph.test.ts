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
  // Request dispatch is cold. The handlers and independently triggered observation stay registered.
  'apps/cli/src/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction.ts',
  'apps/cli/src/session/actions/externalSessions/takeoverAction.ts',
  'apps/cli/src/session/actions/externalSessions/transcriptActions.ts',
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
  startGraph = eagerClosure(DAEMON_START_ROOTS);
}, 600_000);

function eagerClosure(roots: readonly string[]): ReadonlySet<string> {
  const eager = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (eager.has(path) || !inputs[path]) continue;
    eager.add(path);
    for (const edge of inputs[path].imports ?? []) {
      if (!edge.external && edge.kind !== 'dynamic-import') pending.push(edge.path);
    }
  }
  return eager;
}

describe('daemon start graph in the single CLI graph', () => {
  it('starts from modules that exist in the graph', () => {
    expect(DAEMON_START_ROOTS.filter((root) => !inputs[root])).toEqual([]);
  });

  it('keeps the hot-path owners resident', () => {
    expect(HOT_OWNERS.filter((owner) => !startGraph.has(owner))).toEqual([]);
  });

  it('keeps the Protocol root barrel out of the full daemon startup graph', () => {
    expect(startGraph.has('packages/protocol/src/index.ts')).toBe(false);
  });

  it('loads boot credential and policy parsers without loading Action admission', () => {
    const bootReaders = [
      'apps/cli/src/api/client/credentialAxios.ts',
      'apps/cli/src/auth/cliApiToken.ts',
      'packages/cli-common/src/organizationPolicy/readOrganizationPolicyFile.ts',
    ] as const;
    const admission = [
      'packages/protocol/src/actions/externalActionApi.ts',
      'packages/protocol/src/auth/apiTokenGrant.ts',
      'packages/protocol/src/sessions/creation/sessionSpawnNewResultV1.ts',
    ] as const;
    expect(bootReaders.filter((reader) => !inputs[reader])).toEqual([]);
    expect(bootReaders.flatMap((reader) => {
      const graph = eagerClosure([reader]);
      return admission.filter((owner) => graph.has(owner)).map((owner) => [reader, owner]);
    })).toEqual([]);
  });

  it('registers native Action RPC methods without importing the full Action catalog from the registrar', () => {
    const registrar = 'apps/cli/src/rpc/handlers/registerActionSpecRpcHandlers.ts';
    expect(startGraph.has(registrar)).toBe(true);
    const eagerCatalogImports = inputs[registrar].imports.filter((edge) =>
      edge.path === 'packages/protocol/src/actions/actionSpecs.ts' && edge.kind !== 'dynamic-import');
    expect(eagerCatalogImports.map((edge) => edge.path)).toEqual([]);
  });

  it('keeps daemon and Session host control transport imports at their owners', () => {
    const coldEdges = [
      ['apps/cli/src/api/session/sockets.ts', 'packages/protocol/src/sessions/index.ts'],
      ['apps/cli/src/session/transport/rpc/localSessionRpcChannel.ts',
        'packages/protocol/src/sessions/metadata/sessionMetadataSchemasV1.ts'],
      ['apps/cli/src/session/transport/rpc/localSessionRpcChannel.ts',
        'apps/cli/src/agent/runtime/session/process/agentRuntimeRunnerProtocol.ts'],
      ['apps/cli/src/daemon/externalActions/daemonExternalActionTargetResolver.ts',
        'apps/cli/src/daemon/workflows/recovery.ts'],
    ] as const;
    expect(coldEdges.filter(([owner, dependency]) => {
      const ownerInput = inputs[owner];
      expect(ownerInput, owner).toBeDefined();
      return ownerInput.imports.some((edge) => edge.path === dependency && edge.kind !== 'dynamic-import');
    })).toEqual([]);
  });

  it('loads Agent-only runtime contracts without the full plugin contribution catalog', () => {
    const agentConsumers = [
      'apps/cli/src/agent/runtime/session/process/agentRuntimeRunnerProtocol.ts',
      'apps/cli/src/agent/runtime/session/loop/runHostSessionRuntime.ts',
      'apps/cli/src/daemon/spawn/prepareAgentRuntimeSessionBridge.ts',
    ];
    const aggregate = 'packages/protocol/src/plugins/contributions/v2.ts';
    expect(agentConsumers.filter((owner) => {
      const ownerInput = inputs[owner];
      expect(ownerInput, owner).toBeDefined();
      return ownerInput.imports.some((edge) => edge.path === aggregate && edge.kind !== 'dynamic-import');
    })).toEqual([]);
  });

  it('loads Workflow approval and settings declaration owners at request dispatch', () => {
    const demandEdges = [
      ['apps/cli/src/session/actions/workflowFamily.ts', 'apps/cli/src/daemon/workflows/workflowApprovedOperation.ts'],
      ['apps/cli/src/session/actions/cliActionDeps/settings.ts', 'apps/cli/src/session/actions/settingsDeclarationAction.ts'],
    ] as const;
    expect(demandEdges.filter(([owner, dependency]) =>
      !inputs[owner]?.imports.some(edge => edge.path === dependency && edge.kind === 'dynamic-import'))).toEqual([]);
  });

  it('keeps owners the idle daemon never runs out of it', () => {
    expect(COLD_OWNERS.filter((owner) => !inputs[owner]), 'cold owners must stay bundled').toEqual([]);
    expect(COLD_OWNERS.filter((owner) => startGraph.has(owner))).toEqual([]);
  });
});
