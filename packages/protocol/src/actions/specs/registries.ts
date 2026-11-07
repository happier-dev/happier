import { REGISTRY_INPUT_FIELDS } from './registryInputHints.js';
import { z } from 'zod/mini';
import { readRecord } from '../../inputs/inputRecords.js';
import { REGISTRY_ACTION_INPUT_SCHEMAS_V1 as inputs,REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 as outputs,type RegistryActionIdV1 } from '../../registries/registryActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '../../registries/registrySourcesV1.js';

/** CLI shorthand resolves through the existing built-in source declarations. */
function registrySourceCliId(sourceId: string): string {
  return BUILT_IN_REGISTRY_SOURCES_V1.find(source => source.id === `builtin:${sourceId}`)?.id ?? sourceId;
}
export function readRegistryAgentCliLocatorV1(locator: string): Readonly<{ sourceId: string; itemId: string }> {
  const separator = locator.lastIndexOf('/');
  if (separator < 1 || separator === locator.length - 1) throw new Error('Supply a registry item as <source>/<item>.');
  return { sourceId: registrySourceCliId(locator.slice(0, separator)), itemId: locator.slice(separator + 1) };
}
function registrySpec<TId extends RegistryActionIdV1>(id:TId,title:string,options:Readonly<{danger?:boolean;confirm?:boolean;write?:boolean;direct?:boolean}>={}):
  PreNormalizedActionSpec & Readonly<{id:TId;inputSchema:(typeof inputs)[TId];outputSchema:(typeof outputs)[TId]}> {
  const observation=(raw:unknown)=>{const value=readRecord(raw);return Object.fromEntries(
    ['sourceId','kind','existing','removed'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));};
  return {id,title,safety:options.danger?'danger':'safe',approval:{result:options.danger?'required':'none'},
    approvalPolicy:options.confirm?{uiConfirmation:'policy'}:options.direct?{uiConfirmation:'direct'}:{},sideEffectClass:options.write?'write':'read',
    requiredAuthority:'account_automation',executionPlacement:'account',placements:[],
    // Account-owned registries also execute on the captured Account's daemon.
    originalExecution:{accountRoot:'allowed'},
    surfaces:{ui:true,cli:true,agent:true,mcp:true,voice:false,rpc:true},bindings:{rpcMethod:id,mcpToolName:id.replaceAll('.','_')},
    inputSchema:inputs[id],outputSchema:outputs[id],inputHints:{fields:REGISTRY_INPUT_FIELDS[id]},projectObservationInput:observation,projectObservationOutput:observation,
    approvalPresentation:{summary:()=>null,projectInput:raw=>inputs[id].parse(raw),retainInputOnSettlement:true},
    cli:{acceptsServerId:true,commands:[{path:id.split('.'),visibility:'canonical'}]},
  };
}
export const REGISTRY_ACTION_SPECS_V1=[
  {...registrySpec('registries.updates.check','Check registry updates',{write:true}),cli:{acceptsServerId:true,
    inputSchema:inputs['registries.updates.check'],
    bindInput:(raw:unknown,ctx)=>{const value=readRecord(raw);const kind=ctx.commandPath?.[0]==='skills'?'skill':ctx.commandPath?.[0]==='mcp'?'mcpServer':ctx.commandPath?.[0]==='agents'?'agent':undefined;
      return kind?{...value,kind}:value;},commands:[
    {path:['registries','updates','check'],variadicPositional:'keys',visibility:'canonical' as const},
    {path:['skills','updates','check'],variadicPositional:'keys',visibility:'alias' as const},
    {path:['mcp','servers','updates','check'],variadicPositional:'keys',visibility:'alias' as const},
    {path:['agents','updates','check'],variadicPositional:'keys',visibility:'alias' as const}]}},
  {...registrySpec('registries.sources.list','List registry sources'),
    inputHints:{fields:REGISTRY_INPUT_FIELDS['registries.sources.list'],
      description:'List Store registry sources for browsing the app catalog, including Dokploy and Coolify, and catalogs of skills, MCP servers, agents and plugins. Filter by kind app to find app sources; use their source ids to list Store items.'},
    cli:{acceptsServerId:true,
    inputSchema:inputs['registries.sources.list'],
    bindInput:(raw:unknown,ctx)=>{const value=readRecord(raw);return ctx.commandPath?.[0]==='plugins'?{...value,kind:value.kind??'plugin'}:value;},
    commands:[
    {path:['registries','sources','list'],visibility:'canonical' as const},{path:['registries','list'],visibility:'alias' as const},
    {path:['plugins','marketplace','sources','list'],visibility:'alias' as const}]}},
  {...registrySpec('registries.sources.detect','Detect registry source'),cli:{acceptsServerId:true,commands:[
    {path:['registries','sources','detect'],positionals:['url'],visibility:'canonical' as const},{path:['registries','detect'],positionals:['url'],visibility:'alias' as const}]}},
  {...registrySpec('registries.sources.create','Add registry source',{danger:true,write:true,direct:true}),cli:{acceptsServerId:true,
    inputSchema:z.extend(inputs['registries.sources.create'], {tokenSecret:z.optional(z.string().check(z.minLength(1))),npmProfile:z.optional(z.string().check(z.minLength(1)))})
      .check(z.refine(value=>!(value.tokenSecret!==undefined && value.token!==undefined), {message:'Provide one token source.'}),
        z.refine(value=>!(value.npmProfile!==undefined && value.npmRegistryProfileId!==undefined), {message:'Provide one npm profile source.'})),
    bindInput:(raw:unknown,ctx)=>{const value=readRecord(raw);return ctx.commandPath?.[0]==='plugins'?{...value,kinds:value.kinds??['plugin']}:value;},commands:[
    {path:['registries','sources','create'],positionals:['url'],visibility:'canonical' as const},{path:['registries','add'],positionals:['url'],visibility:'alias' as const},
    {path:['plugins','marketplace','sources','add'],positionals:['url'],visibility:'alias' as const}]}},
  {...registrySpec('registries.sources.update','Change registry source',{danger:true,write:true,direct:true}),cli:{acceptsServerId:true,
    inputSchema:z.strictObject({sourceId:z.string().check(z.minLength(1)),title:z.optional(z.string().check(z.minLength(1))),enabled:z.optional(z.boolean())}),
    bindInput:(raw:unknown,ctx)=>{const value=readRecord(raw);const command=ctx.commandPath?.at(-1);return {...value,...(command==='enable'?{enabled:true}:command==='disable'?{enabled:false}:{})};},
    commands:[{path:['registries','sources','update'],visibility:'canonical' as const},
      {path:['registries','rename'],positionals:['sourceId','title'],visibility:'alias' as const},
      {path:['registries','enable'],positionals:['sourceId'],visibility:'alias' as const},{path:['registries','disable'],positionals:['sourceId'],visibility:'alias' as const},
      {path:['plugins','marketplace','sources','enable'],positionals:['sourceId'],visibility:'alias' as const},
      {path:['plugins','marketplace','sources','disable'],positionals:['sourceId'],visibility:'alias' as const}]}},
  {...registrySpec('registries.sources.token.set','Set registry credentials',{danger:true,write:true,direct:true}),cli:{acceptsServerId:true,
    inputSchema:z.extend(inputs['registries.sources.token.set'], {secret:z.optional(z.string().check(z.minLength(1))),clear:z.optional(z.boolean()),
      npmProfile:z.optional(z.string().check(z.minLength(1))),clearNpmProfile:z.optional(z.boolean())})
      .check(z.refine(value=>[value.token!==undefined,value.secret!==undefined,value.clear===true].filter(Boolean).length<=1, {message:'Provide one token change.'}),
        z.refine(value=>[value.npmRegistryProfileId!==undefined,value.npmProfile!==undefined,value.clearNpmProfile===true].filter(Boolean).length<=1, {message:'Provide one npm profile change.'}),
        z.refine(value=>value.token!==undefined || value.secret!==undefined || value.clear===true || value.npmRegistryProfileId!==undefined
          || value.npmProfile!==undefined || value.clearNpmProfile===true, {message:'Provide a token or npm profile change.'})),commands:[
    {path:['registries','sources','token','set'],positionals:['sourceId'],visibility:'canonical' as const},
    {path:['registries','token'],positionals:['sourceId'],visibility:'alias' as const}]}},
  {...registrySpec('registries.sources.delete','Remove registry source',{danger:true,confirm:true,write:true}),cli:{acceptsServerId:true,commands:[
    {path:['registries','sources','delete'],positionals:['sourceId'],visibility:'canonical' as const},{path:['registries','remove'],positionals:['sourceId'],visibility:'alias' as const},
    {path:['plugins','marketplace','sources','remove'],positionals:['sourceId'],visibility:'alias' as const}]}},
  {...registrySpec('registries.items.list','Browse registry items'),
    inputHints:{fields:REGISTRY_INPUT_FIELDS['registries.items.list'],
      description:'List and search Store registry items in the app catalog, including Dokploy and Coolify apps available to install, or browse skills, MCP servers, agents and plugins. For apps use kind app and sourceIds from registries.sources.list; read an item with registries.items.read before preparing an install.'},
    cli:{acceptsServerId:true,
    inputSchema:z.extend(inputs['registries.items.list'], {kind:z.optional(inputs['registries.items.list'].shape.kind)}),
    bindInput:(raw:unknown,ctx)=>{const value=readRecord(raw);return ctx.commandPath?.[0]==='plugins'?{...value,kind:value.kind??'plugin'}:ctx.commandPath?.[0]==='agents'?{...value,kind:'agent',
      ...(Array.isArray(value.sourceIds)?{sourceIds:value.sourceIds.map(id=>registrySourceCliId(String(id)))}:{})}:value;},
    flagAliases:[{path:'sourceIds',aliases:['--source']}],commands:[
    {path:['registries','items','list'],visibility:'canonical' as const},{path:['registries','search'],positionals:['query'],visibility:'alias' as const},{path:['registries','browse'],visibility:'alias' as const},
    {path:['plugins','marketplace','list'],visibility:'alias' as const},
    {path:['agents','browse'],positionals:['query'],visibility:'alias' as const}]}},
  {...registrySpec('registries.items.read','Read registry item'),
    inputHints:{fields:REGISTRY_INPUT_FIELDS['registries.items.read'],
      description:'Read a Store registry item listing from the app catalog, including Dokploy and Coolify app details, requirements and install inputs, or inspect a skill, MCP server, agent or plugin. Use kind app and the sourceId and itemId returned when you list Store items; this reads details without installing.'},
    cli:{acceptsServerId:true,
    inputSchema:z.extend(inputs['registries.items.read'], {kind:z.optional(inputs['registries.items.read'].shape.kind),
      sourceId:z.optional(z.string().check(z.minLength(1))),itemId:z.optional(z.string()),registryItem:z.optional(z.string().check(z.minLength(1)))}),
    bindInput:(raw:unknown,ctx)=>{const {registryItem,...value}=readRecord(raw);
      if(ctx.commandPath?.[0]==='agents') {
        return {...value,kind:'agent',...readRegistryAgentCliLocatorV1(typeof registryItem==='string'?registryItem:'')};
      }
      return ctx.commandPath?.[0]==='plugins'?{...value,kind:value.kind??'plugin'}:value;},commands:[
    {path:['registries','items','read'],visibility:'canonical' as const},{path:['registries','show'],positionals:['sourceId','itemId'],visibility:'alias' as const},
    {path:['plugins','marketplace','show'],positionals:['sourceId','itemId'],visibility:'alias' as const},
    {path:['agents','show'],positionals:['registryItem'],visibility:'alias' as const}]}},
] as const satisfies readonly PreNormalizedActionSpec[];
