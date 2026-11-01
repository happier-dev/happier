import { z } from 'zod/mini';
import { readSkillFrontmatterV1 } from '../../prompts/library/skills/skillLibraryItemV1.js';
import { RegistryFetchErrorV1, type RegistryListPageV1 } from '../registryListV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistrySkillItemV1, RegistryProvenanceV1, RegistryContentRefV1 } from '../registryItemsV1.js';
import type { RegistryFetchContextV1, RegistrySkillFormatAdapterV1, RegistryHttpResultV1 } from './registryFormatAdapterV1.js';

export function readGitHubRepositoryV1(url: string): Readonly<{ owner: string; repo: string; url: string;ref?:string;path?:string }> | null {
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/?#]+)(?:\/([^?#]*))?)?\/?$/.exec(url);
  return match ? { owner: match[1]!, repo: match[2]!, url: `https://github.com/${match[1]}/${match[2]}`,
    ...(match[3]?{ref:decodeURIComponent(match[3]),path:decodeURIComponent(match[4]??'').replace(/\/+$/,'').replace(/(?:^|\/)SKILL\.md$/,'')}: {}) } : null;
}
export function registryRelativePathV1(path: string): string {
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.' || p.includes('\0'))) throw new RegistryFetchErrorV1({state:'invalid_source'});
  return path.replace(/\/+$/, '');
}
function requireHttp<T>(result: RegistryHttpResultV1<T>): T {
  if (!result.ok) throw new RegistryFetchErrorV1(result.status);
  return result.value;
}
const treeSchema = z.object({ sha: z.string().check(z.minLength(1)), truncated: z.optional(z.boolean()), tree: z.array(z.object({
  path: z.string(), mode: z.string(), type: z.string(), sha: z.string(), size: z.optional(z.number()),
})) });
async function readCommit(ctx: RegistryFetchContextV1, source: RegistrySourceV1, version?: string, credentials = source) {
  ctx.signal?.throwIfAborted();
  const repo = readGitHubRepositoryV1(source.url);
  if (!repo) throw new RegistryFetchErrorV1({state:'invalid_source'});
  const base = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  // A complete Git object id already resolves an immutable revision. Checking it
  // through the mutable commit API spends its budget without changing the pin.
  if (version !== undefined && /^[a-f0-9]{40}$/i.test(version)) return { repo, commit: version, base };
  const commitResult=z.object({sha:z.string().check(z.minLength(1))}).safeParse(requireHttp(await ctx.http.getJson(`${base}/commits/${encodeURIComponent(version ?? source.ref ?? repo.ref ?? 'HEAD')}`, {source:credentials})));
  if(!commitResult.success)throw new RegistryFetchErrorV1({state:'invalid_source'});
  const commit=commitResult.data.sha;
  return {repo, commit, base};
}
async function readCommittedTree(ctx: RegistryFetchContextV1, resolved: Awaited<ReturnType<typeof readCommit>>, credentials: RegistrySourceV1) {
  const {repo, commit, base} = resolved;
  const result = await ctx.http.getJson(`${base}/git/trees/${commit}?recursive=1`, {source:credentials});
  const parsedTree=treeSchema.safeParse(requireHttp(result));if(!parsedTree.success)throw new RegistryFetchErrorV1({state:'invalid_source'});
  const tree=parsedTree.data;
  if (tree.truncated) throw new RegistryFetchErrorV1({state:'invalid_source'});
  return {repo, commit, tree, fetchedAt: result.ok ? result.fetchedAt : 0};
}
async function readTree(ctx: RegistryFetchContextV1, source: RegistrySourceV1, version?: string) {
  return readCommittedTree(ctx, await readCommit(ctx, source, version), source);
}
function skillPaths(tree: z.infer<typeof treeSchema>, source: RegistrySourceV1): string[] {
  const root = registryRelativePathV1(source.path ?? readGitHubRepositoryV1(source.url)?.path ?? '');
  return tree.tree.filter(entry => entry.type === 'blob' && (entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md')))
    .map(entry => entry.path === 'SKILL.md' ? '' : entry.path.slice(0, -'/SKILL.md'.length))
    .filter(path => !root || path === root || path.startsWith(root + '/'))
    .map(path => root ? path.slice(root.length).replace(/^\//, '') : path);
}
function createGitHubRegistryAdapterV1(readRepositoryTree: typeof readTree): RegistrySkillFormatAdapterV1 {
return {
  format:'git', kinds:['skill'], browserFetchable: source => readGitHubRepositoryV1(source.url) !== null, supportsQuery:true,
  async list(ctx, req): Promise<RegistryListPageV1> {
    if (!readGitHubRepositoryV1(req.source.url)) {
      if (ctx.git) return ctx.git.list(ctx,req);
      throw new RegistryFetchErrorV1({state:'needs_machine'});
    }
    try {
      const {tree,commit,fetchedAt} = await readRepositoryTree(ctx,req.source);
      const query = req.query?.trim().toLowerCase();
      const paths = skillPaths(tree,req.source).filter(path => !query || path.toLowerCase().includes(query));
      return {sourceId:req.source.id,status:{state:'ok',fetchedAt},nextCursor:null,total:paths.length,
        items:paths.map(path => ({sourceId:req.source.id,kind:'skill',itemId:path,title:path.split('/').at(-1) || req.source.title,
          version:commit,links:{repository:req.source.url}}))};
    } catch(error) {
      if (!(error instanceof RegistryFetchErrorV1)) throw error;
      return {sourceId:req.source.id,status:error.status,items:[],nextCursor:null};
    }
  },
  async read(ctx,req): Promise<RegistrySkillItemV1> {
    if (!readGitHubRepositoryV1(req.source.url)) {
      if (ctx.git) return ctx.git.read(ctx,req);
      throw new RegistryFetchErrorV1({state:'needs_machine'});
    }
    const {repo,commit,tree,fetchedAt} = await readRepositoryTree(ctx,req.source,req.version);
    const path = registryRelativePathV1([req.source.path ?? repo.path,registryRelativePathV1(req.itemId)].filter(Boolean).join('/'));
    const prefix = path ? `${path}/` : '';
    const entries = tree.tree.filter(entry => entry.path.startsWith(prefix) && entry.type !== 'tree');
    const treeSha = path ? tree.tree.find(entry => entry.path === path && entry.type === 'tree')?.sha : tree.sha;
    if (!treeSha || !entries.some(entry => entry.path === prefix+'SKILL.md')) throw new RegistryFetchErrorV1({state:'invalid_source'});
    const unsupported = entries.find(entry => entry.mode === '120000' || entry.mode === '160000' || entry.type === 'commit');
    const files = entries.filter(entry => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755'))
      .map(entry => ({path:entry.path.slice(prefix.length),size:entry.size ?? 0,unixMode:entry.mode === '100755' ? 0o755 as const : 0o644 as const,blobSha:entry.sha}));
    const skillMarkdown = unsupported ? '' : requireHttp(await ctx.http.getText(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${commit}/${prefix}SKILL.md`,{source:req.source}));
    const frontmatter = readSkillFrontmatterV1(skillMarkdown);
    return {summary:{sourceId:req.source.id,kind:'skill',itemId:req.itemId,title:frontmatter.name || req.itemId.split('/').at(-1) || req.source.title,
      ...(frontmatter.description ? {description:frontmatter.description} : {}),version:commit,links:{repository:repo.url},
      ...(unsupported ? {problem:{code:'unsupported_entry',reason:unsupported.mode === '120000' ? 'symlink' : 'submodule'} as const} : {})},
      payload:{kind:'skill',skill:{ref:{kind:'gitTree',repo:repo.url,path,commit,treeSha},skillMarkdown,files}},fetchedAt};
  },
  async latest(ctx,items,options) {
    const result = new Map<string,RegistryContentRefV1|'removed'>();
    const repos = new Map<string,RegistryProvenanceV1[]>();
    for (const item of items) { const group = repos.get(item.sourceUrl) ?? []; group.push(item); repos.set(item.sourceUrl,group); }
    for (const [url,group] of repos) {
      const source:RegistrySourceV1 = options ? {...options.source,url} : {id:group[0]!.sourceId,title:url,format:'git',kinds:['skill'],url,enabled:true,addedAt:0};
      const credentials = options?.source ?? source;
      if (!readGitHubRepositoryV1(url)) {
        if(options&&options.source.format!=='git')throw new RegistryFetchErrorV1({state:'invalid_source'});
        if (!ctx.git) throw new RegistryFetchErrorV1({state:'needs_machine'});
        for (const [key,value] of await ctx.git.latest(ctx,group,{source})) result.set(key,value);
        continue;
      }
      const resolved = await readCommit(ctx,source,undefined,credentials);
      const targetPath = (item: RegistryProvenanceV1) => registryRelativePathV1(options?.source.format==='git'
        ? [source.path ?? readGitHubRepositoryV1(source.url)?.path, registryRelativePathV1(item.itemId)].filter(Boolean).join('/')
        : item.ref.kind==='gitTree' ? item.ref.path : '');
      const unchanged = (item: RegistryProvenanceV1) => item.ref.kind==='gitTree' && item.ref.commit===resolved.commit
        && item.ref.repo===resolved.repo.url && item.ref.path===targetPath(item);
      const changed = group.filter(item=>item.ref.kind==='gitTree' && !unchanged(item));
      const tree = changed.length ? (await readCommittedTree(ctx,resolved,credentials)).tree : undefined;
      for (const item of group) {
        if (item.ref.kind !== 'gitTree') continue;
        const ref = item.ref;
        if (unchanged(item)) {result.set(item.itemId,ref);continue;}
        const path=targetPath(item);
        const sha = path ? tree!.tree.find(entry => entry.path === path && entry.type === 'tree')?.sha : tree!.sha;
        const skillPath=path?`${path}/SKILL.md`:'SKILL.md';
        result.set(item.itemId,sha && tree!.tree.some(entry=>entry.path===skillPath && entry.type==='blob')
          ? {kind:'gitTree',repo:resolved.repo.url,path,commit:resolved.commit,treeSha:sha} : 'removed');
      }
    }
    return result;
  },
};
}
export const githubRegistryAdapterV1 = createGitHubRegistryAdapterV1(readTree);

/** One link listing and its pinned reads share the repository result. The
 * caller creates this reader per operation; no result survives that operation. */
export function createGitHubRegistryOperationV1(): RegistrySkillFormatAdapterV1 {
  const reads = new Map<string, ReturnType<typeof readTree>>();
  const keyFor = (source: RegistrySourceV1, ref: string) => JSON.stringify([
    readGitHubRepositoryV1(source.url)?.url, ref, source.token ?? null,
  ]);
  return createGitHubRegistryAdapterV1((ctx, source, version) => {
    const ref = version ?? source.ref ?? readGitHubRepositoryV1(source.url)?.ref ?? 'HEAD';
    const key = keyFor(source, ref);
    const existing = reads.get(key);
    if (existing) return existing;
    const pending = readTree(ctx, source, version).then(result => {
      reads.set(keyFor(source, result.commit), Promise.resolve(result));
      return result;
    });
    reads.set(key, pending);
    return pending;
  });
}
