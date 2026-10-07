import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesDescribeResponse, CapabilitiesInvokeRequest, CapabilitiesInvokeResponse } from '@/capabilities/types';
import { probeAgentCatalogs } from '@/capabilities/probes/agentCatalogsProbe';
import { reloadConfiguration } from '@/configuration';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { bindPluginRuntimeSourceAuthority } from '@/plugins/runtime/sourceAuthority';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { registerCapabilitiesHandlers } from './capabilities';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';

// Only Pi's executable/extension API is simulated. Encrypted RPC, the contribution
// registry, profile admission, scoped launch, cleanup and normalization remain real.
describe('capabilities.invoke native preflight catalogs', () => {
  const originalEnv = { ...process.env };
  let home: string;
  let runtimeLease: PluginRuntimeRegistryLease | undefined;
  let directory: string;
  let capture: string;
  let fixture: string;
  let holdSettingsRead = false;
  let settingsReadEntered = false;
  let releaseSettingsRead: (() => void) | undefined;
  let observedSettingsSignal: AbortSignal | undefined;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'happier-catalog-runtime-'));
    process.env = {...originalEnv,HAPPIER_HOME_DIR:home};
    reloadConfiguration();
    runtimeLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({happyHomeDir:home,pluginIds:['happier.agent.pi'],
        accountSettingsRecordAdapter: {
          async bindOperation() {
            return {
              async readRecord(_model, options) {
                if (holdSettingsRead) {
                  settingsReadEntered = true;
                  observedSettingsSignal = options?.signal;
                  // Persistent-account storage is the external boundary. Model a read
                  // that completes late despite cancellation, without mocking settings.
                  await new Promise<void>((resolve) => { releaseSettingsRead = resolve; });
                }
                return { status: 'absent' };
              },
              async writeRecord() { return { status: 'unavailable' }; },
            };
          },
        },
        resolveDevelopmentSourceAuthority: ({rootPath}) => {
          const authority = bindPluginRuntimeSourceAuthority({custody:{kind:'development',registeredRootId:rootPath},resolvedRoot:rootPath,observedRevision:0});
          if(authority.kind !== 'development') throw new Error('Expected current source development authority');
          return authority;
        },
      }),
    });
  }, 90_000);
  afterAll(async () => {
    await runtimeLease?.release();
    await pluginReloadController.shutdown();
    process.env = originalEnv;
    reloadConfiguration();
    if(home) rmSync(home,{recursive:true,force:true});
  });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'happier-host-native-catalogs-'));
    capture = join(directory, 'capture.json');
    fixture = join(directory, 'pi.mjs');
    writeFileSync(fixture, `#!${process.execPath}\n
      import {appendFileSync,writeFileSync} from 'node:fs';
      import {pathToFileURL} from 'node:url';
      const args=process.argv.slice(2), handlers=new Map();
      const extensions=[];
      for(let index=0;index<args.length;index++) if(args[index]==='--extension') {
        const path=args[++index]; extensions.push(path);
        (await import(pathToFileURL(path))).default({on:(event,handler)=>handlers.set(event,handler),
          getCommands:()=>process.env.PI_OFFLINE==='empty'?[]:[{name:' /Mixed-Case ',description:' Native command '},{name:'skill:design'}]});
      }
      writeFileSync(${JSON.stringify(capture)},JSON.stringify({cwd:process.cwd(),args,extensions,pid:process.pid,
        selected:process.env.OPENAI_API_KEY,ambient:process.env.ANTHROPIC_API_KEY,
        control:process.env.HAPPIER_SESSION_STARTUP_SPAWN_NONCE}));
      appendFileSync(${JSON.stringify(join(directory,'launches.jsonl'))},JSON.stringify({pid:process.pid})+'\\n');
      if(process.env.DEBUG) await new Promise(resolve=>setTimeout(resolve,Number(process.env.DEBUG)));
      if(process.env.PI_OFFLINE==='hang') await new Promise(()=>{setInterval(()=>{},1000)});
      if(process.env.PI_OFFLINE!=='missing') await handlers.get('session_start')({},{});
    `);
    chmodSync(fixture, 0o755);
    process.env = { ...originalEnv, HAPPIER_HOME_DIR: home, HAPPIER_PI_PATH: fixture,
      HAPPIER_JS_RUNTIME_PATH: process.execPath, ANTHROPIC_API_KEY: 'ambient-must-not-cross' };
    reloadConfiguration();
  });
  afterEach(() => {
    process.env = originalEnv;
    reloadConfiguration();
    rmSync(directory, { recursive: true, force: true });
  });
  function client() {
    return createEncryptedRpcTestClient({scopePrefix:'catalog-test',registerHandlers:registerCapabilitiesHandlers});
  }
  async function invoke(params: Record<string, unknown> = {}) {
    return client().call<CapabilitiesInvokeResponse, CapabilitiesInvokeRequest>(RPC_METHODS.CAPABILITIES_INVOKE,
      {id:'cli.pi',method:'probeCatalogs',params:{cwd:directory,timeoutMs:10_000,...params}});
  }
  it('advertises discovery and observes normalized native commands with scoped environment and cleanup', async () => {
    const rpc = client();
    const description = await rpc.call<CapabilitiesDescribeResponse, {}>(RPC_METHODS.CAPABILITIES_DESCRIBE, {});
    expect(description.capabilities.find((entry)=>entry.id==='cli.pi')?.methods).toHaveProperty('probeCatalogs');
    const response = await invoke({environmentVariables:{OPENAI_API_KEY:'selected', HAPPIER_SESSION_STARTUP_SPAWN_NONCE:'injected-control'}});
    expect(response).toEqual({ok:true,result:{commands:{supported:true,items:[
      {command:'mixed-case',description:'Native command'},{command:'skill:design'}]},skills:{supported:false,items:[]}}});
    const observation: {cwd:string;args:string[];extensions:string[];pid:number;selected?:string;ambient?:string;control?:string} = JSON.parse(readFileSync(capture,'utf8'));
    expect(observation).toMatchObject({cwd:directory,selected:'selected'});
    expect(observation.ambient).toBeUndefined();
    expect(observation.control).toBeUndefined();
    expect(observation.args).toContain('--no-session');
    for(const path of observation.extensions) expect(existsSync(path)).toBe(false);
    expect(()=>process.kill(observation.pid,0)).toThrow();
  });
  it('keeps observed empty commands distinct from unsupported skills and fails missing native observations', async () => {
    expect(await invoke({environmentVariables:{PI_OFFLINE:'empty'}})).toEqual({ok:true,result:{
      commands:{supported:true,items:[]},skills:{supported:false,items:[]}}});
    expect(await invoke({environmentVariables:{PI_OFFLINE:'missing'}})).toMatchObject({ok:false,error:{code:'preflight-catalog-unavailable'}});
  });
  it('bounds a hung native process by the caller timeout and disposes its process and extension', async () => {
    expect(await invoke({timeoutMs:1000,environmentVariables:{PI_OFFLINE:'hang'}}))
      .toMatchObject({ok:false,error:{code:'preflight-catalog-unavailable'}});
    const observation: {extensions:string[];pid:number} = JSON.parse(readFileSync(capture,'utf8'));
    for(const path of observation.extensions) expect(existsSync(path)).toBe(false);
    expect(()=>process.kill(observation.pid,0)).toThrow();
  });
  it('bounds account settings preparation, prevents a late native launch, and recovers on the next request', async () => {
    holdSettingsRead = true;
    settingsReadEntered = false;
    observedSettingsSignal = undefined;
    let settled: CapabilitiesInvokeResponse | undefined;
    vi.useFakeTimers();
    const pending = invoke({timeoutMs:1000}).then((response) => { settled = response; return response; });
    try {
      await vi.waitFor(() => expect(settingsReadEntered).toBe(true));
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toMatchObject({ok:false,error:{code:'preflight-catalog-unavailable'}});
      expect(observedSettingsSignal).toMatchObject({ aborted: true });
      expect(existsSync(capture)).toBe(false);
    } finally {
      holdSettingsRead = false;
      releaseSettingsRead?.();
      releaseSettingsRead = undefined;
      vi.useRealTimers();
      await pending;
    }
    // Give the delayed settings continuation a real event-loop turn before
    // testing absence of a native side effect from the cancelled request.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(existsSync(capture)).toBe(false);
    expect(await invoke()).toMatchObject({ok:true,result:{commands:{supported:true}}});
  });
  it('settles unsupported channels for a declaration-only catalog without launching a native process', async () => {
    const entry = getResolvedContributionRegistry().catalogEntriesById.pi;
    expect(entry).toBeDefined();
    expect(await probeAgentCatalogs({agentId:'pi',catalogEntry:entry ?? null,cwd:directory,timeoutMs:10_000}))
      .toEqual({commands:{supported:false,items:[]},skills:{supported:false,items:[]}});
    expect(existsSync(capture)).toBe(false);
  });
  it('keeps a cancelled caller independent from a healthy caller with the same launch scope', async () => {
    const controller = new AbortController();
    const rpc = client();
    const request = {id:'cli.pi',method:'probeCatalogs',params:{cwd:directory,timeoutMs:10_000,
      environmentVariables:{DEBUG:'1000'}}} satisfies CapabilitiesInvokeRequest;
    const cancelled = rpc.manager.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, request, {signal:controller.signal});
    const healthy = rpc.call<CapabilitiesInvokeResponse, CapabilitiesInvokeRequest>(RPC_METHODS.CAPABILITIES_INVOKE, request);
    await vi.waitFor(()=> expect(readFileSync(join(directory,'launches.jsonl'),'utf8').trim().split('\n')).toHaveLength(2));
    controller.abort();
    expect(await cancelled).toMatchObject({ok:false,error:{code:'preflight-catalog-unavailable'}});
    expect(await healthy).toMatchObject({ok:true,result:{commands:{items:[
      {command:'mixed-case',description:'Native command'},{command:'skill:design'}]}}});
  });
  it('rejects an invalid value-free secret overlay before launching the native process', async () => {
    expect(await invoke({secretReferenceOverlay:{v:1,bindings:{TOKEN:{ref:'invalid',value:'forbidden'}}}}))
      .toMatchObject({ok:false,error:{code:'profile-preflight-failed'}});
    expect(existsSync(capture)).toBe(false);
  });
});
