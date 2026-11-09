import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import { projectAgentPreflightSessionControlsCatalogEntry } from './agentCatalogEntryHooks';

it.each(['controls', 'catalogs'] as const)('shares declared ACP authentication with dynamic %s and preserves an explicit override', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preflight-auth-'));
  const script = join(root, 'native.cjs');
  const capture = join(root, 'authentication.jsonl');
  try {
    // The native process is the boundary. Declaration projection, selection,
    // metadata transport and session inspection remain real.
    await writeFile(script, `
      const fs=require('node:fs');
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line); if(r.id===undefined)return;
        let result={};
        if(r.method==='initialize')result={protocolVersion:1,agentCapabilities:{},authMethods:[{id:'declared-auth'},{id:'explicit-auth'}]};
        if(r.method==='authenticate')fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(r.params)+'\\n');
        if(r.method==='session/new')result={sessionId:'fake-native',models:{currentModelId:'native',availableModels:[{modelId:'native',name:'Native'}]}};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
        if(r.method==='session/new')process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fake-native',update:{sessionUpdate:'available_commands_update',availableCommands:[]}}})+'\\n');
      });
    `);
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const executable = writeExecutableShimSync({ dir: root,
      fileName: process.platform === 'win32' ? 'native.cmd' : 'native',
      contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n` });
    const command = { toolId: 'native-cli', args: [script] };
    for (const explicit of [false, true]) {
      const projected = projectAgentPreflightSessionControlsCatalogEntry({
        agentId: 'fixture.native',
        systemTools: [{ id: 'native-cli', title: 'Native fixture', executableNames: [executable] }],
        retirementSignal: new AbortController().signal, isCurrent: () => true,
        preflightSessionControls: {
          catalogs: { kind: 'acp', command, selectAuthentication: () => ({ methodId: 'declared-auth', metadata: { headless: true } }) },
          ...(kind === 'controls' ? { probeModels: async (context: AgentPreflightSessionControlsProbeContextV1) => {
            if (!context.probeDeclaredAcpSessionControls) throw new Error('Missing ACP controls');
            return await context.probeDeclaredAcpSessionControls({ ...command, ...(explicit ? { authenticationMethodId: 'explicit-auth' } : {}) });
          } } : { probeCatalogs: async (context: AgentPreflightSessionControlsProbeContextV1) => await context.probeDeclaredAcpCatalogs({ ...command,
            ...(explicit ? { authenticationMethodId: 'explicit-auth' } : {}) }) }),
        },
      });
      const adapter = await projected.getPreflightSessionControlsProbeAdapter!();
      const probe = kind === 'controls' ? adapter!.probeModelsRaw : adapter!.probeCatalogsRaw;
      const result = await probe!({ cwd: root, timeoutMs: 10_000 });
      expect(result).toMatchObject(kind === 'controls'
        ? { models: expect.arrayContaining([expect.objectContaining({ id: 'native' })]) } : { commands: [] });
    }
    const authentications = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(authentications).toEqual([{ methodId: 'declared-auth', _meta: { headless: true } }, { methodId: 'explicit-auth' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
