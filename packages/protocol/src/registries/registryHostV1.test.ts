import {describe,expect,it} from 'vitest';
import {createRegistryHostV1} from './registryHostV1.js';
import {listRegistrySourcesV1,type RegistrySourceDescriptorV1} from './registrySourcesV1.js';
import type {RegistryHttpV1} from './formats/registryFormatAdapterV1.js';
import {computeGitBlobShaV1,computeGitTreeShaV1} from './registryGitTreeV1.js';
import {encodeBase64} from '../crypto/base64.js';
const commit='1'.repeat(40);
const source=(id:string):RegistrySourceDescriptorV1=>({id,title:id,format:'git',kinds:['skill'],url:`https://github.com/account/${id}`,enabled:true,addedAt:0,origin:{kind:'user'},removable:true});
const tree={sha:'tree',tree:[{path:'review/SKILL.md',type:'blob',mode:'100644',sha:'blob',size:3},{path:'review',type:'tree',mode:'040000',sha:'subtree'}]};

describe('registry link operation',()=>{
  it('retains app source detection without probing app catalogs for a selected skill link', async () => {
    const requests: string[] = [];
    const url = 'https://github.com/owner/catalog';
    const indexUrl = 'https://raw.githubusercontent.com/owner/catalog/HEAD/templates/service-templates.json';
    const forbidden = async (): Promise<never> => { throw new Error('Detection cannot read selected bodies'); };
    const http: RegistryHttpV1 = { getJson: async target => {
      requests.push(target);
      if (target === indexUrl) return { ok: true, fetchedAt: 1, value: { database: { slogan: 'Database' } } };
      if (target.endsWith('/.claude-plugin/marketplace.json')) return { ok: true, fetchedAt: 1, value: { plugins: [] } };
      throw new Error(`Unexpected detection request: ${target}`);
    }, getText: forbidden, getBytes: forbidden };
    const host = createRegistryHostV1({ host: 'web', http, readSources: async () => [] });
    expect(await host.execute('registries.sources.detect', { url })).toMatchObject({ detected: {
      format: 'coolify-templates', kinds: ['app'],
    } });
    expect(requests).toEqual([indexUrl]);
    requests.length = 0;
    expect(await host.fetchRequest({ op: 'link', url })).toEqual({ op: 'link', items: [] });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests).not.toContain(indexUrl);
  });
  it.each([
    ['tree/main/skills/pdf', 'skills/pdf', 'main'],
    ['blob/main/skills/pdf/SKILL.md', 'skills/pdf', 'main'],
    ['blob/main/SKILL.md', '', 'main'],
    ['tree/release%2Fv1/skills/pdf/', 'skills/pdf', 'release%2Fv1'],
  ])('reads the selected GitHub skill despite a repository-root marketplace: %s', async (suffix, path, ref) => {
    const url = `https://github.com/anthropics/skills/${suffix}`;
    const prefix = path ? path + '/' : '';
    const requests: string[] = [];
    const markdown = '---\nname: pdf\ndescription: PDF tools\n---\nInstructions';
    const file = { path: 'SKILL.md', unixMode: 0o644 as const, bytes: new TextEncoder().encode(markdown) };
    const http: RegistryHttpV1 = {
      getJson: async target => {
        requests.push(target);
        if (target === 'https://raw.githubusercontent.com/anthropics/skills/HEAD/.claude-plugin/marketplace.json'
          || target === 'https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json') {
          return { ok: true, fetchedAt: 1, value: { plugins: [{ name: 'documents', source: './' }] } };
        }
        if (target.endsWith('/marketplace.json')) return { ok: false, status: { state: 'invalid_source' } };
        if (target.includes('/commits/')) return { ok: true, fetchedAt: 1, value: { sha: commit } };
        if (target.includes('/git/trees/')) return { ok: true, fetchedAt: 1, value: { sha: computeGitTreeShaV1([file]), tree: [
          ...(path ? [{ path, type: 'tree', mode: '040000', sha: computeGitTreeShaV1([file]) },
            { path: 'skills/other/SKILL.md', type: 'blob', mode: '100644', sha: '3'.repeat(40), size: 1 }] : []),
          { path: prefix + 'SKILL.md', type: 'blob', mode: '100644', sha: computeGitBlobShaV1(file.bytes), size: file.bytes.length },
        ] } };
        return { ok: true, fetchedAt: 1, value: { name: 'skills' } };
      },
      getText: async target => {
        expect(target).toBe(`https://raw.githubusercontent.com/anthropics/skills/${commit}/${prefix}SKILL.md`);
        return { ok: true, fetchedAt: 1, value: markdown };
      },
      getBytes: async () => ({ ok: true, fetchedAt: 1, value: file.bytes }),
    };
    const host = createRegistryHostV1({ host: 'node', http, readSources: async () => [] });
    const items = await host.readLinkSkills(url);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ summary: { title: 'pdf', version: commit }, payload: { kind: 'skill', skill: {
      ref: { repo: 'https://github.com/anthropics/skills', path, commit },
    } } });
    expect(await host.fetchLinkSkillFiles(url, items[0]!)).toEqual([file]);
    expect(requests).toContain(`https://api.github.com/repos/anthropics/skills/commits/${ref}`);
  });
  it.each(['rate_limited','auth_failed'] as const)('preserves %s during detection without continuing quota requests',async state=>{
    const requests:string[]=[];
    const fail=async(url:string)=>{requests.push(url);return {ok:false as const,status:{state}};};
    const host=createRegistryHostV1({host:'web',readSources:async()=>[],http:{getJson:fail,getText:fail,getBytes:fail}});
    expect(await host.fetchRequest({op:'link',url:'https://github.com/owner/limited'})).toEqual({op:'error',status:{state}});
    expect(requests).toHaveLength(state==='rate_limited'?1:2);
  });
  it('reuses the repository reader across marketplace listing and pinned skill reads, then refreshes the next operation',async()=>{
    const requests:string[]=[];
    const names=['review','release','debug'];
    const markdown=(name:string)=>`---\nname: ${name}\n---\nInstructions`;
    const bytes=(name:string)=>new TextEncoder().encode(markdown(name));
    const http:RegistryHttpV1={getJson:async url=>{
      requests.push(url);
      return {ok:true,fetchedAt:2,value:url.endsWith('marketplace.json')?{plugins:names.map(name=>({name,source:`./plugins/${name}`}))}
        :url.endsWith('plugin.json')?{}:url.includes('/commits/')?{sha:commit}:{sha:'2'.repeat(40),tree:names.flatMap(name=>[
          {path:`plugins/${name}/skills/${name}`,type:'tree',mode:'040000',sha:computeGitTreeShaV1([{path:'SKILL.md',unixMode:0o644,bytes:bytes(name)}])},
          {path:`plugins/${name}/skills/${name}/SKILL.md`,type:'blob',mode:'100644',sha:computeGitBlobShaV1(bytes(name)),size:bytes(name).length},
        ])}};
    },getText:async url=>({ok:true,fetchedAt:2,value:markdown(url.split('/').at(-2)!)}),
      getBytes:async url=>({ok:true,fetchedAt:2,value:bytes(url.split('/').at(-2)!)})};
    const host=createRegistryHostV1({host:'web',http,readSources:async()=>[]});
    for(let operation=1;operation<=2;operation++){
      const items=await host.readLinkSkills('https://github.com/owner/market');
      expect(items.map(item=>item.summary.title)).toEqual(names);
      await Promise.all(items.map(item=>host.fetchLinkSkillFiles('https://github.com/owner/market',item)));
      expect(requests.filter(url=>url.includes('/commits/'))).toHaveLength(operation);
      expect(requests.filter(url=>url.includes('/git/trees/'))).toHaveLength(operation);
    }
  });
  it('retains the prescribed file transport fallback and refuses changed pinned bytes',async()=>{
    const markdown='---\nname: review\n---\nInstructions';
    const bytes=new TextEncoder().encode(markdown);
    const file={path:'SKILL.md',unixMode:0o644 as const,bytes};
    let transportFails=false,corrupted=false;
    const daemonRequests:unknown[]=[];
    const http:RegistryHttpV1={getJson:async url=>url.endsWith('marketplace.json')?{ok:false,status:{state:'invalid_source'}}
      :{ok:true,fetchedAt:2,value:url.includes('/commits/')?{sha:commit}:url.includes('/git/trees/')?{sha:'2'.repeat(40),tree:[
        {path:'review',type:'tree',mode:'040000',sha:computeGitTreeShaV1([file])},
        {path:'review/SKILL.md',type:'blob',mode:'100644',sha:computeGitBlobShaV1(bytes),size:bytes.length},
      ]}:{name:'skills'}},getText:async()=>({ok:true,fetchedAt:2,value:markdown}),getBytes:async()=>{
        if(transportFails)throw new TypeError('Raw-file transport unavailable');
        return {ok:true,fetchedAt:2,value:corrupted?new TextEncoder().encode(markdown+' changed'):bytes};
      }};
    const host=createRegistryHostV1({host:'web',http,readSources:async()=>[],daemonFetch:async request=>{
      daemonRequests.push(request);return {op:'files',files:[{path:'SKILL.md',unixMode:0o644,contentBase64:encodeBase64(bytes)}]};
    }});
    const item=(await host.readLinkSkills('https://github.com/owner/skills'))[0]!;
    transportFails=true;
    expect(await host.fetchLinkSkillFiles('https://github.com/owner/skills',item)).toEqual([file]);
    expect(daemonRequests).toEqual([{op:'linkFiles',url:'https://github.com/owner/skills',itemId:'review',version:commit,
      ref:item.payload.skill.ref}]);
    transportFails=false;corrupted=true;
    await expect(host.fetchLinkSkillFiles('https://github.com/owner/skills',item)).rejects.toThrow('registry_blob_sha_mismatch');
    expect(daemonRequests).toHaveLength(1);
  });
});

