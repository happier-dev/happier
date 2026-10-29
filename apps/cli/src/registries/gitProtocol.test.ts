import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe,expect,it,vi} from 'vitest';
import * as scm from '@/scm/runtime';
import {runScmCommand} from '@/scm/runtime';
import {createRegistryGitProtocolV1} from './gitProtocol';
import type {RegistryFetchContextV1,RegistrySourceV1} from '@happier-dev/protocol/registries';
import {createRegistryHostV1} from '@happier-dev/protocol/registries';
import {createEphemeralTlsServerFixture} from '../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

describe('Node Git registry transport',()=>{
  it.each([true,false])('acquires one filtered repository for a selected-content operation and retires it afterwards (filter supported: %s)',async filterSupported=>{
    const cwd=await mkdtemp(join(tmpdir(),'happier-registry-selected-'));
    const command=async(args:string[])=>{const result=await runScmCommand({bin:'git',cwd,args});if(!result.success)throw new Error(result.stderr);return result.stdout.trim();};
    let restore=()=>{};
    try{
      await command(['init']);await command(['config','user.name','Registry fixture']);await command(['config','user.email','registry-fixture@example.invalid']);
      await command(['config','uploadpack.allowFilter',String(filterSupported)]);
      await mkdir(join(cwd,'selected'));await mkdir(join(cwd,'unrelated'));
      const markdown='---\nname: selected\n---\nReviewed content';
      await writeFile(join(cwd,'selected','SKILL.md'),markdown);
      const binary=randomBytes(4096);await writeFile(join(cwd,'selected','asset.bin'),binary);
      for(let index=0;index<24;index++)await writeFile(join(cwd,'unrelated',`${index}.bin`),randomBytes(16384));
      await command(['add','.']);await command(['commit','-m','fixture']);
      const commit=await command(['rev-parse','HEAD']);
      const gitVersion=await command(['--version']);
      const allObjects=(await command(['rev-list','--objects','HEAD'])).split('\n').length;
      // Measure the previous read + files transfers over upload-pack, without local hardlink optimization.
      let baselineTransferredObjects=0;
      for(const name of ['before-read','before-files']){
        const baseline=join(cwd,name);
        await command(['clone','--depth','1','--no-checkout','--',pathToFileURL(cwd).href,baseline]);
        const stats=await command(['-C',baseline,'count-objects','-v']);
        const fields=new Map(stats.split('\n').map(line=>{const [key,value]=line.split(': ');return [key!,value!] as const;}));
        baselineTransferredObjects+=Number(fields.get('count'))+Number(fields.get('in-pack'));
      }
      expect(baselineTransferredObjects).toBe(allObjects*2);
      const source={id:'selected',title:'Selected',format:'git' as const,kinds:['skill' as const],url:cwd,enabled:true,addedAt:0,
        origin:{kind:'user' as const},removable:true};
      const realRun=scm.runScmCommand;
      const acquired:string[]=[];
      const objectCounts=new Map<string,number>();
      // Observe the real OS adapter, including its temporary object store. No Git/domain logic is replaced.
      const observer=vi.spyOn(scm,'runScmCommand').mockImplementation(async input=>{
        const result=await realRun(input);
        if(input.args.includes('clone')&&result.success)acquired.push(input.args.at(-1)!);
        if(acquired.includes(input.cwd)&&result.success){
          const stats=await realRun({bin:'git',cwd:input.cwd,args:['count-objects','-v']});
          const fields=new Map(stats.stdout.trim().split('\n').map(line=>{const [key,value]=line.split(': ');return [key!,value!] as const;}));
          objectCounts.set(input.cwd,Number(fields.get('count'))+Number(fields.get('in-pack')));
        }
        return result;
      });
      restore=()=>observer.mockRestore();
      const forbidden=async()=>{throw new Error('Git fixture must not use HTTP');};
      const host=createRegistryHostV1({host:'node',git:createRegistryGitProtocolV1({}),
        http:{getJson:forbidden,getText:forbidden,getBytes:forbidden},readSources:async()=>[source]});
      const downloaded=await host.filesForPointer({sourceId:source.id,itemId:'selected',version:commit});
      expect(downloaded.map(file=>file.path).sort()).toEqual(['SKILL.md','asset.bin']);
      expect(downloaded.find(file=>file.path==='asset.bin')!.bytes).toEqual(new Uint8Array(binary));
      const objects=[...objectCounts.values()].reduce((sum,count)=>sum+count,0);
      console.info('selected Git acquisition',{gitVersion,filterSupported,baselineTransferredObjects,acquisitions:acquired.length,objects,fullRepositoryObjects:allObjects});
      expect(acquired).toHaveLength(1);
      if(filterSupported)expect(objects).toBeLessThan(allObjects);
      await Promise.all(acquired.map(path=>expect(readFile(join(path,'.git','config'))).rejects.toMatchObject({code:'ENOENT'})));
      await host.filesForPointer({sourceId:source.id,itemId:'selected',version:commit});
      expect(acquired).toHaveLength(2);
      const listed=await host.fetchRequest({op:'list',sourceId:source.id,kind:'skill'});
      expect(listed).toMatchObject({op:'list',page:{status:{state:'ok'},items:[{itemId:'selected',version:commit}]}});
      expect(acquired).toHaveLength(3);
      if(filterSupported)expect(objectCounts.get(acquired.at(-1)!)).toBeLessThan(objects);
      const item=await host.readRegistryItem({sourceId:source.id,itemId:'selected',version:commit});
      const git=createRegistryGitProtocolV1({});
      await expect(git.files({...item.payload.skill,files:item.payload.skill.files.map(file=>({...file,blobSha:'0'.repeat(40)}))},source))
        .rejects.toThrow('registry_blob_sha_mismatch');
      if(item.payload.skill.ref.kind!=='gitTree')throw new Error('Expected Git registry content');
      await expect(git.files({...item.payload.skill,ref:{...item.payload.skill.ref,treeSha:'0'.repeat(40)}},source))
        .rejects.toThrow('registry_tree_sha_mismatch');
      const controller=new AbortController();controller.abort();
      const cancelled=createRegistryHostV1({host:'node',git:createRegistryGitProtocolV1({signal:controller.signal}),signal:controller.signal,
        http:{getJson:forbidden,getText:forbidden,getBytes:forbidden},readSources:async()=>[source]});
      const beforeCancel=acquired.length;
      await expect(cancelled.filesForPointer({sourceId:source.id,itemId:'selected',version:commit})).rejects.toMatchObject({name:'AbortError'});
      expect(acquired).toHaveLength(beforeCancel);
    }finally{restore();await rm(cwd,{recursive:true,force:true});}
  });
  it.each([false,true])('preserves scoped operator TLS config and sends only the managed token to its HTTPS destination (inherited header: %s)',async inheritedHeader=>{
    const tls=await createEphemeralTlsServerFixture();
    const options={key:await readFile(tls.privateKeyPath),cert:await readFile(tls.leafCertificatePath)};
    const forwarded:unknown[]=[];const sourceHeaders:unknown[]=[];
    const target=createServer(options,(req,res)=>{forwarded.push(req.headers['x-api-key']);res.writeHead(404);res.end();});
    await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
    const address=target.address();if(!address||typeof address==='string')throw new Error('HTTPS fixture port unavailable');
    const sourceServer=createServer(options,(req,res)=>{sourceHeaders.push(req.headers['x-api-key']);res.writeHead(302,{Location:`https://127.0.0.1:${address.port}/other/info/refs?service=git-upload-pack`});res.end();});
    await new Promise<void>(resolve=>sourceServer.listen(0,'127.0.0.1',resolve));
    try{
      const sourceAddress=sourceServer.address();if(!sourceAddress||typeof sourceAddress==='string')throw new Error('HTTPS fixture port unavailable');
      const sourceUrl=`https://127.0.0.1:${sourceAddress.port}/repo`;
      vi.stubEnv('GIT_SSL_CAINFO',undefined);
      vi.stubEnv('GIT_CONFIG_COUNT',inheritedHeader?'2':'1');
      vi.stubEnv('GIT_CONFIG_KEY_0',`http.https://127.0.0.1:${sourceAddress.port}/.sslCAInfo`);
      vi.stubEnv('GIT_CONFIG_VALUE_0',tls.caCertificatePath);
      if(inheritedHeader){
        vi.stubEnv('GIT_CONFIG_KEY_1',`http.${sourceUrl}.extraHeader`);
        vi.stubEnv('GIT_CONFIG_VALUE_1','X-Api-Key: operator-header');
      }
      const git=createRegistryGitProtocolV1({resolveToken:async()=> 'fixture-secret'});
      const source:RegistrySourceV1={id:'redirect',title:'Redirect',format:'git',url:sourceUrl,kinds:['skill'],enabled:true,addedAt:0,
        token:{secretRef:'happier:shared-secret:v1:redirect',header:{name:'X-Api-Key'}}};
      const forbidden=async()=>{throw new Error('Git transport must not use registry HTTP');};
      await expect(git.list({git,http:{getJson:forbidden,getText:forbidden,getBytes:forbidden}},{source,kind:'skill'})).rejects.toMatchObject({status:{state:'unreachable'}});
      expect(sourceHeaders).toEqual(['fixture-secret']);expect(forwarded).toEqual([]);
      // Keep TLS available independently while proving malformed config never
      // becomes a fresh valid config, and Git's valid empty count remains zero.
      vi.stubEnv('GIT_SSL_CAINFO',tls.caCertificatePath);
      for(const malformedCount of ['not-a-count','1\n']){
        vi.stubEnv('GIT_CONFIG_COUNT',malformedCount);
        await expect(git.list({git,http:{getJson:forbidden,getText:forbidden,getBytes:forbidden}},{source,kind:'skill'})).rejects.toMatchObject({status:{state:'unreachable'}});
        expect(sourceHeaders).toEqual(['fixture-secret']);
      }
      vi.stubEnv('GIT_CONFIG_COUNT','1');vi.stubEnv('GIT_CONFIG_KEY_0',undefined);
      await expect(git.list({git,http:{getJson:forbidden,getText:forbidden,getBytes:forbidden}},{source,kind:'skill'})).rejects.toMatchObject({status:{state:'unreachable'}});
      expect(sourceHeaders).toEqual(['fixture-secret']);
      vi.stubEnv('GIT_CONFIG_COUNT','');
      await expect(git.list({git,http:{getJson:forbidden,getText:forbidden,getBytes:forbidden}},{source,kind:'skill'})).rejects.toMatchObject({status:{state:'unreachable'}});
      expect(sourceHeaders).toEqual(['fixture-secret','fixture-secret']);expect(forwarded).toEqual([]);
      await expect(git.latest({git,http:{getJson:forbidden,getText:forbidden,getBytes:forbidden}},[{
        sourceId:source.id,format:'git',sourceUrl:source.url,itemId:'',importedAt:1,
        ref:{kind:'gitTree',repo:`https://127.0.0.1:${address.port}/other`,path:'',commit:'1'.repeat(40),treeSha:'tree'},
      }],{source})).rejects.toMatchObject({status:{state:'invalid_source'}});
      expect(forwarded).toEqual([]);
    }finally{
      await Promise.all([new Promise<void>(resolve=>sourceServer.close(()=>resolve())),new Promise<void>(resolve=>target.close(()=>resolve()))]);
      vi.unstubAllEnvs();
      await tls.cleanup();
    }
  });
  it('lists an exact SHA source ref and downloads its pinned files after the branch changes',async()=>{
    const cwd=await mkdtemp(join(tmpdir(),'happier-registry-git-test-'));
    const command=async(args:string[])=>{const result=await runScmCommand({bin:'git',cwd,args});if(!result.success)throw new Error(result.stderr);return result.stdout.trim();};
    try{
      await command(['init']);await command(['config','user.name','Registry fixture']);await command(['config','user.email','registry-fixture@example.invalid']);
      const binary=new Uint8Array(5_550_001).fill(255);
      await writeFile(join(cwd,'SKILL.md'),'---\nname: pinned\n---\nReviewed\n');await writeFile(join(cwd,'asset.bin'),binary);await command(['add','SKILL.md','asset.bin']);await command(['commit','-m','reviewed']);
      const commit=await command(['rev-parse','HEAD']);
      await writeFile(join(cwd,'SKILL.md'),'Changed\n');await command(['add','SKILL.md']);await command(['commit','-m','moved']);
      const source:RegistrySourceV1={id:'node-git',title:'Fixture',format:'git',kinds:['skill'],url:cwd,ref:commit,enabled:true,addedAt:0};
      const git=createRegistryGitProtocolV1({});
      const forbidden=async()=>{throw new Error('Non-GitHub registry must not use HTTP');};
      const ctx:RegistryFetchContextV1={git,http:{getJson:forbidden,getText:forbidden,getBytes:forbidden}};
      expect(await git.list(ctx,{source,kind:'skill'})).toMatchObject({status:{state:'ok'},items:[{itemId:'',version:commit}]});
      const item=await git.read(ctx,{source,kind:'skill',itemId:'',version:commit});
      expect(item.payload.skill.skillMarkdown).toContain('Reviewed');
      const latest=await git.latest(ctx,[{sourceId:source.id,format:'git',sourceUrl:source.url,itemId:'',
        ref:item.payload.skill.ref,importedAt:item.fetchedAt}],{source});
      expect(latest.get('')).toEqual(item.payload.skill.ref);
      const downloaded=await git.files(item.payload.skill,source);
      expect(new TextDecoder().decode(downloaded.find(file=>file.path==='SKILL.md')!.bytes)).toContain('Reviewed');
      expect(downloaded.find(file=>file.path==='asset.bin')!.bytes).toEqual(binary);
    }finally{await rm(cwd,{recursive:true,force:true});}
  });
});
