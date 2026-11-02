import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { computeGitTreeShaV1, computeGitTreeShaFromEntriesV1 } from '../registryGitTreeV1.js';
import type { RegistryContentRefV1, RegistryItemSummaryV1 } from '../registryItemsV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import { readGitHubRepositoryV1, readRegistryGitHubCommitV1, registryRelativePathV1 } from './github.js';
import type { RegistryFetchContextV1, RegistryHttpResultV1 } from './registryFormatAdapterV1.js';
import { templateRecordV1 } from './composeTemplateNormalizationV1.js';

export function requireCatalogHttpV1<T>(result: RegistryHttpResultV1<T>): T {
  if (!result.ok) throw new RegistryFetchErrorV1(result.status);
  return result.value;
}
export async function resolveAppCatalogLocationV1(ctx: RegistryFetchContextV1, source: RegistrySourceV1, defaultIndex: string, version?: string) {
  ctx.signal?.throwIfAborted();
  const repo = readGitHubRepositoryV1(source.url);
  if (repo) {
    const resolved = await readRegistryGitHubCommitV1(ctx, source, version);
    const configured = registryRelativePathV1(source.path ?? repo.path ?? '');
    const indexPath = configured.endsWith('.json') ? configured : [configured, defaultIndex].filter(Boolean).join('/');
    return { source, indexPath, root: indexPath.includes('/') ? indexPath.slice(0, indexPath.lastIndexOf('/') + 1) : '',
      base: `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${resolved.commit}/`, repo: repo.url, commit: resolved.commit,
      api: resolved.base };
  }
  let url: URL;
  try { url = new URL(source.url); } catch { throw new RegistryFetchErrorV1({ state: 'invalid_source' }); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const path = registryRelativePathV1(source.path ?? '');
  const indexUrl = path ? new URL(path.endsWith('.json') ? path : `${path}/${defaultIndex}`, `${source.url.replace(/\/$/, '')}/`)
    : url.pathname.endsWith('.json') ? url : new URL(defaultIndex, `${source.url.replace(/\/$/, '')}/`);
  return { source, indexPath: indexUrl.pathname.split('/').at(-1)!, root: '', base: new URL('.', indexUrl).toString(),
    repo: undefined, commit: undefined, api: undefined };
}
export type AppCatalogLocationV1 = Awaited<ReturnType<typeof resolveAppCatalogLocationV1>>;
export async function withAppCatalogReadV1<T>(ctx: RegistryFetchContextV1, source: RegistrySourceV1, defaultIndex: string,
  version: string | undefined, consume: (ctx: RegistryFetchContextV1, location: AppCatalogLocationV1) => Promise<T>): Promise<T> {
  const location = await resolveAppCatalogLocationV1(ctx, source, defaultIndex, version);
  return location.commit && ctx.withAppCatalog
    ? ctx.withAppCatalog({ source, commit: location.commit, current: version === undefined, http: ctx.http },
      http => consume({ ...ctx, http }, location))
    : consume(ctx, location);
}
export async function readAppCatalogIndexV1(ctx: RegistryFetchContextV1, location: AppCatalogLocationV1) {
  const response = await ctx.http.getJson(new URL(location.indexPath, location.base).toString(), { source: location.source });
  return { value: requireCatalogHttpV1(response), fetchedAt: response.ok ? response.fetchedAt : 0 };
}
export function appCatalogFileUrlV1(location: AppCatalogLocationV1, path: string): string {
  const contained = registryRelativePathV1(path);
  if (!contained) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return new URL(contained.split('/').map(encodeURIComponent).join('/'), location.base).toString();
}
export function appCatalogContentRefV1(location: AppCatalogLocationV1, files: readonly Readonly<{ path: string; content: string }>[]): RegistryContentRefV1 {
  if (location.repo && location.commit) return { kind: 'gitTree', repo: location.repo, commit: location.commit, path: '',
    treeSha: computeGitTreeShaV1(files.map(file => ({ path: file.path, unixMode: 0o644, bytes: new TextEncoder().encode(file.content) }))) };
  // Length-framed JSON strings retain both file paths and their exact bytes;
  // the same selected file set always has the same content identity.
  const selected = files.map(({ path, content }) => ({ path, content })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { kind: 'content', digest: `sha256:${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(selected))))}` };
}
export function appCatalogRefVersionV1(ref: RegistryContentRefV1): string {
  return ref.kind === 'gitTree' ? ref.commit : ref.kind === 'version' ? ref.version : ref.digest;
}
export function appCatalogSummaryV1(source: RegistrySourceV1, id: string, entry: Record<string, unknown>, version?: string,
  location?: AppCatalogLocationV1): RegistryItemSummaryV1 {
  const links = templateRecordV1(entry.links);
  const description = typeof entry.slogan === 'string' ? entry.slogan : typeof entry.description === 'string' ? entry.description : undefined;
  const port = typeof entry.port === 'number' || typeof entry.port === 'string' && /^\d+$/.test(entry.port) ? Number(entry.port) : undefined;
  const architectures = [...(entry.amd_only === true ? ['amd64' as const] : []), ...(entry.arm_only === true ? ['arm64' as const] : [])];
  const upstreamIcon = typeof entry.logo === 'string' ? entry.logo : undefined;
  let iconUrl = upstreamIcon?.startsWith('https://') ? upstreamIcon : undefined;
  if (!iconUrl && upstreamIcon && location?.repo && location.commit) {
    // The native catalog's relative logo names a public repository asset.
    // HTTP-only indexes retain the token without guessing a repository URL.
    try { iconUrl = appCatalogFileUrlV1(location, `public/${registryRelativePathV1(upstreamIcon)}`); }
    catch (error) { if (!(error instanceof RegistryFetchErrorV1)) throw error; }
  }
  const title = typeof entry.name === 'string' && entry.name ? entry.name
    : typeof entry.title === 'string' && entry.title ? entry.title
    : id.split(/[-_]+/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return { sourceId: source.id, kind: 'app', itemId: id, title,
    ...(description === undefined ? {} : { description }), ...(version === undefined ? {} : { version }),
    ...(iconUrl === undefined ? {} : { iconUrl }),
    ...(typeof entry.license === 'string' ? { license: entry.license } : {}),
    appMetadata: { ...(typeof entry.category === 'string' ? { category: entry.category } : {}),
      ...(upstreamIcon === undefined ? {} : { upstreamIcon }),
      ...(typeof entry.minversion === 'string' ? { upstreamMinimumVersion: entry.minversion } : {}),
      ...(Array.isArray(entry.tags) && entry.tags.every(tag => typeof tag === 'string') ? { tags: entry.tags } : {}),
      ...(port !== undefined && port > 0 && port <= 65535 ? { containerPort: port } : {}),
      ...(architectures.length ? { architectures } : {}) },
    links: { repository: source.url, ...(typeof entry.documentation === 'string' ? { website: entry.documentation }
      : typeof links?.docs === 'string' ? { website: links.docs } : typeof links?.website === 'string' ? { website: links.website } : {}) } };
}
/** Git metadata supplies selected blob identities without reading/decoding any
 * template body during the finite upstream check. */
export async function readAppCatalogTreeV1(ctx: RegistryFetchContextV1, location: AppCatalogLocationV1): Promise<ReadonlyMap<string, string>> {
  if (!location.api || !location.commit) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const response = requireCatalogHttpV1(await ctx.http.getJson(`${location.api}/git/trees/${location.commit}?recursive=1`, { source: location.source }));
  const record = templateRecordV1(response);
  if (!record || record.truncated === true || !Array.isArray(record.tree)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const entries = new Map<string, string>();
  for (const value of record.tree) {
    const entry = templateRecordV1(value);
    if (entry?.type === 'blob' && entry.mode === '100644' && typeof entry.path === 'string' && typeof entry.sha === 'string' && /^[a-f0-9]{40}$/i.test(entry.sha)) entries.set(entry.path, entry.sha);
  }
  return entries;
}
export function appCatalogTreeRefV1(location: AppCatalogLocationV1, files: readonly Readonly<{ path: string; blobSha: string }>[]): RegistryContentRefV1 {
  if (!location.repo || !location.commit) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return { kind: 'gitTree', repo: location.repo, commit: location.commit, path: '',
    treeSha: computeGitTreeShaFromEntriesV1(files.map(file => ({ ...file, unixMode: 0o644 }))) };
}
