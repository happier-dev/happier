import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { projectAgentPreflightSessionControlsCatalogEntry } from './agentCatalogEntryHooks';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-managed-preflight-'));
  const script = join(root, 'server.cjs');
  await writeFile(script, `const http=require('node:http');const args=process.argv.slice(2);const port=Number(args[args.indexOf('--port')+1]);http.createServer((req,res)=>{if(req.url==='/pending')return;res.setHeader('content-type','application/json');res.end(JSON.stringify({commands:[{name:'project-command'}],skills:[],cwd:process.cwd(),selected:process.env.SELECTED_NATIVE,authenticated:req.headers.authorization==='Basic '+Buffer.from('native:'+process.env.NATIVE_TEST_PASSWORD).toString('base64'),pid:process.pid}));}).listen(port,'127.0.0.1');`);
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
  const projected = projectAgentPreflightSessionControlsCatalogEntry({
    agentId: 'fixture.native', systemTools: [{ id: 'native', title: 'Native', executableNames: [executable] }],
    preflightSessionControls: {
      managedServiceCommands: [{ toolId: 'native', args: ['serve'], environmentKeys: ['SELECTED_NATIVE', 'NATIVE_TEST_PASSWORD'], ci: 'omit' }],
      probeCatalogs: async (context) => await context.withDeclaredManagedService(spec, async (client) => {
        const response = await client.request({ pathAndQuery: '/catalog' });
        const payload = await new Response(response.body).json();
        if (typeof payload !== 'object' || payload === null || !('pid' in payload) || typeof payload.pid !== 'number') {
          throw new Error('Managed preflight fixture returned no process identity');
        }
        pid = payload.pid;
        if (context.accountSettings?.wait === true) await client.request({ pathAndQuery: '/pending' });
        return payload;
      }),
    },
    retirementSignal: new AbortController().signal, isCurrent: () => true,
    bindManagedServices: ({ exec, signal }) => owner.bindScope({ occurrenceId: 'test-occurrence', pluginId: 'fixture.native', contributionQualifiedId: 'fixture.native/agents/native', operationId: 'test-preflight', signal, isOccurrenceCurrent: () => true }, exec),
  });
  const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
  return { root, adapter, pid: () => pid, dispose: async () => { await owner.dispose(); await rm(root, { recursive: true, force: true }); } };
}

function expectChildClosed(pid: number | undefined) {
  expect(pid).toBeTypeOf('number');
  expect(() => process.kill(pid!, 0)).toThrow();
}

describe('scoped managed preflight service', () => {
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
