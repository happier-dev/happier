import { once } from 'node:events';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it, onTestFailed, onTestFinished } from 'vitest';

import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';
import { writeModuleLoadObserver } from '@/testkit/process/moduleLoadObserver';
import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';

it('keeps Session transition implementations cold through the real Action factory/catalog boundary and loads them on first use', async () => {
  const cliRoot = projectPath();
  const repoDir = join(cliRoot, '..', '..');
  const owner = (path: string) => JSON.stringify(pathToFileURL(join(cliRoot, 'src', path)).href);
  const heavyPaths = ['sessionAgentTransitionCoordinator', 'sessionContinuationInspection', 'previewSessionAgentTransitionBrief']
    .map(name => pathToFileURL(join(cliRoot, 'src/session/agentTransition', `${name}.ts`)).href);
  await withTempDir('happier-cold-action-ports-', async directory => {
    const observations = join(directory, 'loaded.ndjson');
    const observer = join(directory, 'observe.mjs');
    const probe = join(directory, 'probe.mjs');
    await writeModuleLoadObserver(observer, observations);
    await writeFile(probe, `
      import assert from 'node:assert/strict';
      import {createServer} from 'node:http';
      import {readFileSync} from 'node:fs';
      import {register} from 'node:module';
      register(${JSON.stringify(pathToFileURL(observer).href)},{data:{output:${JSON.stringify(observations)}}});
      const loaded=()=>readFileSync(${JSON.stringify(observations)},'utf8').trim().split('\\n').filter(Boolean).map(line=>new URL(JSON.parse(line)).href.split('?')[0]);
      const heavy=${JSON.stringify(heavyPaths)};
      const {createActionSettingsProvider}=await import(${owner('settings/actionsSettingsProvider.ts')});
      const {createCliActionExecutorFromCredentials}=await import(${owner('session/actions/createCliActionExecutorFromCredentials.ts')});
      const {createCliActionDeps}=await import(${owner('session/actions/createCliActionDeps.ts')});
      const {runWithServerHttpBaseUrl}=await import(${owner('api/client/serverHttpBaseUrl.ts')});
      const {RpcHandlerManager}=await import(${owner('api/rpc/RpcHandlerManager.ts')});
      const {registerSessionAgentTransitionRpcHandlers}=await import(${owner('rpc/handlers/sessionAgentTransition.ts')});
      const {RPC_METHODS}=await import('@happier-dev/protocol/rpc/methods');
      const credentials={token:'cold-port-fixture',encryption:null};
      const rpc=new RpcHandlerManager({scopePrefix:'cold-machine',encryptionMode:'plain'});
      registerSessionAgentTransitionRpcHandlers(rpc,{readCredentials:async()=>credentials});
      const server=createServer((_request,response)=>{response.writeHead(404,{'content-type':'application/json'});response.end('{}');});
      try{
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const origin='http://127.0.0.1:'+server.address().port;
        const deps=createCliActionDeps({token:credentials.token,credentials,sessionId:'cli-global',mode:'plain',ctx:null,serverHttpBaseUrl:origin,serverId:'cold-home'});
        const executor=createCliActionExecutorFromCredentials({credentials,serverId:'cold-home',serverApiUrl:origin,
          pluginActionExecutionOwner:'current_process',actionsSettingsProvider:createActionSettingsProvider()});
        const catalog=await executor.execute('action.spec.search',{query:'machines.list',limit:10},{surface:'cli'});
        assert.equal(catalog.ok,true,JSON.stringify(catalog));
        assert.ok(catalog.result.actionSpecs.some(spec=>spec.id==='machines.list'),'real core catalog output is required');
        assert.deepEqual(await rpc.invokeLocal(RPC_METHODS.SESSION_CONTINUATION_INSPECT,{}),{type:'unavailable',reason:'unsupported_session'});
        await assert.rejects(rpc.invokeLocal(RPC_METHODS.SESSION_CONTINUATION_INSPECT,
          {v:1,sourceSessionId:'absent-session',selection:{v:1,agentId:'codex'}},
          {signal:AbortSignal.abort(new Error('cancelled-before-admission'))}));
        const cold=loaded();
        process.stdout.write(JSON.stringify({phase:'cold-after-factory-catalog',loaderEvents:cold.length,uniqueModules:new Set(cold).size,heapUsed:process.memoryUsage().heapUsed})+'\\n');
        assert.deepEqual(heavy.filter(url=>cold.includes(url)),[], 'Action factory/catalog must not load transition implementations');
        await runWithServerHttpBaseUrl(origin,async()=>{
          assert.equal((await rpc.invokeLocal(RPC_METHODS.SESSION_CONTINUATION_INSPECT,{v:1,sourceSessionId:'absent-session',selection:{v:1,agentId:'codex'}})).type,'unavailable');
          assert.equal((await rpc.invokeLocal(RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW,{v:1,sessionId:'absent-session',sourceCutoffSeqInclusive:0,sourceAgentId:'claude',targetAgentId:'codex'})).type,'unavailable');
          const inspection=await deps.sessionContinuationInspect({input:{sessionId:'absent-session',selection:{v:1,agentId:'codex'}}});
          assert.equal(inspection.status,'answered');assert.equal(inspection.inspection.type,'unavailable');
          const transition=await deps.sessionAgentTransition({request:{v:1,sessionId:'absent-session',expectedCurrentAgentId:'claude',selection:{v:1,agentId:'codex'},input:{text:'continue',localId:'cold-transition',meta:{}}},context:{surface:'cli',authority:'present_user',actionCaller:{kind:'host'}}});
          assert.equal(transition.type,'rejected');assert.equal(transition.sourceEffect,'none');
        });
        assert.ok(heavy.every(url=>loaded().includes(url)),'first use must load every real implementation');
        const firstUse=loaded();
        process.stdout.write(JSON.stringify({phase:'first-use',loaderEvents:firstUse.length,uniqueModules:new Set(firstUse).size,heapUsed:process.memoryUsage().heapUsed})+'\\n');
        process.stdout.write('cold-action-ports-verified\\n');
      }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    `);
    const child = spawnTestProcess(process.execPath, ['--import', pathToFileURL(join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs')).href, probe], {
      cwd: cliRoot, env: { ...process.env, TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath() }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    const diagnostics: string[] = [];
    child.stdout?.on('data', chunk => diagnostics.push(String(chunk)));
    child.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    onTestFailed(() => console.error(diagnostics.join('')));
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
    });
    const [code] = await closed;
    expect(code, diagnostics.join('')).toBe(0);
    console.info(diagnostics.join(''));
    expect(diagnostics.join('')).toContain('cold-action-ports-verified');

    const entry = join(directory, 'component.ts');
    await writeFile(entry, `export {createCliActionDeps} from ${JSON.stringify(join(cliRoot, 'src/session/actions/createCliActionDeps.ts'))};
      export {registerSessionAgentTransitionRpcHandlers} from ${JSON.stringify(join(cliRoot, 'src/rpc/handlers/sessionAgentTransition.ts'))};`);
    const { readWorkspacePackages, createWorkspaceSourceResolver, SOURCE_RUNTIME_OUTPUT_OPTIONS } = await import(
      /* @vite-ignore */ pathToFileURL(join(repoDir, 'packages/cli-common/sourceRuntimeEntries.mjs')).href
    );
    const built = await build({
      absWorkingDir: repoDir, entryPoints: [entry], outdir: join(directory, 'output'), write: false,
      bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20', ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
      conditions: ['happier-source'], tsconfig: join(cliRoot, 'tsconfig.json'), metafile: true, logLevel: 'silent',
      plugins: [createWorkspaceSourceResolver({ workspacePackages: await readWorkspacePackages(repoDir), requireFromProject: createRequire(join(cliRoot, 'package.json')) })],
    });
    const outputs = built.metafile!.outputs;
    const heavy = Object.entries(outputs).filter(([, output]) => Object.entries(output.inputs).some(([input, detail]) =>
      /\/sessionAgentTransitionCoordinator\.ts$|\/sessionContinuationInspection\.ts$|\/previewSessionAgentTransitionBrief\.ts$/u.test(input) && detail.bytesInOutput > 0))
      .map(([path]) => path);
    expect(heavy.length).toBeGreaterThan(0);
    const reachable = (includeDynamic: boolean) => {
      const seen = new Set<string>();
      const pending = Object.entries(outputs).filter(([, output]) => output.entryPoint && resolve(repoDir, output.entryPoint) === entry).map(([path]) => path);
      expect(pending.length).toBe(1);
      while (pending.length) {
        const path = pending.pop()!;
        if (seen.has(path)) continue;
        seen.add(path);
        for (const dependency of outputs[path].imports) {
          if (dependency.external || (!includeDynamic && dependency.kind === 'dynamic-import')) continue;
          const target = Object.hasOwn(outputs, dependency.path) ? dependency.path : posix.normalize(posix.join(posix.dirname(path), dependency.path));
          expect(Object.hasOwn(outputs, target)).toBe(true);
          pending.push(target);
        }
      }
      return seen;
    };
    const cold = reachable(false);
    const allDemand = reachable(true);
    expect(heavy.filter(path => cold.has(path))).toEqual([]);
    expect(heavy.every(path => allDemand.has(path))).toBe(true);
    console.info('Emitted Action component reachability', {
      coldOutputs: cold.size, allDemandOutputs: allDemand.size, heavyOutputs: heavy.length,
      coldBytes: [...cold].reduce((total, path) => total + outputs[path].bytes, 0),
      allDemandBytes: [...allDemand].reduce((total, path) => total + outputs[path].bytes, 0),
    });
  });
}, 120_000);
