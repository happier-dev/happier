import { z } from '../../zodRuntimePolicy.js';
import { githubRegistryAdapterV1, readGitHubRepositoryV1, registryRelativePathV1 } from './github.js';
import type { RegistryFetchContextV1, RegistrySkillFormatAdapterV1 } from './registryFormatAdapterV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistryContentRefV1, RegistryRemoteProvenanceV1 } from '../registryItemsV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
const pluginSchema=z.object({name:z.string().check(z.minLength(1)),source:z.union([z.string(),z.object({source:z.string(),repo:z.optional(z.string()),path:z.optional(z.string()),ref:z.optional(z.string())})]),
  hooks:z.optional(z.unknown()),commands:z.optional(z.unknown()),mcpServers:z.optional(z.unknown()),agents:z.optional(z.unknown())});
async function plugins(ctx:RegistryFetchContextV1,source:RegistrySourceV1) {
  const raw=/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*?)\.claude-plugin\/marketplace\.json$/.exec(source.url);
  const github=readGitHubRepositoryV1(source.url);
  const repo=raw?{owner:raw[1]!,repo:raw[2]!,url:`https://github.com/${raw[1]}/${raw[2]}`,ref:raw[3]!,path:raw[4]!.replace(/\/$/,'')}:github;
  const path=source.path??repo?.path?.replace(/(?:^|\/)\.claude-plugin\/marketplace\.json$/,'')??'';
  const catalogSource={...source,path,ref:source.ref??repo?.ref};
  const url=repo ? `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${catalogSource.ref ?? 'HEAD'}/${path ? registryRelativePathV1(path)+'/' : ''}.claude-plugin/marketplace.json` : source.url;
  const result=await ctx.http.getJson(url,{source});
  if (!result.ok) throw new RegistryFetchErrorV1(result.status);
  const parsedBody=z.object({plugins:z.array(z.unknown())}).safeParse(result.value);
  if(!parsedBody.success)throw new RegistryFetchErrorV1({state:'invalid_source'});
  const body=parsedBody.data;
  const declaredNames=new Set(body.plugins.flatMap(raw=>raw&&typeof raw==='object'&&'name' in raw&&typeof raw.name==='string'?[raw.name]:[]));
  return {fetchedAt:result.fetchedAt,repo,source:catalogSource,declaredNames,items:body.plugins.flatMap(raw=>{const parsed=pluginSchema.safeParse(raw);return parsed.success?[parsed.data]:[];})};
}
function pluginSource(source:RegistrySourceV1,plugin:z.infer<typeof pluginSchema>,repo:ReturnType<typeof readGitHubRepositoryV1>):RegistrySourceV1|null {
  if (typeof plugin.source === 'string' && plugin.source.startsWith('./') && repo) {
    return {...source,format:'git',url:repo.url,path:registryRelativePathV1([source.path,plugin.source.slice(2)].filter(Boolean).join('/'))};
  }
  if (typeof plugin.source === 'object' && plugin.source.source === 'github' && /^[\w.-]+\/[\w.-]+$/.test(plugin.source.repo ?? '')) {
    return {...source,format:'git',url:`https://github.com/${plugin.source.repo}`,path:plugin.source.path,ref:plugin.source.ref};
  }
  return null;
}
function count(value:unknown):number {return Array.isArray(value)?value.length : value && typeof value === 'object'?Object.keys(value).length : value ? 1 : 0;}
export function createClaudeMarketplaceRegistryAdapterV1(github: RegistrySkillFormatAdapterV1): RegistrySkillFormatAdapterV1 {
return {
  format:'claude-marketplace',kinds:['skill'],supportsQuery:true,browserFetchable:source=>readGitHubRepositoryV1(source.url)!==null || /^https:\/\//.test(source.url),
  async list(ctx,req) {
    const catalog=await plugins(ctx,req.source);
    const items=[];
    for(const plugin of catalog.items) {
      const source=pluginSource(catalog.source,plugin,catalog.repo);
      if (!source) {items.push({sourceId:req.source.id,kind:'skill' as const,itemId:plugin.name+'/',title:plugin.name,problem:{code:'unsupported_entry' as const,reason:'distribution' as const}});continue;}
      const page=await github.list(ctx,{source,kind:'skill',query:req.query});
      if(page.status.state !== 'ok') return {...page,sourceId:req.source.id};
      items.push(...page.items.map(item=>({...item,itemId:`${plugin.name}/${item.itemId}`})));
    }
    return {sourceId:req.source.id,status:{state:'ok' as const,fetchedAt:catalog.fetchedAt},items,nextCursor:null};
  },
  async read(ctx,req) {
    const catalog=await plugins(ctx,req.source);
    const slash=req.itemId.indexOf('/');
    const plugin=catalog.items.find(item=>item.name === req.itemId.slice(0,slash));
    const source=plugin && pluginSource(catalog.source,plugin,catalog.repo);
    if(!plugin || !source) throw new RegistryFetchErrorV1({state:'invalid_source'});
    const item=await github.read(ctx,{source,kind:'skill',itemId:req.itemId.slice(slash+1),version:req.version});
    if (item.payload.skill.ref.kind !== 'gitTree') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const repo=readGitHubRepositoryV1(source.url)!;
    const manifest=await ctx.http.getJson(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${item.payload.skill.ref.commit}/${source.path?source.path+'/':''}.claude-plugin/plugin.json`,{source});
    if(!manifest.ok&&manifest.status.state!=='invalid_source')throw new RegistryFetchErrorV1(manifest.status);
    const metadata=manifest.ok&&manifest.value&&typeof manifest.value==='object'&&!Array.isArray(manifest.value)?manifest.value as Record<string,unknown>:{};
    return {...item,summary:{...item.summary,itemId:req.itemId},payload:{kind:'skill' as const,skill:{...item.payload.skill,
      notImported:{hooks:count(metadata.hooks??plugin.hooks),commands:count(metadata.commands??plugin.commands),mcpServers:count(metadata.mcpServers??plugin.mcpServers),agents:count(metadata.agents??plugin.agents)}}}};
  },
  async latest(ctx,items,options){
    const result=new Map<string,RegistryContentRefV1|'removed'>();
    if(!items.length)return result;
    const source:RegistrySourceV1=options?.source??{id:items[0]!.sourceId,title:items[0]!.sourceUrl,format:'claude-marketplace',kinds:['skill'],url:items[0]!.sourceUrl,enabled:true,addedAt:0};
    const catalog=await plugins(ctx,source);
    const groups=new Map<string,{source:RegistrySourceV1;items:{original:string;provenance:RegistryRemoteProvenanceV1}[]}>();
    for(const item of items){
      const slash=item.itemId.indexOf('/'),name=item.itemId.slice(0,slash);
      if(slash<1)throw new RegistryFetchErrorV1({state:'invalid_source'});
      const plugin=catalog.items.find(plugin=>plugin.name===name);
      if(!plugin){
        if(catalog.declaredNames.has(name))throw new RegistryFetchErrorV1({state:'invalid_source'});
        result.set(item.itemId,'removed');continue;
      }
      const target=pluginSource(catalog.source,plugin,catalog.repo);
      if(!target||item.ref.kind!=='gitTree')throw new RegistryFetchErrorV1({state:'invalid_source'});
      const key=JSON.stringify([target.url,target.ref??'']);
      const group=groups.get(key)??{source:{...target,path:''},items:[]};
      const path=registryRelativePathV1([target.path,item.itemId.slice(slash+1)].filter(Boolean).join('/'));
      group.items.push({original:item.itemId,provenance:{...item,sourceUrl:target.url,itemId:path}});groups.set(key,group);
    }
    // The resolved plugin may be hosted elsewhere; its URL never becomes the
    // authority for the catalog's credential receiver.
    const scoped:RegistryFetchContextV1={...ctx,http:{
      getJson:url=>ctx.http.getJson(url,{source}),getText:url=>ctx.http.getText(url,{source}),getBytes:url=>ctx.http.getBytes(url,{source}),
    }};
    for(const group of groups.values()){
      const latest=await github.latest(scoped,group.items.map(item=>item.provenance),{source:group.source});
      for(const item of group.items){const ref=latest.get(item.provenance.itemId);if(ref!==undefined)result.set(item.original,ref);}
    }
    return result;
  },
};
}
export const claudeMarketplaceRegistryAdapterV1 = createClaudeMarketplaceRegistryAdapterV1(githubRegistryAdapterV1);
