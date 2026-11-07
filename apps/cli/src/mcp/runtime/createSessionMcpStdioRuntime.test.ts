import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createStableRunnerPluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { resolveInstalledMachineEffectCli } from '@/machines/adminAccess/machineEffectCli';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createSessionMcpStdioRuntime } from './createSessionMcpStdioRuntime';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';

describe('Session native filesystem pipe', () => {
  it('keeps selected MCP material and the supervised MCP transport on the same launch owner', async () => {
    await withTempDir('happier-session-mcp-launch-', async root => {
      const signal = new AbortController().signal;
      const nativeIdentity = { agentUid: 1001, agentGid: 1001, home: root };
      const runtime = createSessionMcpStdioRuntime({ target: { runtimeHome: root }, nativeIdentity,
        environment: { SELECTED: 'base' }, directory: root, signal });
      const selectedMaterials = [{ relativePath: 'provider.json', contentBase64: 'e30=' }];
      let released = false;
      const unbind = runtime.bindExec(createStableRunnerPluginExecService({ signal, isOccurrenceCurrent: () => true,
        agentCli: { checkReadiness: async () => ({ launchable: [] }) },
        resolveSystemTool: async () => { throw new Error('No system-tool resolution'); },
        authorizeLaunch: async () => { throw new Error('No ordinary Exec launch'); },
        authorizeResolvedAgentNativeLaunch: async (launch, options) => {
          expect(launch).toMatchObject({ command: '/selected/mcp', args: ['selected'], cwd: root, env: {} });
          expect(options?.mcpLaunchMaterial).toEqual({ runtimeHome: root, nativeIdentity,
            environment: { SELECTED: 'override' }, selectedMaterials });
          return { command: process.execPath, args: ['-e', `
            const lines=require('node:readline').createInterface({input:process.stdin});
            lines.on('line',line=>{const request=JSON.parse(line); if(request.id===undefined)return;
              const result=request.method==='initialize'?{
                protocolVersion:request.params.protocolVersion, capabilities:{tools:{}},serverInfo:{name:'selected',version:'1'}
              }:{tools:[{name:'selected_tool',inputSchema:{type:'object'}}]};
              process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
            });
          `], env: {}, cwd: root, release() { released = true; } };
        },
      }));
      const client = new Client({ name: 'session-client', version: '1' });
      try {
        const prepared = await runtime.runtime.prepareTransport({ config: { command: '/selected/mcp', args: ['selected'],
          env: { SELECTED: 'override' } }, selectedMaterials });
        await client.connect(prepared.transport);
        expect(await client.listTools()).toMatchObject({ tools: [{ name: 'selected_tool' }] });
      } finally { await client.close(); unbind(); }
      expect(released).toBe(true);
    });
  });

  it('retains the selected native material and releases the real child only after EOF settlement', async () => {
    await withTempDir('happier-session-filesystem-launch-', async root => {
      const signal = new AbortController().signal;
      const nativeIdentity = { agentUid: 1001, agentGid: 1001, home: root };
      const runtime = createSessionMcpStdioRuntime({ target: { runtimeHome: root }, nativeIdentity,
        environment: { HOME: root, PATH: process.env.PATH ?? '', PRIVATE_ACCOUNT_SECRET: 'must-not-reach-worker' },
        directory: root, signal });
      const configuration = { workingDirectory: root, accessPolicy: { kind: 'restrictedRoots' as const, roots: [root] } };
      let authorizations = 0;
      let releases = 0;
      const eofPath = join(root, 'worker-settled');
      // This callback is the daemon transport boundary. Native authority capture,
      // process supervision, framing and settlement remain real in the receiver.
      const service = createStableRunnerPluginExecService({ signal, isOccurrenceCurrent: () => true,
        agentCli: { checkReadiness: async () => ({ launchable: [] }) },
        resolveSystemTool: async () => { throw new Error('No system-tool resolution'); },
        authorizeLaunch: async () => { throw new Error('No ordinary Exec launch'); },
        authorizeResolvedAgentNativeLaunch: async (launch, options) => {
          authorizations += 1;
          expect(launch.command).toBe(resolveInstalledMachineEffectCli());
          expect(launch.args).toEqual(['filesystem-effect']);
          expect(launch.cwd).toBe(root);
          expect(launch.env).toEqual({});
          expect(options?.mcpLaunchMaterial).toEqual({ runtimeHome: root, nativeIdentity,
            environment: { HOME: root, PATH: process.env.PATH ?? '', TMPDIR: root, TEMP: root, TMP: root }, selectedMaterials: [] });
          return { command: process.execPath, args: ['-e', `
            const {createInterface}=require('node:readline');
            const lines=createInterface({input:process.stdin});
            lines.on('line', line=>{ const request=JSON.parse(line);
              process.stdout.write(JSON.stringify({ok:true,value:request.kind==='initialize'?{ready:true}:{cwd:request.input.path}})+'\\n'); });
            lines.on('close',()=>require('node:fs').writeFileSync(${JSON.stringify(eofPath)},'settled'));
          `], env: {}, cwd: root,
            async release() { expect(await readFile(eofPath, 'utf8')).toBe('settled'); releases += 1; } };
        },
      });
      await expect(runtime.prepareFilesystemEffect(configuration)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
      const unbind = runtime.bindExec(service);
      const channel = await runtime.prepareFilesystemEffect(configuration);
      try {
        unbind();
        await expect(runtime.prepareFilesystemEffect(configuration)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
        await expect(channel.request({ kind: 'filesystem.rpc', method: 'readFile', input: { path: root } }))
          .resolves.toEqual({ cwd: root });
      } finally { await channel.dispose(); }
      await channel.dispose();
      expect(authorizations).toBe(1);
      expect(releases).toBe(1);
    });
  });

  it.skipIf(process.platform !== 'linux')('keeps real cross-UID file ownership and kernel denial through the supervised pipe', async context => {
    try { await execFileWithDeadline('sudo', ['-n', 'true'], {}); }
    catch { context.skip('Passwordless sudo is unavailable for this OS transport fixture'); return; }
    const account = await execFileWithDeadline('id', ['-u', 'nobody'], { encoding: 'utf8' });
    const group = await execFileWithDeadline('id', ['-g', 'nobody'], { encoding: 'utf8' });
    const uid = Number(String(account.stdout).trim());
    const gid = Number(String(group.stdout).trim());
    expect(uid).not.toBe(process.getuid?.());
    await withTempDir('happier-session-cross-uid-', async root => {
      const member = join(root, 'member');
      const neighbor = join(root, 'neighbor');
      await chmod(root, 0o755);
      await mkdir(member, { mode: 0o700 });
      await mkdir(neighbor, { mode: 0o700 });
      const privatePath = join(neighbor, 'private.txt');
      await writeFile(privatePath, 'neighbor-owned');
      await execFileWithDeadline('sudo', ['-n', 'chown', `${uid}:${gid}`, '--', member], {});
      const signal = new AbortController().signal;
      const runtime = createSessionMcpStdioRuntime({ target: { runtimeHome: member },
        nativeIdentity: { agentUid: uid, agentGid: gid, home: member }, environment: { HOME: member }, directory: member, signal });
      // OS transport fixture: the daemon authorizes an existing Unix UID. This
      // proves real kernel isolation, not Happier member-account provenance.
      const unbind = runtime.bindExec(createStableRunnerPluginExecService({ signal, isOccurrenceCurrent: () => true,
        agentCli: { checkReadiness: async () => ({ launchable: [] }) },
        resolveSystemTool: async () => { throw new Error('No tool resolution'); },
        authorizeLaunch: async () => { throw new Error('No ordinary launch'); },
        authorizeResolvedAgentNativeLaunch: async () => ({ command: 'sudo',
          args: ['-n', '-u', `#${uid}`, '--', process.execPath, '-e', `
            const fs=require('node:fs');
            const lines=require('node:readline').createInterface({input:process.stdin});
            lines.on('line',line=>{ const request=JSON.parse(line); let value;
              try { if(request.kind==='initialize') value={ready:true};
                else { if(request.method==='writeFile') fs.writeFileSync(request.input.path,Buffer.from(request.input.content,'base64'));
                  value={uid:process.getuid(),content:fs.readFileSync(request.input.path).toString('base64')}; }
                process.stdout.write(JSON.stringify({ok:true,value})+'\\n');
              } catch(error) {process.stdout.write(JSON.stringify({ok:false,code:error.code})+'\\n');}
            });
          `], env: {}, cwd: root, release() {} }),
      }));
      try {
        const channel = await runtime.prepareFilesystemEffect({ workingDirectory: member, accessPolicy: { kind: 'osUser' } });
        try {
          const path = join(member, 'uploaded.bin');
          const content = Buffer.from([0, 255, 128, 13, 10]).toString('base64');
          await expect(channel.request({ kind: 'filesystem.rpc', method: 'writeFile', input: { path, content } }))
            .resolves.toEqual({ uid, content });
          const owner = await execFileWithDeadline('sudo', ['-n', 'stat', '-c', '%u', '--', path], { encoding: 'utf8' });
          expect(Number(String(owner.stdout).trim())).toBe(uid);
          await expect(channel.request({ kind: 'filesystem.rpc', method: 'readFile', input: { path: privatePath } }))
            .rejects.toMatchObject({ code: 'EACCES' });
          await expect(channel.request({ kind: 'filesystem.rpc', method: 'writeFile', input: { path: privatePath, content } }))
            .rejects.toMatchObject({ code: 'EACCES' });
          expect(await readFile(privatePath, 'utf8')).toBe('neighbor-owned');
        } finally { await channel.dispose(); }
      } finally {
        unbind();
        await execFileWithDeadline('sudo', ['-n', 'chown', '-R', `${process.getuid!()}:${process.getgid!()}`, '--', member], {});
      }
    }, '/tmp');
  });
});