describe('registry final transport failure classification',()=>{
  it.each(['native','web'] as const)('keeps healthy source pages when %s placement exhausts a network TypeError',async hostKind=>{
    const http:RegistryHttpV1={getJson:async url=>{if(url.includes('/failing/'))throw new TypeError('network unavailable');return {ok:true,fetchedAt:2,value:url.includes('/commits/')?{sha:commit}:tree};},
      getText:async()=>({ok:true,fetchedAt:2,value:'text'}),getBytes:async()=>({ok:true,fetchedAt:2,value:new Uint8Array()})};
    const host=createRegistryHostV1({host:hostKind,http,readSources:async()=>[source('failing'),source('healthy')],
      daemonFetch:async request=>{expect(hostKind).toBe('web');expect(request).toEqual({op:'list',sourceId:'failing',kind:'skill'});throw new TypeError('daemon transport unavailable');}});
    expect(await host.execute('registries.items.list',{kind:'skill'})).toMatchObject({pages:[
      {sourceId:'failing',status:{state:'unreachable'},items:[]},{sourceId:'healthy',status:{state:'ok'},items:[{itemId:'review',version:commit}]},
    ]});
  });
  it.each([new DOMException('Cancelled','AbortError'),new TypeError('custom cancellation reason')])('preserves cancellation instead of falling back or returning unreachable',async reason=>{
    const controller=new AbortController();const cancelled=async()=>{controller.abort(reason);throw reason;};
    const host=createRegistryHostV1({host:'web',signal:controller.signal,http:{getJson:cancelled,getText:cancelled,getBytes:cancelled},readSources:async()=>[source('failing')],
      daemonFetch:async()=>{throw new Error('cancelled request must not fall back');}});
    await expect(host.execute('registries.items.list',{kind:'skill'})).rejects.toBe(reason);
  });
  it('does not classify a miswired successful HTTP value as a transport failure',async()=>{
    const http:RegistryHttpV1={getJson:async url=>({ok:true,fetchedAt:2,value:url.includes('/commits/')?{sha:commit}:tree}),
      // Deliberately invalid external text-success fixture: the real parser raises a programming TypeError.
      getText:async()=>({ok:true,fetchedAt:2,value:undefined as unknown as string}),getBytes:async()=>({ok:true,fetchedAt:2,value:new Uint8Array()})};
    const host=createRegistryHostV1({host:'native',http,readSources:async()=>[source('healthy')]});
    await expect(host.fetchRequest({op:'read',kind:'skill',sourceId:'healthy',itemId:'review'})).rejects.toBeInstanceOf(TypeError);
  });
  it('follows the prescribed web user-link fallback when URL discovery itself loses transport',async()=>{
    const lost=async()=>{throw new TypeError('network unavailable');};
    const host=createRegistryHostV1({host:'web',http:{getJson:lost,getText:lost,getBytes:lost},readSources:async()=>[],
      daemonFetch:async request=>{expect(request).toEqual({op:'link',url:'https://github.com/account/repository'});return {op:'link',items:[]};}});
    expect(await host.readLinkSkills('https://github.com/account/repository')).toEqual([]);
  });
  it('preserves non-network programmer errors raised inside a transport implementation',async()=>{
    const original=new Error('programmer failure');const failed=async()=>{throw original;};
    const host=createRegistryHostV1({host:'native',http:{getJson:failed,getText:failed,getBytes:failed},readSources:async()=>[source('healthy')]});
    await expect(host.execute('registries.items.list',{kind:'skill'})).rejects.toBe(original);
  });
});

