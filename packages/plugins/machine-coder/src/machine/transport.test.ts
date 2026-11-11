import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecService, PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCoderTransport } from './transport.js';
import type { CoderResource } from './schemas.js';

const token = 'coder-transport-private-token';
const resource: CoderResource = { workspaceId:'workspace-id',ownerId:'user-a',ownerName:'alice',workspaceName:'workspace',organizationId:'org',templateId:'template',agentName:'main',managedId:'managed' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'coder-process-'));
  cleanup.push(() => rm(directory, {recursive:true,force:true}));
  const fake = join(directory, 'coder.mjs');
  // Coder v2.39.0 cli/ssh.go joins post-selector arguments with spaces, then
  // runs that command with no PTY. This fake is an executable OS boundary.
  await writeFile(fake, `import {spawn} from 'node:child_process';
const args=process.argv.slice(2);const boundary=args.indexOf('--');
if(args[0]!=='ssh'||args[boundary-1]!=='alice/workspace.main'||args.includes('--tty'))process.exit(90);
if(!process.env.CODER_SESSION_TOKEN||!process.env.CODER_URL)process.exit(91);
if(args.slice(boundary+1).join(' ')==="'reflect-private'"){process.stdout.write(process.env.CODER_SESSION_TOKEN);process.exit(0);}
const env={...process.env};delete env.CODER_SESSION_TOKEN;delete env.CODER_URL;
for(const field of (process.env.CODER_SSH_ENV??'').split(',')){const at=field.indexOf('=');if(at>0)env[field.slice(0,at)]=field.slice(at+1);}
const child=spawn('sh',['-c','exec '+args.slice(boundary+1).join(' ')],{env,stdio:'inherit'});
process.on('SIGTERM',()=>{child.kill('SIGTERM');});child.on('exit',(code)=>process.exit(code??255));\n`);
  const requests: PluginExecSpawnRequest[] = [];
  const exec: Pick<ExecService,'run'> = { run: async (request, options) => {
    requests.push(request);
    return new Promise<PluginProcessResult>((resolve,reject)=>{
      const child=spawn(process.execPath,[fake,...(request.args??[])],{env:{...process.env,...request.env},stdio:['pipe','pipe','pipe']});
      const stdout:Buffer[]=[],stderr:Buffer[]=[];let aborted=false;
      child.stdout.on('data',(data:Buffer)=>stdout.push(data));child.stderr.on('data',(data:Buffer)=>stderr.push(data));
      const abort=()=>{aborted=true;child.kill('SIGTERM');};options?.signal?.addEventListener('abort',abort,{once:true});
      child.once('error',reject);child.once('close',(code,signal)=>{options?.signal?.removeEventListener('abort',abort);
        resolve({stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr),stdoutTruncated:false,stderrTruncated:false,
          termination:{observed:signal?{kind:'signal',signal}:{kind:'exit',exitCode:code??255},requestedBy:aborted?{kind:'abort'}:{kind:'none'}}});});
      if(options?.signal?.aborted)abort();
      child.stdin.on('error',()=>{});child.stdin.end(request.stdin);
    });
  }};
  const controller=new AbortController();
  const transport=createCoderTransport({exec,executable:{kind:'managedDependency',id:{pluginId:'happier.machine.coder',localId:'coder-cli'}},
    signal:controller.signal,endpoint:'http://coder.test',token});
  return {transport,requests,directory,controller};
}
describe('Coder native bootstrap at a fake executable process boundary',()=>{
  it('preserves shell argv, binary stdin/stdout, separate stderr and nonzero exit without exposing the control token',async()=>{
    const h=await fixture();const bytes=Buffer.from([0,255,128,13,10,0]);
    const result=await h.transport.exec({resource,argv:['sh','-c','cat; printf "%s" "$1" >&2; exit 37','sh',"spaces ' quote $HOME ; literal"],inputBase64:bytes.toString('base64'),allowWake:false});
    expect(result).toMatchObject({termination:{observed:{kind:'exit',exitCode:37},requestedBy:{kind:'none'}},stdoutTruncated:false,stderrTruncated:false});
    if(!('stdoutBase64' in result))throw new Error('Missing command bytes');
    expect(Buffer.from(result.stdoutBase64,'base64')).toEqual(bytes);
    expect(Buffer.from(result.stderrBase64,'base64').toString()).toBe("spaces ' quote $HOME ; literal");
    expect(h.requests[0]?.args).toContain('--disable-autostart');
    expect(JSON.stringify(h.requests[0]?.args)).not.toContain(token);expect(Buffer.from(h.requests[0]?.stdin??[]).includes(Buffer.from(token))).toBe(false);
  });
  it('writes binary fragments privately with reviewed mode and exact guest path',async()=>{
    const h=await fixture();const guestPath=join(h.directory,"private file 'quoted");const bytes=Buffer.alloc(65_792);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
    expect(await h.transport.putFile({resource,guestPath,bytesBase64:bytes.toString('base64'),mode:0o600})).toEqual({kind:'confirmed'});
    expect(await readFile(guestPath)).toEqual(bytes);
    expect(h.requests.every(request=>!JSON.stringify(request.args).includes(bytes.toString('base64')))).toBe(true);
  });
  it('honors host guestHome/processConfig through the detached startup argv and does not run the foreground alternative',async()=>{
    const h=await fixture();const destination=join(h.directory,'home');
    const result=await h.transport.exec({resource,argv:['sh','-c','exit 99'],processConfig:{environment:{HOME:destination,HAPPIER_HOME_DIR:destination+'/.happier'},
      detachedDaemonStartArgv:['sh','-c','test -n "$HOME" && test "$HAPPIER_HOME_DIR" = "$HOME/.happier"']}});
    expect(result).toEqual({kind:'process-configured'});
    expect(JSON.stringify(h.requests[0]?.args)).not.toContain(destination);
    expect(h.requests[0]?.env?.CODER_SSH_ENV).toContain('HAPPIER_CODER_HOME='+destination);
    expect(JSON.stringify(h.requests[0]?.args)).not.toContain(token);
  });
  it('does not turn canceled finite native IO or canceled process configuration into success',async()=>{
    const h=await fixture();
    const running=h.transport.exec({resource,argv:['sh','-c','exec sleep 30']});
    const timer=setTimeout(()=>h.controller.abort(),100);cleanup.push(async()=>clearTimeout(timer));
    expect(await running).toMatchObject({termination:{requestedBy:{kind:'abort'}}});
    const configured=await fixture();const start=configured.transport.exec({resource,argv:['true'],processConfig:{environment:{HOME:'/tmp',HAPPIER_HOME_DIR:'/tmp/.happier'},detachedDaemonStartArgv:['sh','-c','exec sleep 30']}});
    const timer2=setTimeout(()=>configured.controller.abort(),100);cleanup.push(async()=>clearTimeout(timer2));
    await expect(start).rejects.toMatchObject({code:'native_boot_unconfirmed'});
  });
  it('removes a reflected control-plane token while leaving unrelated byte output unchanged',async()=>{
    const h=await fixture();const result=await h.transport.exec({resource,argv:['reflect-private']});
    if(!('stdoutBase64'in result))throw new Error('Missing bytes');
    expect(Buffer.from(result.stdoutBase64,'base64').toString()).toBe('[redacted]');
  });
});
