import {describe,expect,it} from 'vitest';
import {skillsShRegistryAdapterV1} from './skillsSh.js';
import type {RegistryHttpV1} from './registryFormatAdapterV1.js';
import type {RegistrySourceV1} from '../registrySourcesV1.js';
const source:RegistrySourceV1={id:'builtin:skills-sh',title:'skills.sh',url:'https://skills.sh',format:'skills-sh',kinds:['skill'],enabled:true,addedAt:0};
describe('skills.sh discovery',()=>{
  it('keeps returned catalog size, skips malformed entries individually, and deduplicates stable paths',async()=>{
    const entries=Array.from({length:130},(_,i)=>({source:'owner/repo',skillId:`skill-${i}`,name:`Skill ${i}`,installs:i}));
    const http:RegistryHttpV1={getJson:async()=>({ok:true,value:{skills:[...entries,entries[0],{source:'../x',skillId:'bad'}]},fetchedAt:1}),
      getText:async()=>({ok:true,value:'',fetchedAt:1}),getBytes:async()=>({ok:true,value:new Uint8Array(),fetchedAt:1})};
    const page=await skillsShRegistryAdapterV1.list({http},{source,kind:'skill',query:'x'});
    expect(page.items).toHaveLength(130);expect(page.items[0]).toMatchObject({itemId:'owner/repo/skill-0',installs:0});
  });
  it('names a skill\'s repository as its repository, never as its description',async()=>{
    const http:RegistryHttpV1={getJson:async()=>({ok:true,value:{skills:[{source:'vercel-labs/skills',skillId:'find-skills',name:'find-skills'}]},fetchedAt:1}),
      getText:async()=>({ok:true,value:'',fetchedAt:1}),getBytes:async()=>({ok:true,value:new Uint8Array(),fetchedAt:1})};
    const [item]=(await skillsShRegistryAdapterV1.list({http},{source,kind:'skill',query:'find'})).items;
    expect(item?.description).toBeUndefined();
    expect(item?.links?.repository).toBe('https://github.com/vercel-labs/skills');
  });
  it('uses a sitemap when the featured document has no skill links and keeps source failures typed',async()=>{
    const http:RegistryHttpV1={getJson:async()=>({ok:false,status:{state:'auth_failed'}}),getBytes:async()=>({ok:true,value:new Uint8Array(),fetchedAt:1}),
      getText:async(url)=>({ok:true,fetchedAt:1,value:url.endsWith('sitemap.xml')?'<loc>https://skills.sh/owner/repo/review</loc>':''})};
    expect((await skillsShRegistryAdapterV1.list({http},{source,kind:'skill'})).items[0]?.itemId).toBe('owner/repo/review');
    expect((await skillsShRegistryAdapterV1.list({http},{source,kind:'skill',query:'review'})).status).toEqual({state:'auth_failed'});
  });
});