describe('registry source admission', () => {
  it.each(['git', 'happier-catalog'] as const)('returns an existing %s source for a canonical-equivalent URL before fetching or writing', async format => {
    const existing: RegistrySourceDescriptorV1 = { ...source('existing'), format,
      kinds: format === 'happier-catalog' ? ['plugin'] : ['skill'],
      url: format === 'happier-catalog' ? 'https://catalog.example/index.json' : 'https://github.com/acme/skills' };
    const forbidden = async () => { throw new Error('An existing source must not fetch or write'); };
    const host = createRegistryHostV1({ host: 'node', readSources: async () => [existing],
      http: { getJson: forbidden, getText: forbidden, getBytes: forbidden }, mutateSources: forbidden });
    expect(await host.execute('registries.sources.create', {
      url: format === 'happier-catalog' ? ' https://CATALOG.example/index.json/ ' : 'https://GitHub.com/acme/skills.git/',
      title: 'Must not replace the saved title',
    })).toEqual({ source: existing, existing: true });
  });

  it('refuses removal or rename of a built-in before persistence', async () => {
    const sources = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [] });
    const forbidden = async () => { throw new Error('Built-in authority must not fetch or write'); };
    const host = createRegistryHostV1({ host: 'node', readSources: async () => sources,
      http: { getJson: forbidden, getText: forbidden, getBytes: forbidden }, mutateSources: forbidden });
    await expect(host.execute('registries.sources.delete', { sourceId: 'builtin:skills-sh' })).rejects.toThrow('not_removable');
    await expect(host.execute('registries.sources.update', { sourceId: 'builtin:skills-sh', title: 'Mine' })).rejects.toThrow('not_editable');
  });
});

