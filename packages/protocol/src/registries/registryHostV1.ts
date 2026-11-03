import { selectRegistryBotTemplateUpdatePointerV1 } from './registryBotTemplateUpdatePointerV1.js';
import type { ResolvedBotTemplateReleaseV1 } from '../bots/templates/botTemplateV1.js';
import type { PluginBotTemplateContributionV1 } from '../plugins/contributions/botTemplates.js';
export type RegistryBotTemplateReaderV1 = (input: Readonly<{
  item: RegistryItemV1; source: RegistrySourceDescriptorV1; context: RegistryFetchContextV1;
  contributionId: string;
}>) => Promise<ResolvedBotTemplateReleaseV1>;
export type RegistryAvailableBotTemplateReaderV1 = (input: Readonly<{
  pointer: RegistryItemPointerV1; source: RegistrySourceDescriptorV1; contributionId: string;
  signal?: AbortSignal; item?: RegistryItemV1;
}>) => Promise<ResolvedBotTemplateReleaseV1 | null>;
import { decodeBase64,encodeBase64 } from '../crypto/base64.js';
import { REGISTRY_ACTION_INPUT_SCHEMAS_V1,REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,type RegistryActionIdV1 } from './registryActionsV1.js';
import { REGISTRY_FORMAT_ADAPTERS_V1 } from './formats/index.js';
import { githubRegistryAdapterV1,createGitHubRegistryOperationV1,readGitHubRepositoryV1,registryRelativePathV1 } from './formats/github.js';
import { createClaudeMarketplaceRegistryAdapterV1 } from './formats/claudeMarketplace.js';
import { couldReadWellKnownSkillsV1, readWellKnownSkillsV1 } from './formats/wellKnownSkills.js';
import { composeCatalogRegistryAdapterV1 } from './formats/composeCatalog.js';
import type { RegistryDetectedSourceV1,RegistryFetchContextV1,RegistryHttpV1,RegistryFormatAdapterV1 } from './formats/registryFormatAdapterV1.js';
import { HAPPIER_PICKS_SOURCE_ID,deriveRegistrySourceIdV1,normalizeRegistrySourceUrlV1,resolveLegacyRegistrySourceRefV1,type RegistrySourceV1,type RegistrySourceDescriptorV1,type RegistryRemoteSourceDescriptorV1 } from './registrySourcesV1.js';
import { RegistryFetchErrorV1 } from './registryListV1.js';
import { RegistryItemV1Schema,type RegistryItemPointerV1,type RegistrySkillSourceV1,type RegistryItemV1,type RegistrySkillItemV1,type RegistrySkillContentRefV1 } from './registryItemsV1.js';
import { deriveMarketplaceSourceId, normalizeMarketplaceSourceUrlV1 } from '../marketplace/marketplaceSourceRegistryV1.js';
import { resolveRegistryFetchPlanV1 } from './registryFetchPlanV1.js';
import { fetchRegistrySkillFilesV1,type RegistrySkillFileBytesV1 } from './registryGitTreeV1.js';
import { RegistryFetchRequestV1Schema,RegistryFetchResponseV1Schema,type RegistryFetchRequestV1,type RegistryFetchResponseV1 } from './registryRpcV1.js';
import type { RegistrySourcesMutationV1,RegistrySourcesMutationResultV1 } from './registrySourcesMutationV1.js';
import type { RegistryUpdateCheckResultV1 } from './registryUpdatesV1.js';
export type RegistryHostDepsV1=Readonly<{
  admitSource?:(source:RegistrySourceDescriptorV1)=>Promise<RegistryFetchContextV1>;
  host:'web'|'native'|'node';http:RegistryHttpV1;signal?:AbortSignal;git?:RegistryFetchContextV1['git'];
  withAppCatalog?:RegistryFetchContextV1['withAppCatalog'];
  readSources:()=>Promise<readonly RegistrySourceDescriptorV1[]>;
  updates?:(filter?:import('zod/mini').infer<typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.updates.check']>)=>Promise<RegistryUpdateCheckResultV1>;
  mutateSources?:(mutation:RegistrySourcesMutationV1)=>Promise<RegistrySourcesMutationResultV1>;
  daemonFetch?:(request:RegistryFetchRequestV1)=>Promise<RegistryFetchResponseV1>;
  readPluginBotTemplates?: RegistryBotTemplateReaderV1;
  /** Existing verified installed bytes may satisfy the exact pointer without an acquisition. */
  readAvailableBotTemplate?: RegistryAvailableBotTemplateReaderV1;
  /** Uses the existing Account-scoped template.preview Action carrier. */
  readBotTemplateOnDaemon?:(pointer:RegistryItemPointerV1,contributionId:string)=>Promise<ResolvedBotTemplateReleaseV1>;
  /** Delegates the same approved create Action; never sends credential material to the client. */
  createSourceOnDaemon?:(input:import('zod/mini').infer<typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.create']>)=>Promise<import('zod/mini').infer<typeof REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.create']>>;
}>;
/** Only rejected transport calls carry this mark; adapter/parser TypeErrors do not. */
class RegistryTransportFailureV1 extends Error {
  constructor(readonly original: TypeError) {
    super('Registry transport unavailable');
  }
}
function adapterFor(source:RegistrySourceV1):RegistryFormatAdapterV1 {
  const adapter=(REGISTRY_FORMAT_ADAPTERS_V1 as Partial<Record<RegistrySourceV1['format'],RegistryFormatAdapterV1>>)[source.format];
  if(!adapter) throw new RegistryFetchErrorV1({state:'newer_format',found:source.format});
  return adapter;
}
export async function detectRegistrySourceV1(ctx:RegistryFetchContextV1,url:string,kind?:'skill'):Promise<RegistryDetectedSourceV1> {
  const normalized=normalizeRegistrySourceUrlV1(url);
  const repo=readGitHubRepositoryV1(normalized);
  if(repo) {
    // An explicit skill file selects its folder; otherwise detect the format at
    // the selected folder/ref, which may differ from the repository root.
    if (!new URL(normalized).pathname.endsWith('/SKILL.md')) {
      const appCatalog = kind === 'skill' ? null : await composeCatalogRegistryAdapterV1.detect?.(ctx, normalized);
      if (appCatalog) return appCatalog;
      const path = registryRelativePathV1(repo.path ?? '').replace(/(?:^|\/)\.claude-plugin\/marketplace\.json$/, '');
      const marketplace=await ctx.http.getJson(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(repo.ref ?? 'HEAD')}/${path ? path.split('/').map(encodeURIComponent).join('/')+'/' : ''}.claude-plugin/marketplace.json`);
      if (!marketplace.ok && marketplace.status.state === 'rate_limited') throw new RegistryFetchErrorV1(marketplace.status);
      if(marketplace.ok && marketplace.value && typeof marketplace.value==='object' && 'plugins' in marketplace.value) return {format:'claude-marketplace',kinds:['skill'],title:repo.repo};
    }
    const response=await ctx.http.getJson(`https://api.github.com/repos/${repo.owner}/${repo.repo}`);
    if (!response.ok && response.status.state === 'rate_limited') throw new RegistryFetchErrorV1(response.status);
    if(!response.ok) return {unsupported:response.status.state==='auth_failed'?'needs_token':'unreachable'};
    return {format:'git',kinds:['skill'],title:repo.repo};
  }
  if(/^https:\/\/github\.com\/[^/?#]+\/?$/.test(normalized)) return {unsupported:'organisation'};
  if(normalized.endsWith('/marketplace.json')) {
    const response=await ctx.http.getJson(normalized);
    if (!response.ok && response.status.state === 'rate_limited') throw new RegistryFetchErrorV1(response.status);
    return response.ok?{format:'claude-marketplace',kinds:['skill'],title:new URL(normalized).hostname}:{unsupported:response.status.state==='auth_failed'?'needs_token':'unreachable'};
  }
  if(new URL(normalized).hostname==='skills.sh') return {format:'skills-sh',kinds:['skill'],title:'skills.sh'};
  if(normalized.endsWith('.git')) return {format:'git',kinds:['skill'],title:new URL(normalized).pathname.split('/').at(-1)!.replace(/\.git$/,'')};
  const detectionAdapters: readonly RegistryFormatAdapterV1[] = Object.values(REGISTRY_FORMAT_ADAPTERS_V1);
  for (const adapter of detectionAdapters) {
    if (!adapter.detect || kind && !adapter.kinds.includes(kind)) continue;
    const detected = await adapter.detect(ctx, normalized);
    if (detected && (!kind || 'unsupported' in detected || detected.kinds.includes(kind))) return detected;
  }
  return {unsupported:'unknown_format'};
}
export function createRegistryHostV1(deps:RegistryHostDepsV1) {
  const transport = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      deps.signal?.throwIfAborted();
      return await read();
    } catch (error) {
      if (error instanceof TypeError && !deps.signal?.aborted) {
        throw new RegistryTransportFailureV1(error);
      }
      throw error;
    }
  };
  const wrapHttp = (source: RegistryHttpV1): RegistryHttpV1 => ({
    getJson: (...args) => transport(() => source.getJson(...args)),
    getText: (...args) => transport(() => source.getText(...args)),
    getBytes: (...args) => transport(() => source.getBytes(...args)),
  });
  const http = wrapHttp(deps.http);
  const ctx: RegistryFetchContextV1 = { http, signal: deps.signal, git: deps.git, withAppCatalog: deps.withAppCatalog };
  const viaDaemon = async (request: RegistryFetchRequestV1): Promise<RegistryFetchResponseV1> => {
    const fetch = deps.daemonFetch;
    return fetch
      ? transport(() => fetch(request))
      : { op: 'error', status: { state: 'needs_machine' } };
  };
  const sourceById=async(id:string)=>{
    deps.signal?.throwIfAborted();
    const source=(await deps.readSources()).find(source=>source.id===resolveLegacyRegistrySourceRefV1(id));
    if(!source) throw new RegistryFetchErrorV1({state:'invalid_source'});
    return source;
  };
  const admitSource = async (source: RegistrySourceDescriptorV1, operationCtx: RegistryFetchContextV1) => {
    if (!source.enabled) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    if (!deps.admitSource) return operationCtx;
    const admitted = await deps.admitSource(source);
    return { ...admitted, http: wrapHttp(admitted.http) };
  };
  const direct=async(request:Extract<RegistryFetchRequestV1,{sourceId:string}>,source:RegistrySourceDescriptorV1, operationCtx: RegistryFetchContextV1):Promise<RegistryFetchResponseV1>=>{
    const adapter=adapterFor(source);
    if(!source.kinds.includes(request.kind)) throw new RegistryFetchErrorV1({state:'invalid_source'});
    const formatCtx: RegistryFetchContextV1 = { ...operationCtx, readTargetItem: async target => {
      const descriptor: RegistrySourceDescriptorV1 = { ...target.source, origin: { kind: 'built_in' }, removable: false };
      const targetAdapter = adapterFor(descriptor);
      const placements = resolveRegistryFetchPlanV1({ host: deps.host, adapter: targetAdapter, source: descriptor, op: 'read' });
      for (const [index, placement] of placements.entries()) {
        try {
          if (placement === 'direct') return RegistryItemV1Schema.parse(await targetAdapter.read(operationCtx, target));
          // Browsing a curated pointer never requires a Machine. Its details
          // read fills the reviewed version through the existing daemon owner.
          if (request.op === 'list') return null;
          const response = RegistryFetchResponseV1Schema.parse(await viaDaemon({ op: 'read', sourceId: source.id,
            kind: request.kind, itemId: request.itemId, ...(request.version === undefined ? {} : { version: request.version }) }));
          if (response.op !== 'read') throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok'
            ? response.status : { state: 'invalid_source' });
          return response.item;
        } catch (error) {
          if (error instanceof RegistryTransportFailureV1) {
            if (placement === 'direct' && index + 1 < placements.length) continue;
            // This is the target's failure, not failure of the curated catalog.
            throw new RegistryFetchErrorV1({ state: 'unreachable' });
          }
          throw error;
        }
      }
      throw new RegistryFetchErrorV1({ state: 'unreachable' });
    } };
    if(request.op==='list') return {op:'list',page:await adapter.list(formatCtx,{...request,source})};
    const item=RegistryItemV1Schema.parse(await adapter.read(formatCtx,{...request,source}));
    if(request.op==='read') return {op:'read',item};
    if(item.payload.kind!=='skill') throw new RegistryFetchErrorV1({state:'invalid_source'});
    if(item.summary.problem) throw new RegistryFetchErrorV1({state:'invalid_source'});
    if (item.payload.skill.ref.kind !== 'gitTree') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    if (source.format === 'happier-catalog' && !readGitHubRepositoryV1(item.payload.skill.ref.repo)) {
      const target: RegistrySourceDescriptorV1 = { ...source, format: 'git', kinds: ['skill'], url: item.payload.skill.ref.repo,
        path: item.payload.skill.ref.path, ref: item.payload.skill.ref.commit };
      const placement = resolveRegistryFetchPlanV1({ host: deps.host, adapter: githubRegistryAdapterV1, source: target, op: 'files' });
      if (placement[0] === 'daemon') return RegistryFetchResponseV1Schema.parse(await viaDaemon(request));
      const files = await fetchFiles(item.payload.skill, target, operationCtx);
      return { op: 'files', files: files.map(file => ({ path: file.path, unixMode: file.unixMode, contentBase64: encodeBase64(file.bytes) })) };
    }
    const files=await fetchFiles(item.payload.skill,source,operationCtx);
    return {op:'files',files:files.map(file=>({path:file.path,unixMode:file.unixMode,contentBase64:encodeBase64(file.bytes)}))};
  };
  const fetchFiles=async(skill:RegistrySkillSourceV1,source:RegistrySourceDescriptorV1, operationCtx = ctx):Promise<readonly RegistrySkillFileBytesV1[]>=>{
    if (skill.ref.kind !== 'gitTree') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    if(!readGitHubRepositoryV1(skill.ref.repo) && operationCtx.git) {
      return operationCtx.git.files(skill,source);
    }
    // Source-scoped transport retains token origin rules for every raw-file request.
    const http: RegistryHttpV1 = {
      getJson: (url) => operationCtx.http.getJson(url, { source }),
      getText: (url) => operationCtx.http.getText(url, { source }),
      getBytes: (url) => operationCtx.http.getBytes(url, { source }),
    };
    return fetchRegistrySkillFilesV1({...operationCtx,http},skill);
  };
  const fetchRequest = async (raw: RegistryFetchRequestV1, admittedSource?: RegistrySourceDescriptorV1): Promise<RegistryFetchResponseV1> => {
    return !('sourceId' in raw) && deps.git?.withOperation
      ? deps.git.withOperation(git => fetchRequestInOperation(raw, admittedSource, { ...ctx, git }))
      : fetchRequestInOperation(raw, admittedSource, ctx);
  };
  const fetchRequestInOperation = async (raw: RegistryFetchRequestV1, admittedSource: RegistrySourceDescriptorV1 | undefined, operationCtx: RegistryFetchContextV1): Promise<RegistryFetchResponseV1> => {
    const request = RegistryFetchRequestV1Schema.parse(raw);
    try {
      deps.signal?.throwIfAborted();
      if (!('sourceId' in request)) return await fetchLinkRequest(request, operationCtx);
      // A list already admitted this exact descriptor from its one Account inventory.
      const source = admittedSource ?? await sourceById(request.sourceId);
      const admittedCtx = await admitSource(source, operationCtx);
      const fetchSelected = async (operationCtx: RegistryFetchContextV1): Promise<RegistryFetchResponseV1> => {
        const placements = resolveRegistryFetchPlanV1({
          host: deps.host, adapter: adapterFor(source), source, op: request.op,
        });
        for (const [index, placement] of placements.entries()) {
          try {
            const response = placement === 'direct'
              ? await direct(request, source, operationCtx)
              : await viaDaemon(request);
            return RegistryFetchResponseV1Schema.parse(response);
          } catch (error) {
            if (error instanceof RegistryTransportFailureV1 && placement === 'direct' && index + 1 < placements.length) {
              continue;
            }
            throw error;
          }
        }
        throw new RegistryFetchErrorV1({ state: 'unreachable' });
      };
      return await (admittedCtx.git?.withOperation
        ? admittedCtx.git.withOperation(git => fetchSelected({ ...admittedCtx, git }))
        : fetchSelected(admittedCtx));
    } catch (error) {
      if (error instanceof RegistryFetchErrorV1) return { op: 'error', status: error.status };
      if (error instanceof RegistryTransportFailureV1) return { op: 'error', status: { state: 'unreachable' } };
      throw error;
    }
  };
  const readRegistryItem = async (pointer: RegistryItemPointerV1): Promise<RegistrySkillItemV1> => {
    const response = await fetchRequest({ op: 'read', kind: 'skill', ...pointer });
    if (response.op !== 'read') {
      throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok'
        ? response.status : { state: 'invalid_source' });
    }
    if (response.item.payload.kind !== 'skill') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    return { ...response.item, payload: response.item.payload };
  };
  const filesForPointer = async (pointer: RegistryItemPointerV1): Promise<readonly RegistrySkillFileBytesV1[]> => {
    const response = await fetchRequest({ op: 'files', kind: 'skill', ...pointer });
    if (response.op !== 'files') {
      throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok'
        ? response.status : { state: 'invalid_source' });
    }
    return response.files.map(file => ({ path: file.path, unixMode: file.unixMode, bytes: decodeBase64(file.contentBase64) }));
  };
  const mutate = async (mutation: RegistrySourcesMutationV1) => {
    if (!deps.mutateSources) throw new Error('registry_sources_write_unavailable');
    const result = await deps.mutateSources(mutation);
    if (result.status !== 'updated') throw new Error(result.status === 'conflict' ? 'registry_revision_conflict' : result.reason);
  };
  const linkSource = async (url: string): Promise<RegistrySourceDescriptorV1> => {
    const normalized = normalizeRegistrySourceUrlV1(url);
    const detected = await detectRegistrySourceV1(ctx, normalized, 'skill');
    if ('unsupported' in detected) throw new RegistryFetchErrorV1({ state: detected.unsupported === 'needs_token'
      ? 'auth_failed' : detected.unsupported === 'unreachable' ? 'unreachable' : 'invalid_source' });
    return {
      id: deriveRegistrySourceIdV1(normalized), title: detected.title, format: detected.format,
      kinds: [...detected.kinds], url: normalized, enabled: true, addedAt: Date.now(),
      origin: { kind: 'user' }, removable: true,
    };
  };
  const fetchLinkRequest = async (request: Exclude<RegistryFetchRequestV1, { sourceId: string }>, operationCtx: RegistryFetchContextV1): Promise<RegistryFetchResponseV1> => {
    const normalized = normalizeRegistrySourceUrlV1(request.url);
    // Detection has no admitted format yet. Probe the public HTTPS metadata
    // through its canonical detector before a format-specific fetch plan.
    if (request.op === 'detect') {
      try {
        const detected = await detectRegistrySourceV1(ctx, normalized);
        return { op: 'detect', detected: 'unsupported' in detected ? detected : { ...detected, kinds: [...detected.kinds] } };
      } catch (error) {
        if (error instanceof RegistryTransportFailureV1 && deps.host === 'web' && deps.daemonFetch) return viaDaemon(request);
        throw error;
      }
    }
    const proposed: RegistrySourceDescriptorV1 = {
      id: deriveRegistrySourceIdV1(normalized), url: normalized, title: normalized,
      format: !couldReadWellKnownSkillsV1(normalized) && new URL(normalized).hostname === 'skills.sh' ? 'skills-sh'
        : normalized.endsWith('/marketplace.json') ? 'claude-marketplace' : 'git',
      kinds: ['skill'], enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true,
    };
    const proposedPlacements = resolveRegistryFetchPlanV1({
      host: deps.host, adapter: adapterFor(proposed), source: proposed,
      op: request.op === 'linkFiles' ? 'files' : 'list',
    });
    if (proposedPlacements[0] === 'daemon') return viaDaemon(request);
    if (request.ref?.kind === 'wellKnown' || !request.ref && couldReadWellKnownSkillsV1(normalized)) {
      const pin = request.ref?.kind === 'wellKnown' ? request.ref : undefined;
      if (pin && request.op === 'linkFiles' && (request.itemId !== pin.name || request.version !== pin.digest))
        throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const materialized = await readWellKnownSkillsV1(operationCtx, normalized, pin);
      if (materialized !== null) {
        if (request.op === 'link') return RegistryFetchResponseV1Schema.parse({ op: 'link', items: materialized.map(entry => entry.item) });
        const entry = materialized.find(entry => entry.item.summary.itemId === request.itemId);
        if (!entry) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        return RegistryFetchResponseV1Schema.parse({ op: 'files', files: entry.files.map(file => ({
          path: file.path, unixMode: file.unixMode, contentBase64: encodeBase64(file.bytes),
        })) });
      }
    }
    let detectedSource: RegistrySourceDescriptorV1;
    try {
      detectedSource = await linkSource(normalized);
    } catch (error) {
      if (error instanceof RegistryTransportFailureV1 && proposedPlacements.includes('daemon')) return viaDaemon(request);
      throw error;
    }
    const source = request.ref?.kind === 'gitTree' ? {
      ...detectedSource, format: 'git' as const, url: request.ref.repo, ref: request.ref.commit, path: request.ref.path,
    } : detectedSource;
    const github = createGitHubRegistryOperationV1();
    const adapter = source.format === 'git' ? github : source.format === 'claude-marketplace'
      ? createClaudeMarketplaceRegistryAdapterV1(github) : adapterFor(source);
    const placements = resolveRegistryFetchPlanV1({ host: deps.host, adapter, source, op: request.op === 'link' ? 'list' : 'files' });
    for (const [index, placement] of placements.entries()) {
      try {
        if (placement === 'daemon') {
          return RegistryFetchResponseV1Schema.parse(await viaDaemon(request));
        }
        if (request.op === 'link') {
          if (source.format === 'skills-sh' && new URL(normalized).pathname.replace(/\/$/, '') !== '') {
            const item = await adapter.read(operationCtx, {
              source: { ...source, url: new URL(normalized).origin }, kind: 'skill', itemId: new URL(normalized).pathname.slice(1),
            });
            return RegistryFetchResponseV1Schema.parse({ op: 'link', items: [item] });
          }
          const page = await adapter.list(operationCtx, { source, kind: 'skill' });
          if (page.status.state !== 'ok') throw new RegistryFetchErrorV1(page.status);
          const items = await Promise.all(page.items.filter(item => !item.problem).map(item => adapter.read(operationCtx, {
            source, kind: 'skill', itemId: item.itemId, version: item.version,
          })));
          return RegistryFetchResponseV1Schema.parse({ op: 'link', items });
        }
        if (request.ref.kind !== 'gitTree' || request.version !== request.ref.commit) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        const item = await adapter.read(operationCtx, { source, kind: 'skill', itemId: '', version: request.version });
        if (item.payload.kind !== 'skill' || item.payload.skill.ref.kind !== 'gitTree') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        if (item.payload.skill.ref.treeSha !== request.ref.treeSha) throw new Error('registry_tree_sha_mismatch');
        if (item.summary.problem) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        return {
          op: 'files', files: (await fetchFiles(item.payload.skill, source, operationCtx)).map(file => ({
            path: file.path, unixMode: file.unixMode, contentBase64: encodeBase64(file.bytes),
          })),
        };
      } catch (error) {
        if (error instanceof RegistryTransportFailureV1 && placement === 'direct' && index + 1 < placements.length) {
          continue;
        }
        throw error;
      }
    }
    throw new RegistryFetchErrorV1({ state: 'unreachable' });
  };
  const readLinkSkills = async (url: string, ref?: RegistrySkillContentRefV1): Promise<readonly RegistrySkillItemV1[]> => {
    const response = await fetchRequest({ op: 'link', url, ...(ref ? { ref } : {}) });
    if (response.op !== 'link') {
      throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok'
        ? response.status : { state: 'invalid_source' });
    }
    return response.items.map(item => {
      if (item.payload.kind !== 'skill') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      return { ...item, payload: item.payload };
    });
  };
  const fetchLinkSkillFiles = async (url: string, item: RegistryItemV1): Promise<readonly RegistrySkillFileBytesV1[]> => {
    if (item.payload.kind !== 'skill') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const skill = item.payload.skill;
    if (skill.ref.kind === 'wellKnown') {
      const response = await fetchRequest({ op: 'linkFiles', url, itemId: skill.ref.name, version: skill.ref.digest, ref: skill.ref });
      if (response.op !== 'files') throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok' ? response.status : { state: 'invalid_source' });
      return response.files.map(file => ({ path: file.path, unixMode: file.unixMode, bytes: decodeBase64(file.contentBase64) }));
    }
    const request = { op: 'linkFiles' as const, url, itemId: item.summary.itemId, version: skill.ref.commit, ref: skill.ref };
    if (readGitHubRepositoryV1(skill.ref.repo)) {
      if (item.summary.problem) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const source: RegistrySourceDescriptorV1 = {
        id: deriveRegistrySourceIdV1(normalizeRegistrySourceUrlV1(url)), title: url, url: skill.ref.repo,
        format: 'git', kinds: ['skill'], path: skill.ref.path, ref: skill.ref.commit,
        enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true,
      };
      const placements = resolveRegistryFetchPlanV1({ host: deps.host, adapter: githubRegistryAdapterV1, source, op: 'files' });
      for (const [index, placement] of placements.entries()) {
        try {
          // The canonical reader already pinned and validated this item.
          // Its file verifier checks those exact blob/tree hashes without
          // resolving the same commit/tree again for each previewed skill.
          if (placement === 'direct') return await fetchFiles(skill, source);
          const response = RegistryFetchResponseV1Schema.parse(await viaDaemon(request));
          if (response.op !== 'files') throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok'
            ? response.status : { state: 'invalid_source' });
          return response.files.map(file => ({ path: file.path, unixMode: file.unixMode, bytes: decodeBase64(file.contentBase64) }));
        } catch (error) {
          if (error instanceof RegistryTransportFailureV1) {
            if (placement === 'direct' && index + 1 < placements.length) continue;
            throw new RegistryFetchErrorV1({ state: 'unreachable' });
          }
          throw error;
        }
      }
    }
    const response = await fetchRequest(request);
    if (response.op !== 'files') {
      throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok'
        ? response.status : { state: 'invalid_source' });
    }
    return response.files.map(file => ({ path: file.path, unixMode: file.unixMode, bytes: decodeBase64(file.contentBase64) }));
  };
  const execute = async (actionId: RegistryActionIdV1, input: unknown): Promise<unknown> => {
    const value = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
    let output: unknown;
    switch (actionId) {
      case 'registries.sources.list': {
        const args = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(value);
        const sources = (await deps.readSources()).filter(source => !args.kind || source.kinds.includes(args.kind));
        const picks = args.kind && args.kind !== 'plugin' && sources.find(source => source.id === HAPPIER_PICKS_SOURCE_ID);
        const page = picks && await fetchRequest({ op: 'list', sourceId: picks.id, kind: args.kind! }, picks);
        output = { sources: page && (page.op !== 'list' || page.page.items.length === 0)
          ? sources.filter(source => source.id !== HAPPIER_PICKS_SOURCE_ID) : sources };
        break;
      }
      case 'registries.sources.detect': {
        const args = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(value);
        const response = await fetchRequest({ op: 'detect', url: args.url });
        if (response.op !== 'detect') {
          throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok'
            ? response.status : { state: 'invalid_source' });
        }
        output = { detected: response.detected };
        break;
      }
      case 'registries.sources.create': {
        const args = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(value);
        const url = normalizeRegistrySourceUrlV1(args.url);
        const existing = (await deps.readSources()).find(source => source.url === url
          || source.format === 'happier-catalog' && normalizeRegistrySourceUrlV1(source.url) === url);
        if (existing) {
          output = { source: existing, existing: true };
          break;
        }
        if(args.token && deps.host!=='node') {
          if(!deps.createSourceOnDaemon)throw new RegistryFetchErrorV1({state:'needs_machine'});
          output=await deps.createSourceOnDaemon({...args,url});
          break;
        }
        const tokenSource:RegistryRemoteSourceDescriptorV1|undefined=args.token?{origin:{kind:'user'},removable:true,id:deriveRegistrySourceIdV1(url),title:url,format:'git',kinds:['skill'],url,
          enabled:true,addedAt:0,token:args.token}:undefined;
        const admittedCtx = tokenSource && deps.admitSource ? await deps.admitSource(tokenSource) : ctx;
        const admittedHttp = admittedCtx === ctx ? ctx.http : wrapHttp(admittedCtx.http);
        const tokenCtx:RegistryFetchContextV1=tokenSource?{...admittedCtx,http:{
          getJson:(url)=>admittedHttp.getJson(url,{source:tokenSource}),getText:(url)=>admittedHttp.getText(url,{source:tokenSource}),
          getBytes:(url)=>admittedHttp.getBytes(url,{source:tokenSource}),
        }}:ctx;
        const detection = tokenSource?{op:'detect' as const,detected:await detectRegistrySourceV1(tokenCtx,url)}:await fetchRequest({ op: 'detect', url });
        if (detection.op !== 'detect') {
          throw new RegistryFetchErrorV1(detection.op === 'error' && detection.status.state !== 'ok'
            ? detection.status : { state: 'invalid_source' });
        }
        const detected = detection.detected;
        if ('unsupported' in detected) throw new Error(detected.unsupported);
        if (args.kinds?.some(kind => !detected.kinds.includes(kind))) throw new Error('invalid_source_kind');
        if(args.npmRegistryProfileId && detected.format!=='happier-catalog')throw new Error('invalid_source_profile');
        const sourceUrl = detected.format === 'happier-catalog' ? normalizeMarketplaceSourceUrlV1(url) : url;
        const source: RegistrySourceV1 = {
          id: detected.format === 'happier-catalog' ? deriveMarketplaceSourceId(sourceUrl) : deriveRegistrySourceIdV1(sourceUrl),
          url: sourceUrl, title: args.title ?? detected.title, format: detected.format,
          kinds: args.kinds ?? [...detected.kinds], enabled: true, addedAt: Date.now(),
          ...(args.token?{token:args.token}:{}),...(args.npmRegistryProfileId?{npmRegistryProfileId:args.npmRegistryProfileId}:{}),
        };
        await mutate({ kind: 'create', source });
        output = { source: { ...source, origin: { kind: 'user' }, removable: true }, existing: false };
        break;
      }
      case 'registries.sources.update': {
        const args = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(value);
        const source = await sourceById(args.sourceId);
        if (source.origin.kind !== 'user') {
          if (args.title !== undefined) throw new Error('not_editable');
          if (args.enabled === undefined) throw new Error('invalid_request');
          await mutate({ kind: 'setBuiltInEnabled', sourceId: source.id, enabled: args.enabled });
        } else {
          await mutate({ kind: 'update', ...args, sourceId: source.id });
        }
        output = { source: {
          ...source, ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        } };
        break;
      }
      case 'registries.sources.token.set': {
        const args=REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(value);
        const source=await sourceById(args.sourceId);
        if(source.origin.kind!=='user')throw new Error('not_editable');
        if(args.npmRegistryProfileId && source.format!=='happier-catalog')throw new Error('invalid_source_profile');
        if(args.token===undefined && args.npmRegistryProfileId===undefined)throw new Error('invalid_request');
        await mutate({kind:'setToken',...args,sourceId:source.id});
        const {token,npmRegistryProfileId,...rest}=source;
        output={source:{...rest,
          ...((args.token===undefined?token:args.token)?{token:(args.token===undefined?token:args.token)!}:{}),
          ...((args.npmRegistryProfileId===undefined?npmRegistryProfileId:args.npmRegistryProfileId)
            ?{npmRegistryProfileId:(args.npmRegistryProfileId===undefined?npmRegistryProfileId:args.npmRegistryProfileId)!}:{}),
        }};
        break;
      }
      case 'registries.sources.delete': {
        const args = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(value);
        const source = await sourceById(args.sourceId);
        if (!source.removable) throw new Error('not_removable');
        await mutate({ kind: 'delete', sourceId: source.id });
        output = { removed: true };
        break;
      }
      case 'registries.items.list': {
        const args = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(value);
        const sources = (await deps.readSources()).filter(source => source.enabled && source.kinds.includes(args.kind)
          && (!args.sourceIds || args.sourceIds.includes(source.id)));
        const pages = await Promise.all(sources.map(async source => {
          const response = await fetchRequest({ op: 'list', sourceId: source.id, kind: args.kind, query: args.query, cursor: args.cursor }, source);
          return response.op === 'list' ? response.page : {
            sourceId: source.id, status: response.op === 'error' ? response.status : { state: 'invalid_source' },
            items: [], nextCursor: null,
          };
        }));
        output = { pages: args.kind === 'plugin' ? pages : pages.filter(page => page.sourceId !== HAPPIER_PICKS_SOURCE_ID || page.items.length > 0) };
        break;
      }
      case 'registries.items.read': {
        const args = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(value);
        const response = await fetchRequest({ op: 'read', ...args });
        if (response.op !== 'read') {
          throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok'
            ? response.status : { state: 'invalid_source' });
        }
        output = { item: response.item };
        break;
      }
      case 'registries.updates.check': {
        if (!deps.updates) throw new RegistryFetchErrorV1({ state: 'needs_machine' });
        output = await deps.updates(REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(value));
        break;
      }
    }
    return REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(output);
  };
  const host = {
    // The public fetch boundary always resolves Account authority; callers cannot supply a descriptor.
    execute, fetchRequest: (request: RegistryFetchRequestV1) => fetchRequest(request), readRegistryItem, readRegistrySource: sourceById,
    /** Discovery is metadata-only; template bodies are acquired only after a contribution is selected. */
    readBotTemplateContributions: async (pointer: RegistryItemPointerV1): Promise<readonly PluginBotTemplateContributionV1[]> => {
      const response = await fetchRequest({ op: 'read', kind: 'plugin', ...pointer });
      if (response.op !== 'read' || response.item.payload.kind !== 'plugin') {
        throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok' ? response.status : { state: 'invalid_source' });
      }
      const contributions = response.item.payload.listing.summary.botTemplates;
      if (!contributions) throw new RegistryFetchErrorV1({ state: 'newer_format', found: 'botTemplates' });
      return contributions;
    },
    readBotTemplate: async (pointer: RegistryItemPointerV1, contributionId: string): Promise<ResolvedBotTemplateReleaseV1> => {
      if (deps.host !== 'node') {
        if (!deps.readBotTemplateOnDaemon) throw new RegistryFetchErrorV1({ state: 'needs_machine' });
        return deps.readBotTemplateOnDaemon(pointer, contributionId);
      }
      if (!deps.readPluginBotTemplates) throw new RegistryFetchErrorV1({ state: 'needs_machine' });
      const source = await sourceById(pointer.sourceId);
      const context = await admitSource(source, ctx);
      const available = await deps.readAvailableBotTemplate?.({ pointer, source, contributionId, signal: context.signal });
      if (available) return available;
      const response = await direct({ op: 'read', kind: 'plugin', ...pointer }, source, context).catch(error => {
        if (error instanceof RegistryTransportFailureV1) throw new RegistryFetchErrorV1({ state: 'unreachable' });
        throw error;
      });
      if (response.op !== 'read' || response.item.payload.kind !== 'plugin') {
        throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok'
          ? response.status : { state: 'invalid_source' });
      }
      const contributions = response.item.payload.listing.summary.botTemplates;
      if (!contributions) throw new RegistryFetchErrorV1({ state: 'newer_format', found: 'botTemplates' });
      if (!contributions.some(contribution => contribution.id === contributionId)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      return deps.readPluginBotTemplates({ item: response.item, source, context, contributionId });
    },
    /** Explicit updates use the registry's existing offered-version and eligibility owner. */
    readBotTemplateUpdate: async (pointer: RegistryItemPointerV1, contributionId: string): Promise<ResolvedBotTemplateReleaseV1> => {
      const response = await fetchRequest({ op: 'read', kind: 'plugin', sourceId: pointer.sourceId, itemId: pointer.itemId });
      if (response.op !== 'read' || response.item.payload.kind !== 'plugin') {
        throw new RegistryFetchErrorV1(response.op === 'error' && response.status.state !== 'ok'
          ? response.status : { state: 'invalid_source' });
      }
      const listing = response.item.payload.listing;
      const selected = selectRegistryBotTemplateUpdatePointerV1(pointer, listing);
      return host.readBotTemplate(selected, contributionId);
    },
    fetchRegistrySkillFiles: filesForPointer, filesForPointer, readLinkSkills, fetchLinkSkillFiles,
  };
  return host;
}
