import {describe,expect,it} from 'vitest';
import {claudeMarketplaceRegistryAdapterV1} from './claudeMarketplace.js';
import type {RegistryHttpV1} from './registryFormatAdapterV1.js';
import type {RegistrySourceV1} from '../registrySourcesV1.js';
import { RegistryItemV1Schema } from '../registryItemsV1.js';
import { RegistryListPageV1Schema } from '../registryListV1.js';
const source:RegistrySourceV1={id:'market',title:'Market',url:'https://github.com/owner/market',format:'claude-marketplace',kinds:['skill'],enabled:true,addedAt:0};

it('lists vendor plugins and resolves an install pointer from the current catalog', async () => {
  const vendor = { ...source, kinds: ['plugin' as const], url: 'https://raw.githubusercontent.com/owner/market/main/collection/.agents/plugins/marketplace.json' };
  const suggestion = { id: 'review', title: 'Review changes', definition: {
    version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'step', id: 'review', document: { text: 'Review changes', references: [], attachments: [] } }],
  } };
  let repository = 'owner/initial';
  const requested: string[] = [];
  const http: RegistryHttpV1 = {
    getJson: async (url) => {
      requested.push(url);
      return { ok: true, fetchedAt: 1, value: { plugins: [
        { name: 'relative', source: { source: 'local', path: './plugins/relative' }, category: 'Developer Tools',
          author: { name: 'Example Labs' }, skills: ['./skills/review'], commands: ['./commands/review.md'],
          agents: ['./agents/reviewer.md'], mcpServers: { review: {} }, hooks: { PostToolUse: [] },
          extensions: { 'dev.happier': { suggestedAutomations: [suggestion, { id: 'invalid' }],
            notImported: { agents: 1, other: ['lspServers'] } } } },
        { name: 'url', source: { source: 'url', url: 'https://github.com/owner/url.git', sha: 'a'.repeat(40) } },
        { name: 'subdir', source: { source: 'git-subdir', url: repository, path: 'tools/subdir', ref: 'stale' } },
        { name: 'github', source: { source: 'github', repo: 'owner/github', ref: 'refs/heads/next' } },
      ] } };
    },
    getText: async () => ({ ok: false, status: { state: 'invalid_source' } }),
    getBytes: async () => ({ ok: false, status: { state: 'invalid_source' } }),
  };
  const page = RegistryListPageV1Schema.parse(await claudeMarketplaceRegistryAdapterV1.list({ http }, { source: vendor, kind: 'plugin' }));
  const vendorFacts = {
    categories: ['Developer Tools'],
    contentCounts: { skills: 1, commands: 1, agents: 1, mcpServers: 1 },
    notImported: { hooks: 1, agents: 1, other: ['lspServers'] },
    suggestedAutomations: [suggestion],
  };
  expect(page.items).toMatchObject([
    { itemId: 'relative', publisher: { name: 'Example Labs' }, vendorPlugin: vendorFacts },
    { itemId: 'url' }, { itemId: 'subdir' }, { itemId: 'github' },
  ]);
  expect(page.items[0]?.vendorPlugin?.suggestedAutomations).toHaveLength(1);
  expect(page.items[1]).not.toHaveProperty('vendorPlugin');
  expect(requested).toEqual([vendor.url]);
  repository = 'owner/current';
  for (const [itemId, locator, subdirectory, ref] of [
    ['relative', 'https://github.com/owner/market', 'collection/plugins/relative', 'main'],
    ['url', 'https://github.com/owner/url', undefined, 'a'.repeat(40)],
    ['subdir', 'https://github.com/owner/current', 'tools/subdir', 'stale'],
    ['github', 'https://github.com/owner/github', undefined, 'refs/heads/next'],
  ] as const) {
    const item = RegistryItemV1Schema.parse(await claudeMarketplaceRegistryAdapterV1.read({ http }, { source: vendor, kind: 'plugin', itemId }));
    if (itemId === 'relative') expect(item.summary).toMatchObject({ vendorPlugin: vendorFacts });
    expect(item.payload).toEqual({ kind: 'plugin', catalog: { sourceId: vendor.id, itemId }, git: { locator, ref, ...(subdirectory ? { subdirectory } : {}) } });
  }
  expect(requested).toEqual(Array(5).fill(vendor.url));
});
describe('Claude marketplace skills',()=>{
  it('resolves relative plugin paths from a raw marketplace URL and reads omitted kinds from its pinned plugin manifest',async()=>{
    const rawSource={...source,url:'https://raw.githubusercontent.com/owner/market/main/.claude-plugin/marketplace.json'};
    const commit='3'.repeat(40);const requested:string[]=[];
    const http:RegistryHttpV1={getJson:async url=>{requested.push(url);return {ok:true,fetchedAt:1,value:url.endsWith('/marketplace.json')?{plugins:[{name:'review',source:'./plugins/review'}]}:
      url.endsWith('/plugin.json')?{commands:['commands/review.md'],agents:['agents/reviewer.md'],mcpServers:{server:{}},hooks:[{}]}:
      url.includes('/commits/')?{sha:commit}:{sha:'tree',tree:[{path:'plugins/review/skills/review',mode:'040000',type:'tree',sha:'skill-tree'},
        {path:'plugins/review/skills/review/SKILL.md',mode:'100644',type:'blob',sha:'blob',size:1}]}};},getText:async()=>({ok:true,fetchedAt:1,value:'---\nname: review\n---\n'}),getBytes:async()=>({ok:true,fetchedAt:1,value:new Uint8Array()})};
    expect((await claudeMarketplaceRegistryAdapterV1.list({http},{source:rawSource,kind:'skill'})).items).toMatchObject([{itemId:'review/skills/review'}]);
    const item=await claudeMarketplaceRegistryAdapterV1.read({http},{source:rawSource,kind:'skill',itemId:'review/skills/review',version:commit});
    expect(item.payload.skill.notImported).toEqual({hooks:1,commands:1,mcpServers:1,agents:1});
    expect(requested).toContain(`https://raw.githubusercontent.com/owner/market/${commit}/plugins/review/.claude-plugin/plugin.json`);
  });
  it('reads relative and GitHub plugins through the real GitHub adapter and counts omitted plugin kinds',async()=>{
    const commit='1'.repeat(40);
    const http:RegistryHttpV1={getJson:async(url)=>url.endsWith('plugin.json')?{ok:false,status:{state:'invalid_source'}}:({ok:true,fetchedAt:1,value:url.endsWith('marketplace.json')?{plugins:[
      {name:'relative',source:'./plugins/review',hooks:[{},{}],commands:['command'],mcpServers:{server:{}},agents:[]},
      {name:'remote',source:{source:'github',repo:'owner/remote'}},{name:'other',source:{source:'git',repo:'https://git.example/repo'}},
    ]}:url.includes('/commits/')?{sha:commit}:{sha:'tree',tree:[
      {path:'plugins/review/skills/review',mode:'040000',type:'tree',sha:'skill-tree'},
      {path:'plugins/review/skills/review/SKILL.md',mode:'100644',type:'blob',sha:'blob',size:1},
      {path:'skills/review',mode:'040000',type:'tree',sha:'skill-tree'},{path:'skills/review/SKILL.md',mode:'100644',type:'blob',sha:'blob',size:1},
    ]}}),getText:async()=>({ok:true,fetchedAt:1,value:'---\nname: review\ndescription: Review code\n---\n'}),getBytes:async()=>({ok:true,fetchedAt:1,value:new Uint8Array()})};
    const page=await claudeMarketplaceRegistryAdapterV1.list({http},{source,kind:'skill'});
    expect(page.items).toEqual(expect.arrayContaining([expect.objectContaining({itemId:'relative/skills/review'}),expect.objectContaining({itemId:'other/',problem:{code:'unsupported_entry',reason:'distribution'}})]));
    const item=await claudeMarketplaceRegistryAdapterV1.read({http},{source,kind:'skill',itemId:'relative/skills/review',version:commit});
    expect(item.payload.skill.notImported).toEqual({hooks:2,commands:1,mcpServers:1,agents:0});
    expect(item.summary).toMatchObject({title:'review',description:'Review code',version:commit});
  });
});
