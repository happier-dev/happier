import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecService, PluginExecSpawnRequest, PluginProcessHandle, PluginProcessOutput, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
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
  // runs that command with no PTY under `coder agent --no-reap`: killing the
  // local `coder ssh` client closes remote stdin without sending SIGTERM to the
  // remote process. This fake models that OS boundary faithfully.
  await writeFile(fake, `import {spawn} from 'node:child_process';
const args=process.argv.slice(2);const boundary=args.indexOf('--');
if(args[0]!=='ssh'||args[boundary-1]!=='alice/workspace.main'||args.includes('--tty'))process.exit(90);
if(!process.env.CODER_SESSION_TOKEN||!process.env.CODER_URL)process.exit(91);
if(args.slice(boundary+1).includes("'reflect-private'")){process.stdout.write(process.env.CODER_SESSION_TOKEN);process.exit(0);}
const env={...process.env};delete env.CODER_SESSION_TOKEN;delete env.CODER_URL;
for(const field of (process.env.CODER_SSH_ENV??'').split(',')){const at=field.indexOf('=');if(at>0)env[field.slice(0,at)]=field.slice(at+1);}
const detached=args.includes('--disable-autostart')&&!process.env.CODER_SSH_ENV;
const child=spawn('sh',['-c','exec '+args.slice(boundary+1).join(' ')],{env,stdio:['pipe','inherit','inherit'],detached});
process.stdin.on('error',()=>{});child.stdin.on('error',()=>{});
process.stdin.pipe(child.stdin);
process.on('SIGTERM',()=>{if(detached){child.stdin.end();process.exit(143);}else{child.kill('SIGTERM');}});
child.on('exit',(code)=>process.exit(code??255));\n`);
  const requests: PluginExecSpawnRequest[] = [];
  const spawned: Array<{ request: PluginExecSpawnRequest; outputDelivery?: string; stdinChunks: Buffer[] }> = [];
  const exec: Pick<ExecService,'run'|'spawn'> = { spawn: async (request, options) => {
    const stdinChunks: Buffer[] = [];
    spawned.push({ request, outputDelivery: options?.outputDelivery, stdinChunks });
    const child=spawn(process.execPath,[fake,...(request.args??[])],{env:{...process.env,...request.env},stdio:['pipe','pipe','pipe']});
    const listeners=new Set<(chunk: PluginProcessOutput)=>void>();let sequence=0;
    const stdout:Buffer[]=[],stderr:Buffer[]=[];let aborted=false;
    child.stdout.on('data',(data:Buffer)=>{stdout.push(data);for(const listener of listeners)listener({sequence:++sequence,stream:'stdout',data});});
    child.stderr.on('data',(data:Buffer)=>{stderr.push(data);for(const listener of listeners)listener({sequence:++sequence,stream:'stderr',data});});
    const abort=()=>{aborted=true;child.kill('SIGTERM');};options?.signal?.addEventListener('abort',abort,{once:true});
    const exited=new Promise<PluginProcessResult['termination']>(resolve=>child.once('exit',(code,signal)=>resolve({
      observed:signal?{kind:'signal',signal}:{kind:'exit',exitCode:code??255},requestedBy:aborted?{kind:'abort'}:{kind:'none'}})));
    const completed=new Promise<PluginProcessResult>((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>{
        options?.signal?.removeEventListener('abort',abort);
        resolve({stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr),stdoutTruncated:false,stderrTruncated:false,
          termination:{observed:signal?{kind:'signal',signal}:{kind:'exit',exitCode:code??255},requestedBy:aborted?{kind:'abort'}:{kind:'none'}}});
      });
    });
    if(options?.signal?.aborted)abort();
    child.stdin.on('error',()=>{});
    const handle = { write: async (data: Uint8Array) => { stdinChunks.push(Buffer.from(data)); child.stdin.write(data); }, closeStdin: async () => { child.stdin.end(); },
      waitForExit: () => exited, wait: () => completed, onOutput: (listener: (chunk: PluginProcessOutput)=>void) => { listeners.add(listener); return { [Symbol.dispose]() { listeners.delete(listener); } }; },
      dispose: async () => { child.kill('SIGTERM'); } };
    return handle as unknown as PluginProcessHandle;
  }, run: async (request, options) => {
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
  return {transport,requests,spawned,directory,controller};
}
describe('Coder native bootstrap at a fake executable process boundary',()=>{
  it('preserves shell argv, binary stdin/stdout, separate stderr and nonzero exit without exposing the control token',async()=>{
    const h=await fixture();const bytes=Buffer.from([0,255,128,13,10,0]);
    const result=await h.transport.exec({resource,argv:['sh','-c','cat; printf "%s" "$1" >&2; exit 37','sh',"spaces ' quote $HOME ; literal"],inputBase64:bytes.toString('base64'),allowWake:false});
    expect(result).toMatchObject({termination:{observed:{kind:'exit',exitCode:37},requestedBy:{kind:'none'}},stdoutTruncated:false,stderrTruncated:false});
    if(!('stdoutBase64' in result))throw new Error('Missing command bytes');
    expect(Buffer.from(result.stdoutBase64,'base64')).toEqual(bytes);
    expect(Buffer.from(result.stderrBase64,'base64').toString()).toBe("spaces ' quote $HOME ; literal");
    expect(h.spawned[0]?.request.args).toContain('--disable-autostart');
    expect(JSON.stringify(h.spawned[0]?.request.args)).not.toContain(token);expect(Buffer.concat(h.spawned[0]?.stdinChunks??[]).includes(Buffer.from(token))).toBe(false);
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
  it('terminates the remote process group on abort with zero orphans and throws typed cancelled',async()=>{
    const h=await fixture();
    const pidFile=join(h.directory,'guest-sleep.pid');
    const running=h.transport.exec({resource,argv:['sh','-s'],allowWake:false,inputBase64:Buffer.from(`echo $$ > '${pidFile}'; exec sleep 30\n`).toString('base64')});
    let guestPid=0;
    await expect.poll(async()=>{
      const raw=await readFile(pidFile,'utf8').catch(()=>'');
      guestPid=Number.parseInt(raw.trim(),10);
      return Number.isInteger(guestPid)&&guestPid>0;
    },{timeout:5_000}).toBe(true);
    cleanup.push(async()=>{try{process.kill(guestPid,'SIGKILL');}catch{}});
    h.controller.abort();
    await expect(running).rejects.toMatchObject({code:'cancelled'});
    await expect.poll(()=>{
      try{process.kill(guestPid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
    },{timeout:5_000}).toBe(false);
    const configured=await fixture();const start=configured.transport.exec({resource,argv:['true'],processConfig:{environment:{HOME:'/tmp',HAPPIER_HOME_DIR:'/tmp/.happier'},detachedDaemonStartArgv:['sh','-c','exec sleep 30']}});
    const timer2=setTimeout(()=>configured.controller.abort(),100);cleanup.push(async()=>clearTimeout(timer2));
    await expect(start).rejects.toMatchObject({code:'native_boot_unconfirmed'});
  });
  it('opens the stream role as one non-PTY coder ssh process: binary stdin in, stdout out, no token in argv',async()=>{
    const h=await fixture();
    const channel=await h.transport.stream({resource,argv:['sh','-c','cat']});
    const received:Buffer[]=[];channel.onOutput(chunk=>{if(chunk.stream==='stdout')received.push(Buffer.from(chunk.data));});
    const bytes=Buffer.from([0,255,128,13,10,0]);
    await channel.write(bytes);
    await expect.poll(()=>Buffer.concat(received)).toEqual(bytes);
    await channel.closeStdin();
    expect(await channel.waitForExit()).toEqual({observed:{kind:'exit',exitCode:0},requestedBy:{kind:'none'}});
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.outputDelivery).toBe('invocation');
    // A channel never autostarts a stopped workspace: power stays with the reconciler.
    expect(h.spawned[0]?.request.args?.slice(0,4)).toEqual(['ssh','--disable-autostart','alice/workspace.main','--']);
    expect(JSON.stringify(h.spawned[0]?.request.args)).not.toContain(token);
    expect(h.spawned[0]?.request.env?.CODER_SESSION_TOKEN).toBe(token);
  });
  it('removes a reflected control-plane token while leaving unrelated byte output unchanged',async()=>{
    const h=await fixture();const result=await h.transport.exec({resource,argv:['reflect-private']});
    if(!('stdoutBase64'in result))throw new Error('Missing bytes');
    expect(Buffer.from(result.stdoutBase64,'base64').toString()).toBe('[redacted]');
  });
  it('hardens guestCommandLifetime for non-sudo kill-first, POSIX sh without bash, BusyBox sleep fallback, and reap-safe watcher',async()=>{
    const h=await fixture();
    const result=await h.transport.exec({resource,argv:['sh','-c','echo ok'],allowWake:false});
    expect(result).toMatchObject({termination:{observed:{kind:'exit',exitCode:0},requestedBy:{kind:'none'}}});
    const script=h.spawned[0]?.request.args?.find(arg=>arg.includes('stop_group'))??'';
    expect(script).toContain('sleep 0.2 2>/dev/null || sleep 1');
    // Plain kill must be attempted before sudo fallback so normal non-sudo Coder sessions avoid sudo noise.
    const plainKillIndex=script.indexOf('kill -TERM');
    const sudoKillIndex=script.indexOf('sudo -n -- /bin/kill -TERM');
    expect(plainKillIndex).toBeGreaterThan(-1);
    expect(sudoKillIndex).toBeGreaterThan(plainKillIndex);
    // Guarded POSIX sh execution without bash: works cleanly for normal exit AND abort without invoking sudo.
    const binDir=join(h.directory,'posix-bin');
    const sudoLog=join(h.directory,'sudo.log');
    const {mkdir,chmod}=await import('node:fs/promises');
    await mkdir(binDir,{recursive:true});
    // Provide a fake `sudo` that logs any invocation and hides `bash` by omitting it from a minimal PATH.
    const sudoShim=join(binDir,'sudo');
    await writeFile(sudoShim,`#!/bin/sh\necho "$@" >> '${sudoLog}'\nexit 1\n`);
    await chmod(sudoShim,0o755);
    const {execFileSync}=await import('node:child_process');
    for(const tool of ['sh','base64','setsid','sleep','cat','kill','echo']){
      try{
        const resolved=execFileSync('which',[tool],{encoding:'utf8'}).trim();
        if(resolved){
          const {symlink}=await import('node:fs/promises');
          await symlink(resolved,join(binDir,tool));
        }
      }catch{}
    }
    const prevPath=process.env.PATH;
    process.env.PATH=binDir;
    try{
      const posixNormal=await h.transport.exec({resource,argv:['sh','-c','cat; exit 7'],allowWake:false,inputBase64:Buffer.from('hello').toString('base64')});
      expect(posixNormal).toMatchObject({termination:{observed:{kind:'exit',exitCode:7},requestedBy:{kind:'none'}}});
      if(!('stdoutBase64'in posixNormal))throw new Error('Missing stdout');
      expect(Buffer.from(posixNormal.stdoutBase64,'base64').toString()).toBe('hello');
      const posixPidFile=join(h.directory,'posix-sleep.pid');
      const posixCancel=h.transport.exec({resource,argv:['sh','-s'],allowWake:false,inputBase64:Buffer.from(`sleep 30 & echo $! > '${posixPidFile}'; wait\n`).toString('base64')});
      let posixPid=0;
      await expect.poll(async()=>{
        const raw=await readFile(posixPidFile,'utf8').catch(()=>'');
        posixPid=Number.parseInt(raw.trim(),10);
        return Number.isInteger(posixPid)&&posixPid>0;
      },{timeout:5_000}).toBe(true);
      cleanup.push(async()=>{try{process.kill(posixPid,'SIGKILL');}catch{}});
      h.controller.abort();
      await expect(posixCancel).rejects.toMatchObject({code:'cancelled'});
      await expect.poll(()=>{
        try{process.kill(posixPid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
      },{timeout:5_000}).toBe(false);
      // Normal non-sudo cancel must never invoke sudo.
      await expect(readFile(sudoLog,'utf8')).rejects.toThrow();
    }finally{
      process.env.PATH=prevPath;
    }
  });
});
