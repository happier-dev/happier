import { describe,expect,it } from 'vitest';
import { githubRegistryAdapterV1, readGitHubRepositoryV1 } from './github.js';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { computeGitBlobShaV1,computeGitTreeShaV1 } from '../registryGitTreeV1.js';
import { RegistryFetchResponseV1Schema } from '../registryRpcV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';
import type { RegistrySourceDescriptorV1 } from '../registrySourcesV1.js';
import { SkillLockV1Schema } from '../../prompts/library/skills/skillLibraryItemV1.js';
const commit='1'.repeat(40), next='2'.repeat(40);
const files=[{path:'SKILL.md',unixMode:0o644 as const,bytes:new TextEncoder().encode('# Hello\n')},
  {path:'run.sh',unixMode:0o755 as const,bytes:new TextEncoder().encode('#!/bin/sh\n')}];
const source:RegistrySourceDescriptorV1={id:'repo',title:'Repo',format:'git',kinds:['skill'],url:'https://github.com/a/b',enabled:true,addedAt:0,origin:{kind:'user'},removable:true};

describe('GitHub registry producer and pinned strict consumer',()=>{
  it.each([
    ['https://github.com/anthropics/skills/tree/main/skills/pdf', 'main', 'skills/pdf'],
    ['https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md', 'main', 'skills/pdf'],
    ['https://github.com/anthropics/skills/blob/main/SKILL.md', 'main', ''],
    ['https://github.com/anthropics/skills/tree/release%2Fv1/skills/pdf/', 'release/v1', 'skills/pdf'],
  ])('resolves the skill folder and ref from %s', (url, ref, path) => {
    expect(readGitHubRepositoryV1(url)).toEqual({ owner: 'anthropics', repo: 'skills',
      url: 'https://github.com/anthropics/skills', ref, path });
  });
  it('keeps a repository URL at its default branch and root', () => {
    expect(readGitHubRepositoryV1('https://github.com/anthropics/skills')).toEqual({
      owner: 'anthropics', repo: 'skills', url: 'https://github.com/anthropics/skills' });
  });
  it('uses the real git tree vector with executable mode',()=>{
    // git hash-object -t tree --stdin over raw entries: 100644 SKILL.md, 100755 run.sh.
    expect(computeGitTreeShaV1(files)).toBe('2ef8a059432b65b1b0063b902bc61fa79b70a706');
    expect(computeGitTreeShaV1(files.map(file=>({...file,unixMode:0o644 as const})))).not.toBe(computeGitTreeShaV1(files));
  });
  it('reads and downloads the reviewed commit after HEAD moves, retaining source binding across serialization',async()=>{
    let head=commit;
    const reads:string[]=[];
    const http:RegistryHttpV1={
      async getJson(url){reads.push(url);return {ok:true,fetchedAt:1,value:url.includes('/commits/')?{sha:url.endsWith('/HEAD')?head:decodeURIComponent(url.split('/').at(-1)!)}:
        {sha:computeGitTreeShaV1(files),tree:files.map(file=>({path:file.path,mode:file.unixMode===0o755?'100755':'100644',type:'blob',sha:computeGitBlobShaV1(file.bytes),size:file.bytes.length}))}};},
      async getText(){return {ok:true,fetchedAt:1,value:'# Hello\n'};},
      async getBytes(url,options){expect(options?.source?.id).toBe('repo');expect(url).toContain('/'+commit+'/');return {ok:true,fetchedAt:1,value:files.find(file=>url.endsWith('/'+file.path))!.bytes};},
    };
    const host=createRegistryHostV1({host:'node',http,readSources:async()=>[source]});
    const initial=await host.fetchRequest({op:'read',kind:'skill',sourceId:source.id,itemId:''});
    const consumed=RegistryFetchResponseV1Schema.parse(JSON.parse(JSON.stringify(initial)));
    expect(consumed.op).toBe('read');if(consumed.op!=='read')throw new Error('read required');
    if(consumed.item.payload.kind!=='skill')throw new Error('skill required');
    const pointer={sourceId:source.id,itemId:'',version:consumed.item.summary.version!};head=next;
    const admittedReads=reads.length;
    expect(SkillLockV1Schema.parse({provenance:{kind:'registry',registry:{sourceId:pointer.sourceId,itemId:pointer.itemId,
      format:source.format,sourceUrl:source.url,ref:consumed.item.payload.skill.ref,importedAt:1}},updatePolicy:'manual'}).provenance.kind).toBe('registry');
    expect(await host.filesForPointer(pointer)).toEqual(files);
    expect(reads.slice(admittedReads).filter(url=>url.includes('/commits/'))).toEqual([]);
    expect(RegistryFetchResponseV1Schema.safeParse({...initial,extra:true}).success).toBe(false);
  });
  it.each(['120000','160000'])('refuses a %s entry without reading its bytes',async(mode)=>{
    const http:RegistryHttpV1={getJson:async(url)=>({ok:true,fetchedAt:1,value:url.includes('/commits/')?{sha:commit}:{sha:'tree',tree:[
      {path:'SKILL.md',type:'blob',mode:'100644',sha:'x',size:1},{path:'unsafe',type:mode==='160000'?'commit':'blob',mode,sha:'x'}]}}),
      getText:async()=>{throw new Error('must not read unsafe bundle');},getBytes:async()=>{throw new Error('must not download unsafe bundle');}};
    const item=await githubRegistryAdapterV1.read({http},{source,kind:'skill',itemId:''});
    expect(item.summary.problem).toEqual({code:'unsupported_entry',reason:mode==='120000'?'symlink':'submodule'});
  });
  it('reports truncated trees as invalid source',async()=>{
    const http:RegistryHttpV1={getJson:async(url)=>({ok:true,fetchedAt:1,value:url.includes('/commits/')?{sha:commit}:{sha:'tree',tree:[],truncated:true}}),getText:async()=>({ok:true,fetchedAt:1,value:''}),getBytes:async()=>({ok:true,fetchedAt:1,value:new Uint8Array()})};
    expect((await githubRegistryAdapterV1.list({http},{source,kind:'skill'})).status).toEqual({state:'invalid_source'});
  });
  it('rejects corrupt downloaded bytes and never queries a disabled source',async()=>{
    const http:RegistryHttpV1={getJson:async(url)=>({ok:true,fetchedAt:1,value:url.includes('/commits/')?{sha:commit}:
      {sha:computeGitTreeShaV1(files),tree:files.map(file=>({path:file.path,mode:file.unixMode===0o755?'100755':'100644',type:'blob',sha:computeGitBlobShaV1(file.bytes),size:file.bytes.length}))}}),
      getText:async()=>({ok:true,fetchedAt:1,value:'# Hello\n'}),getBytes:async()=>({ok:true,fetchedAt:1,value:new TextEncoder().encode('corrupt')})};
    const host=createRegistryHostV1({host:'node',http,readSources:async()=>[source]});
    await expect(host.filesForPointer({sourceId:source.id,itemId:'',version:commit})).rejects.toThrow('registry_blob_sha_mismatch');
    const forbidden=async()=>{throw new Error('disabled source queried');};
    const disabled=createRegistryHostV1({host:'node',http:{getJson:forbidden,getText:forbidden,getBytes:forbidden},readSources:async()=>[{...source,enabled:false}]});
    expect(await disabled.fetchRequest({op:'read',sourceId:source.id,kind:'skill',itemId:'',version:commit})).toEqual({op:'error',status:{state:'invalid_source'}});
    expect(await disabled.fetchRequest({op:'files',sourceId:source.id,kind:'skill',itemId:'',version:commit})).toEqual({op:'error',status:{state:'invalid_source'}});
  });
});
