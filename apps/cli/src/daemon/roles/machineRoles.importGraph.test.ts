import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { projectPath } from '@/projectPath';

const cliRoot = projectPath();
const { build } = createRequire(join(cliRoot, 'package.json'))('esbuild') as typeof import('esbuild');

// Machine core = what every daemon evaluates at start: the daemon entry and the Machine client it
// loads at registration. A split role's modules load only through that role's entry, by import()
// on activation, so an inactive role costs no code. Extend ROLE_OWNED as more roles split out
// (P03-HANDLER-SPLIT; OWNER-RULINGS 2026-11-12 "Machine roles APPROVED").
const CORE_ROOTS = ['src/daemon/startDaemon.ts', 'src/api/apiMachine.ts'];
const ROLE_ENTRIES = {
  memory: 'src/daemon/roles/memory/entry.ts',
  voice: 'src/daemon/roles/voice/entry.ts',
  devices: 'src/daemon/roles/devices/entry.ts',
  broker: 'src/daemon/roles/broker/entry.ts',
  sessions: 'src/daemon/roles/sessions/entry.ts',
} as const;
const ROLE_OWNED: Readonly<Record<keyof typeof ROLE_ENTRIES, RegExp>> = {
  memory: /^src\/(daemon\/roles\/memory\/|api\/machine\/rpcHandlers\.memory\.ts$|daemon\/memory\/(memoryWorker|subscribeMemorySessionRemoval|searchMemory|getMemoryWindow)\.ts$)/,
  voice: /^src\/(daemon\/roles\/voice\/|api\/machine\/rpcHandlers\.(voiceInference|voiceDiagnostics)[A-Za-z]*\.ts$|daemon\/voiceInference\/(voiceInferenceWorker|voiceInferencePaths|publicModelPacks\/runtime)\.ts$)/,
  // Simulator preview, computer use and the browser runtime (route publication owns sidecar,
  // automation, recording and profile storage). The RPC handler shells stay in machine core and
  // register only what the active role publishes; the live-stream capture registry is core.
  devices: /^src\/(daemon\/roles\/devices\/|daemon\/devices\/simulator\/(runtime|adapter|captureAdapters|captureRegistration|streamControlBridge)\.ts$|daemon\/devices\/simulator\/(android|ios|platform)\/|daemon\/computer\/routes\.ts$|daemon\/browser\/control\/routePublication\.ts$)/,
  // The broker application's lifetime and ingress advertisement. Its application code is built by
  // the daemon's provider-broker owner (measured ≤0.19 MiB exclusive; not worth a second seam).
  broker: /^src\/daemon\/roles\/broker\//,
  // The new-Session Machine RPC family (P03-SESSIONS-SPLIT). The session control runtime itself is
  // still composed by machine core: it also builds core, broker, devices and relay owners.
  sessions: /^src\/(daemon\/roles\/sessions\/|api\/machine\/rpcHandlers\.sessions\.ts$)/,
};

const ROLE_RPC_FAMILY: Readonly<Record<keyof typeof ROLE_ENTRIES, RegExp>> = {
  memory: /^src\/api\/machine\/rpcHandlers\.memory\.ts$/,
  voice: /^src\/api\/machine\/rpcHandlers\.voiceInference\.ts$/,
  devices: /^src\/daemon\/computer\/routes\.ts$/,
  broker: /^src\/daemon\/roles\/broker\/entry\.ts$/,
  sessions: /^src\/api\/machine\/rpcHandlers\.sessions\.ts$/,
};

it('keeps split Machine roles out of machine core and out of each other', async () => {
  const { metafile } = await build({
    absWorkingDir: cliRoot, entryPoints: [...CORE_ROOTS, ...Object.values(ROLE_ENTRIES)], outdir: 'unused-machine-role-graph',
    platform: 'node', format: 'esm', bundle: true, splitting: true, write: false, metafile: true,
    conditions: ['happier-source'], external: ['onnxruntime-node', '*.node'], logLevel: 'silent',
  });
  const inputs = metafile!.inputs;
  const eager = (roots: readonly string[]) => {
    const seen = new Set<string>();
    const pending = [...roots];
    while (pending.length > 0) {
      const path = pending.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      for (const dependency of inputs[path]?.imports ?? []) {
        if (!dependency.external && dependency.kind !== 'dynamic-import') pending.push(dependency.path);
      }
    }
    return seen;
  };
  const core = eager(CORE_ROOTS);
  for (const [roleId, owned] of Object.entries(ROLE_OWNED)) {
    // The role's own modules are still bundled, behind the role entry.
    expect(Object.keys(inputs).some(path => owned.test(path)), `${roleId} modules are bundled`).toBe(true);
    expect([...core].filter(path => owned.test(path)), `${roleId} modules in machine core`).toEqual([]);
  }
  for (const [roleId, entry] of Object.entries(ROLE_ENTRIES)) {
    const closure = eager([entry]);
    // Eager inside the role: its RPC family is in the entry's static graph, so serving a call
    // never waits on a lazy load once the role is active.
    expect([...closure].some(path => ROLE_RPC_FAMILY[roleId as keyof typeof ROLE_ENTRIES].test(path)), `${roleId} RPC family eager in its entry`).toBe(true);
    for (const [otherId, owned] of Object.entries(ROLE_OWNED)) {
      if (otherId === roleId) continue;
      expect([...closure].filter(path => owned.test(path)), `${otherId} modules in the ${roleId} entry`).toEqual([]);
    }
  }
}, 240_000);