describe('registry mutation acknowledged receipt',()=>{
  it('retains stored legacy references but refuses new legacy bindings before fetching or writing',async()=>{
    const forbidden=async()=>{throw new Error('Invalid new binding must not disclose or persist');};
    const record={v:2 as const,disabledSourceIds:[],sources:[{...source('legacy'),token:{secretRef:'retained-personal-id'}}]};
    const host=createRegistryHostV1({host:'node',http:{getJson:forbidden,getText:forbidden,getBytes:forbidden},
      readSources:async()=>listRegistrySourcesV1({record,pluginSources:[]}),mutateSources:forbidden});
    expect(await host.execute('registries.sources.list',{})).toMatchObject({sources:expect.arrayContaining([expect.objectContaining({id:'legacy',token:{secretRef:'retained-personal-id'}})])});
    for(const [action,input] of [
      ['registries.sources.token.set',{sourceId:'legacy',token:{secretRef:'unresolved-personal-id'}}],
      ['registries.sources.create',{url:'https://github.com/new/source',token:{secretRef:'unresolved-personal-id'}}],
    ] as const)await expect(host.execute(action,input)).rejects.toMatchObject({issues:expect.arrayContaining([expect.objectContaining({path:['token','secretRef']})])});
  });
  it('authenticates tokened source detection before storing the selected canonical reference',async()=>{
    const calls:{url:string;ref:string|undefined}[]=[];
    let stored:unknown;
    const unused=async()=>{throw new Error('unused transport');};
    const host=createRegistryHostV1({host:'node',readSources:async()=>[],
      http:{getText:unused,getBytes:unused,getJson:async(url,options)=>{
        calls.push({url,ref:options?.source?.token?.secretRef});
        return url.endsWith('/marketplace.json')?{ok:false,status:{state:'invalid_source'}}:{ok:true,value:{name:'private'},fetchedAt:1};
      }},mutateSources:async mutation=>{stored=mutation;return {status:'updated',revision:1};}});
    const token={secretRef:'happier:shared-secret:v1:private-resource'};
    const result=await host.execute('registries.sources.create',{url:'https://github.com/a/private',token});
    expect(result).toMatchObject({source:{token},existing:false});
    expect(stored).toMatchObject({kind:'create',source:{token}});
    expect(calls.every(call=>call.ref===token.secretRef)).toBe(true);
    const failed=createRegistryHostV1({host:'node',readSources:async()=>[],http:{getText:unused,getBytes:unused,getJson:async()=>({ok:false,status:{state:'auth_failed'}})},
      mutateSources:async()=>{throw new Error('Failed authentication must not store a source');}});
    await expect(failed.execute('registries.sources.create',{url:'https://github.com/a/private',token})).rejects.toThrow('needs_token');
  });
  it('binds and clears credentials only on user sources through the Account mutation owner',async()=>{
    let sources:RegistrySourceDescriptorV1[]=[source('private')];
    const unavailable=async()=>{throw new Error('token binding must not disclose a value or fetch');};
    const host=createRegistryHostV1({host:'node',http:{getJson:unavailable,getText:unavailable,getBytes:unavailable},readSources:async()=>sources,
      mutateSources:async mutation=>{
        expect(mutation).toMatchObject({kind:'setToken',sourceId:'private'});
        if(mutation.kind!=='setToken')throw new Error('wrong owner mutation');
        const {token:_token,npmRegistryProfileId:_profile,...current}=sources[0]!;
        sources=[{...current,...(mutation.token?{token:mutation.token}:{}),...(mutation.npmRegistryProfileId?{npmRegistryProfileId:mutation.npmRegistryProfileId}:{})}];
        return {status:'updated',revision:1};
      }});
    const token={secretRef:'happier:shared-secret:v1:private-resource'};
    expect(await host.execute('registries.sources.token.set',{sourceId:'private',token})).toMatchObject({source:{token}});
    expect(await host.execute('registries.sources.token.set',{sourceId:'private',token:null})).toMatchObject({source:{id:'private'}});
    expect(sources[0]!.token).toBeUndefined();
    await expect(host.execute('registries.sources.token.set',{sourceId:'private',npmRegistryProfileId:'npm-private'})).rejects.toThrow('invalid_source_profile');
  });
  it('returns create and update receipts when cancellation retires the Account after the write ACK',async()=>{
    for(const action of ['create','update'] as const){
      const controller=new AbortController();
      const source:RegistrySourceDescriptorV1={id:'saved',title:'Before',format:'git',kinds:['skill'],url:'https://github.com/a/b',enabled:true,addedAt:0,origin:{kind:'user'},removable:true};
      const forbidden=async()=>{throw new Error('unused transport');};
      const host=createRegistryHostV1({host:'node',signal:controller.signal,
        http:{getJson:async url=>url.includes('marketplace.json')?{ok:false,status:{state:'invalid_source'}}:{ok:true,fetchedAt:1,value:{name:'b'}},getText:forbidden,getBytes:forbidden},
        readSources:async()=>{controller.signal.throwIfAborted();return action==='update'?[source]:[];},
        mutateSources:async()=>{controller.abort();return {status:'updated',revision:5};}});
      const result=action==='create'?await host.execute('registries.sources.create',{url:source.url,title:'Created'}):await host.execute('registries.sources.update',{sourceId:source.id,title:'After',enabled:false});
      expect(result).toMatchObject({source:{title:action==='create'?'Created':'After',enabled:action==='create'}});
    }
  });
});
