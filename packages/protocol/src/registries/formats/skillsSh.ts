import { z } from '../../zodRuntimePolicy.js';
import { githubRegistryAdapterV1 } from './github.js';
import type { RegistrySkillFormatAdapterV1 } from './registryFormatAdapterV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import { readWellKnownSkillUpdatesV1 } from './wellKnownSkills.js';
const safeSegments=(value:string)=>value.split('/').every(segment=>segment!=='.'&&segment!=='..');
const catalogRef = z.object({source:z.string().check(z.regex(/^[\w.-]+\/[\w.-]+$/), z.refine(safeSegments)),skillId:z.string().check(z.regex(/^[\w.-]+(?:\/[\w.-]+)*$/), z.refine(safeSegments)),
  name:z.optional(z.string()),installs:z.optional(z.number().check(z.nonnegative()))});
export const skillsShRegistryAdapterV1: RegistrySkillFormatAdapterV1 = {
  format:'skills-sh',kinds:['skill'],supportsQuery:true,browserFetchable:()=>false,
  async list(ctx,req) {
    const base = req.source.url.replace(/\/$/,'');
    let entries: z.infer<typeof catalogRef>[] = [];
    let fetchedAt:number;
    if (req.query?.trim()) {
      const result=await ctx.http.getJson(`${base}/api/search?q=${encodeURIComponent(req.query.trim())}`,{source:req.source});
      if (!result.ok) return {sourceId:req.source.id,status:result.status,items:[],nextCursor:null};
      fetchedAt=result.fetchedAt;
      const body=z.object({skills:z.array(z.unknown())}).parse(result.value);
      entries=body.skills.flatMap(raw=>{const parsed=catalogRef.safeParse(raw);return parsed.success?[parsed.data]:[];});
    } else {
      const result=await ctx.http.getText(base,{source:req.source});
      if (!result.ok) return {sourceId:req.source.id,status:result.status,items:[],nextCursor:null};
      fetchedAt=result.fetchedAt;
      entries=[...result.value.matchAll(/href="\/([^/"?#]+)\/([^/"?#]+)\/([^/"?#]+)"/g)]
        .flatMap(match=>{const parsed=catalogRef.safeParse({source:`${match[1]}/${match[2]}`,skillId:match[3]});return parsed.success?[parsed.data]:[];});
      if (!entries.length) {
        const sitemap=await ctx.http.getText(`${base}/sitemap.xml`,{source:req.source});
        if (!sitemap.ok) return {sourceId:req.source.id,status:sitemap.status,items:[],nextCursor:null};
        entries=[...sitemap.value.matchAll(/<loc>https:\/\/skills\.sh\/([^/<]+)\/([^/<]+)\/([^/<]+)<\/loc>/g)]
          .flatMap(match=>{const parsed=catalogRef.safeParse({source:`${match[1]}/${match[2]}`,skillId:match[3]});return parsed.success?[parsed.data]:[];});
      }
    }
    const unique=new Map(entries.map(entry=>[`${entry.source}/${entry.skillId}`,entry]));
    return {sourceId:req.source.id,status:{state:'ok',fetchedAt},nextCursor:null,items:[...unique].map(([itemId,entry])=>({
      sourceId:req.source.id,kind:'skill' as const,itemId,title:entry.name ?? entry.skillId,
      ...(entry.installs !== undefined ? {installs:entry.installs}:{}),links:{repository:`https://github.com/${entry.source}`,website:`${base}/${itemId}`},
    }))};
  },
  async read(ctx,req) {
    const [owner,repo,...parts]=req.itemId.split('/');
    const parsed=catalogRef.safeParse({source:`${owner}/${repo}`,skillId:parts.join('/')});
    if (!parsed.success) throw new RegistryFetchErrorV1({state:'invalid_source'});
    const source:RegistrySourceV1={...req.source,format:'git',url:`https://github.com/${parsed.data.source}`,ref:req.version??req.source.ref};
    const list=await githubRegistryAdapterV1.list(ctx,{source,kind:'skill'});
    if (list.status.state !== 'ok') throw new RegistryFetchErrorV1(list.status);
    const path=list.items.find(item=>item.itemId === parsed.data.skillId || item.itemId.endsWith('/'+parsed.data.skillId))?.itemId;
    if (path === undefined) throw new RegistryFetchErrorV1({state:'invalid_source'});
    const item=await githubRegistryAdapterV1.read(ctx,{source,kind:'skill',itemId:path,version:req.version ?? list.items[0]?.version});
    return {...item,summary:{...item.summary,itemId:req.itemId}};
  },
  async latest(ctx,items,options) {
    const wellKnown = items.filter(item => item.ref.kind === 'wellKnown');
    const git = items.filter(item => item.ref.kind !== 'wellKnown');
    const current = await readWellKnownSkillUpdatesV1(ctx, wellKnown);
    const other = git.length ? await githubRegistryAdapterV1.latest(ctx,git.map(item=>({...item,sourceUrl:item.ref.kind === 'gitTree' ? item.ref.repo : item.sourceUrl})),options) : [];
    return new Map([...current, ...other]);
  },
};
