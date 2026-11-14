import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';

const cliRoot = projectPath();
const { build } = createRequire(join(cliRoot, 'package.json'))('esbuild') as typeof import('esbuild');

// V8 precise coverage of the shipped daemon and session host over boot, idle,
// spawn, turns and Stop (P03-CODE-COVERAGE) found these owners loaded at start
// but never executed. Each loads on first use at its real entry point instead.
// Every module a process loads keeps its source text, module record and loader
// cache entries for the process lifetime.
const HOST_COLD = [
  // Account plugin execution: only a credentialed plugin Action reads it.
  'src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts',
  // Approval execution-origin currentness: only an approved operation checks it.
  'src/daemon/externalActions/daemonExternalActionTargetResolver.ts',
  // Agent preflight/install probes: a rare capabilities RPC.
  'src/capabilities/probes/agentPreflight.ts',
] as const;
// The Claude plugin runtime loads as its own plugin entry in both processes.
const CLAUDE_RUNTIME_COLD = [
  // Unified terminal runtime: only when that terminal runtime is selected.
  'claude/src/agent/runtime/terminal/unified/nativeSession.ts',
] as const;
const DAEMON_COLD = [
  // Deployment Action dependencies: only a service-export binding or a deployment child RPC.
  'src/deployments/createDaemonDeploymentActionDeps.ts',
] as const;

async function readEagerGraph(entryPoints: readonly string[], owners: readonly string[]): Promise<readonly string[]> {
  const { metafile } = await build({
    absWorkingDir: cliRoot, entryPoints: [...entryPoints], outdir: 'unused-cold-owner-graph',
    platform: 'node', format: 'esm', bundle: true, write: false, metafile: true,
    conditions: ['happier-source'], external: ['onnxruntime-node', '*.node'], logLevel: 'silent',
  });
  const inputs = metafile!.inputs;
  const eager = new Set<string>();
  const pending = [...entryPoints];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (eager.has(path)) continue;
    eager.add(path);
    for (const dependency of inputs[path]?.imports ?? []) {
      if (!dependency.external && dependency.kind !== 'dynamic-import') pending.push(dependency.path);
    }
  }
  // The owners stay bundled; only their eager edges are gone.
  for (const owner of owners) {
    expect(Object.keys(inputs).some((path) => path.replaceAll('\\', '/').endsWith(owner)), `${owner} is still bundled`).toBe(true);
  }
  return [...eager].map((path) => path.replaceAll('\\', '/'));
}

describe('owners that the daemon and session host never run at start', () => {
  it('stay out of the session host start graph', async () => {
    const eager = await readEagerGraph(['src/agent/runtime/session/loop/runHostSessionRuntime.ts'], HOST_COLD);
    expect(HOST_COLD.filter((owner) => eager.some((path) => path.endsWith(owner)))).toEqual([]);
  }, 240_000);

  it('stay out of the daemon start graph', async () => {
    const eager = await readEagerGraph(['src/daemon/startDaemon.ts', 'src/api/apiMachine.ts'], DAEMON_COLD);
    expect(DAEMON_COLD.filter((owner) => eager.some((path) => path.endsWith(owner)))).toEqual([]);
  }, 240_000);

  it('stay out of the Claude plugin runtime start graph', async () => {
    const eager = await readEagerGraph(['../../packages/plugins/claude/src/agent/runtime/nativeRuntime.ts'], CLAUDE_RUNTIME_COLD);
    expect(CLAUDE_RUNTIME_COLD.filter((owner) => eager.some((path) => path.endsWith(owner)))).toEqual([]);
  }, 240_000);
});
