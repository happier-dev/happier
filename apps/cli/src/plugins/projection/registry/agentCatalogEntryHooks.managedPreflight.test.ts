import { readManagedServiceResponseJson } from '@/plugins/testkit/managedServiceResponse';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import type { AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { projectAgentPreflightSessionControlsCatalogEntry } from './agentCatalogEntryHooks';
import { OPENCODE_PREFLIGHT_SESSION_CONTROLS } from '../../../../../../packages/plugins/opencode/src/agent/preflight/models';
import { probeAgentModesBestEffort } from '@/capabilities/probes/agentModesProbe';
import { preflightCatalogEntryFixture } from '@/capabilities/probes/preflightSessionControlsProbeAdapter.testkit';

async function fixture(openCodeModes?: Readonly<{ bindProbe: boolean }>, callbackMethod: 'probeCatalogs' | 'probeModes' = 'probeCatalogs') {
  const root = await mkdtemp(join(tmpdir(), 'happier-managed-preflight-'));
  const script = join(root, 'server.cjs');
  const pendingMarker = join(root, 'inventory-pending');
  await writeFile(script, `const http=require('node:http');const args=process.argv.slice(2);if(args.includes('--version')){process.stdout.write('1.18.33');process.exit(0);}const port=Number(args[args.indexOf('--port')+1]);http.createServer((req,res)=>{if(req.url==='/pending'||req.url==='/agent?pending'){require('node:fs').writeFileSync(${JSON.stringify(pendingMarker)},'pending');return;}res.setHeader('content-type','application/json');const reply=()=>res.end(JSON.stringify(req.url.startsWith('/agent')?[{name:'build',description:'Native build mode'},{name:'custom-review',description:'Project mode'}]:{commands:[{name:'project-command'}],skills:[],cwd:process.cwd(),selected:process.env.SELECTED_NATIVE,authenticated:req.headers.authorization==='Basic '+Buffer.from('native:'+process.env.NATIVE_TEST_PASSWORD).toString('base64'),pid:process.pid}));if(req.url==='/agent?delayed')setTimeout(reply,300);else reply();}).listen(port,'127.0.0.1');`);
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const executable = writeExecutableShimSync({ dir: root, fileName: process.platform === 'win32' ? 'native.cmd' : 'native', contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n` });
  const owner = createManagedServicesOwner({
    processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
    dependencies: { status: async () => { throw new Error('not used'); }, ensure: async () => { throw new Error('not used'); }, update: async () => { throw new Error('not used'); }, remove: async () => { throw new Error('not used'); } },
    resolveScope: (scope) => scope,
    registerRawForRedaction: () => {},
  });
  const spec: ManagedServiceSpec = { id: 'catalog-probe', mode: { kind: 'spawn', launch: { executable: { kind: 'systemTool', id: 'native' }, args: ['serve'], cwd: { root: 'workspace', relativePath: '' } }, endpoint: { kind: 'assignAndInject', host: '127.0.0.1', port: { kind: 'allocated' }, inject: { argument: '--port' } } }, healthCheck: { kind: 'http', target: { kind: 'servicePath', path: '/health' } }, clientAccess: { kind: 'hostBasic', username: 'native', injectPasswordEnvironmentKey: 'NATIVE_TEST_PASSWORD' } };
  let pid: number | undefined;
  let inventoryStarted!: () => void;
  const inventory = new Promise<void>((resolve) => { inventoryStarted = resolve; });
  const inspect = async (context: AgentPreflightSessionControlsProbeContextV1) => await context.withDeclaredManagedService(spec, async (client) => {
    const response = await client.request({ pathAndQuery: '/catalog' });
    const payload = await readManagedServiceResponseJson(response);
    if (typeof payload !== 'object' || payload === null || !('pid' in payload) || typeof payload.pid !== 'number') {
      throw new Error('Managed preflight fixture returned no process identity');
    }
    pid = payload.pid;
    if (callbackMethod === 'probeModes') {
      inventoryStarted();
      const modes = await client.request({ pathAndQuery: context.accountSettings?.wait === true ? '/agent?pending' : '/agent?delayed' });
      return await readManagedServiceResponseJson(modes);
    }
    if (context.accountSettings?.wait === true) await client.request({ pathAndQuery: '/pending' });
    return payload;
  });
  const projected = projectAgentPreflightSessionControlsCatalogEntry({
    agentId: openCodeModes ? 'opencode' : 'fixture.native', systemTools: (openCodeModes
      ? ['opencode-cli', 'opencode-cli-stable', 'opencode-cli-v2'] : ['native'])
      .map(id => ({ id, title: 'Native', executableNames: [executable] })),
    preflightSessionControls: openCodeModes ? { ...OPENCODE_PREFLIGHT_SESSION_CONTROLS,
      ...(openCodeModes.bindProbe ? {} : { probeModes: undefined }) } : {
      managedServiceCommands: [{ toolId: 'native', args: ['serve'], environmentKeys: ['SELECTED_NATIVE', 'NATIVE_TEST_PASSWORD'], ci: 'omit' }],
      [callbackMethod]: inspect,
    },
    retirementSignal: new AbortController().signal, isCurrent: () => true,
    bindManagedServices: ({ exec, signal }) => owner.bindScope({ occurrenceId: 'test-occurrence', pluginId: 'fixture.native', contributionQualifiedId: 'fixture.native/agents/native', operationId: 'test-preflight', signal, isOccurrenceCurrent: () => true }, exec),
  });
  const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
  return { root, adapter, inventory, pendingMarker, pid: () => pid, dispose: async () => { await owner.dispose(); await rm(root, { recursive: true, force: true }); } };
}

function expectChildClosed(pid: number | undefined) {
  expect(pid).toBeTypeOf('number');
  expect(() => process.kill(pid!, 0)).toThrow();
}

describe('scoped managed preflight service', () => {
  it('ends an external mode callback whose healthy native service never answers inventory, then closes its process', async () => {
    const f = await fixture(undefined, 'probeModes');
    try {
      if (!f.adapter?.probeModesRaw) throw new Error('Missing real projected mode adapter');
      let outcome: unknown = 'pending';
      const discovery = f.adapter.probeModesRaw({ cwd: f.root, timeoutMs: 2_000, accountSettings: { wait: true } });
      void discovery.then(value => { outcome = value; }, error => { outcome = error; });
      await f.inventory;
      await expect.poll(() => readFile(f.pendingMarker, 'utf8')).toBe('pending');
      // The native budget initiates cancellation; the existing process owner
      // still completes its normal child-disposal lifetime before settlement.
      await expect.poll(() => outcome, { timeout: 10_000 }).toBeNull();
      expectChildClosed(f.pid());
    } finally { await f.dispose(); }
  }, 60_000);

  it('keeps a delayed native inventory success inside the authored mode budget and disposes its child', async () => {
    const f = await fixture(undefined, 'probeModes');
    try {
      await expect(f.adapter?.probeModesRaw?.({ cwd: f.root, timeoutMs: 30_000 })).resolves.toEqual([
        { name: 'build', description: 'Native build mode' },
        { name: 'custom-review', description: 'Project mode' },
      ]);
      expectChildClosed(f.pid());
    } finally { await f.dispose(); }
  }, 60_000);

  it.each([true, false])('probes the native OpenCode mode inventory through the normal host owner (hook bound: %s)', async (bindProbe) => {
    const f = await fixture({ bindProbe });
    try {
      if (!f.adapter) throw new Error('Missing real projected preflight adapter');
      const observation = await probeAgentModesBestEffort({ agentId: 'opencode', cwd: f.root,
        accountSettings: { opencodeCliGeneration: 'stable' },
        catalogEntry: preflightCatalogEntryFixture('opencode', f.adapter) });
      expect(observation.availableModes).toEqual(bindProbe ? [
        { id: 'build', name: 'build', description: 'Native build mode' },
        { id: 'custom-review', name: 'custom-review', description: 'Project mode' },
      ] : []);
      expect(observation.source === 'dynamic').toBe(bindProbe);
    } finally { await f.dispose(); }
  }, 60_000);

  it('uses the real managed service owner with the selected environment and cwd, then closes its process', async () => {
    const f = await fixture();
    try {
      await expect(f.adapter?.probeCatalogsRaw?.({ cwd: f.root, timeoutMs: 30_000, env: { SELECTED_NATIVE: 'project-selection' } })).resolves.toMatchObject({ commands: [{ name: 'project-command' }], skills: [], cwd: f.root, selected: 'project-selection', authenticated: true });
      expectChildClosed(f.pid());
    } finally { await f.dispose(); }
  }, 60_000);

  it('cancels a pending native read and closes the managed process on the containing probe deadline', async () => {
    const f = await fixture();
    try {
      await expect(f.adapter?.probeCatalogsRaw?.({ cwd: f.root, timeoutMs: 2_000, accountSettings: { wait: true } })).rejects.toThrow();
      expectChildClosed(f.pid());
    } finally { await f.dispose(); }
  }, 60_000);
});
