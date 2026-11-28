import { z } from '../../zodRuntimePolicy.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { decodeBase64 } from '../../crypto/base64.js';
import { computePromptBundleDigestV1 } from '../../prompts/library/promptLibraryDigests.js';
import { validatePromptBundleBodyV1AgainstSchemaId } from '../../prompts/library/promptBundleShapeV1.js';
import { readSkillFrontmatterV1 } from '../../prompts/library/skills/skillLibraryItemV1.js';
import { readSkillZipFilesV1, skillFileFromBytesV1 } from '../../prompts/library/skills/skillZipV1.js';
import { computeGitBlobShaV1, type RegistrySkillFileBytesV1 } from '../registryGitTreeV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
import { WellKnownSkillRefV1Schema, type RegistryContentRefV1, type RegistryProvenanceV1, type RegistrySkillItemV1, type WellKnownSkillRefV1 } from '../registryItemsV1.js';
import { deriveRegistrySourceIdV1 } from '../registrySourcesV1.js';
import type { RegistryFetchContextV1 } from './registryFormatAdapterV1.js';

const discoverySchema = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';
const digestSchema = WellKnownSkillRefV1Schema.shape.digest;
const nameSchema = WellKnownSkillRefV1Schema.shape.name;
const entrySchema = z.union([
  z.object({ name: nameSchema, description: z.optional(z.string()), files: z.array(z.string()).check(z.minLength(1)) }),
  z.object({ name: nameSchema, description: z.optional(z.string()), type: z.enum(['skill-md', 'archive']),
    url: z.string().check(z.minLength(1)), digest: z.optional(digestSchema) }),
]);
type IndexEntry = z.infer<typeof entrySchema>;
type Index = Readonly<{ url: string; entries: readonly IndexEntry[]; names: ReadonlySet<string>; fetchedAt: number }>;
type Materialized = Readonly<{ item: RegistrySkillItemV1; files: readonly RegistrySkillFileBytesV1[] }>;
const fail = (): never => { throw new RegistryFetchErrorV1({ state: 'invalid_source' }); };

/** Public HTTPS only; an index is content, never a command or credential destination. */
function httpsUrl(raw: string, base?: string): string {
  const url = new URL(raw, base);
  if (url.protocol !== 'https:' || url.username || url.password) return fail();
  url.hash = '';
  return url.href;
}
function safePath(path: string): boolean {
  return !path.includes('\\') && !path.includes('\0') && !/^[a-z]:/i.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** Known Git/catalog links keep their existing owner; other sites can publish a scoped index. */
export function couldReadWellKnownSkillsV1(raw: string): boolean {
  const url = new URL(raw);
  if (/\/.well-known\/(?:agent-skills|skills)\/index\.json$/.test(url.pathname)) return true;
  if (['github.com', 'gitlab.com', 'huggingface.co'].includes(url.hostname)
    || url.pathname.endsWith('.git') || url.pathname.endsWith('/marketplace.json')) return false;
  if (url.hostname === 'skills.sh' || url.hostname === 'www.skills.sh') return /^\/p\/[^/]+\/?$/.test(url.pathname);
  return true;
}

async function readIndex(ctx: RegistryFetchContextV1, raw: string): Promise<Index | null> {
  const url = new URL(httpsUrl(raw));
  const explicit = /\/.well-known\/(?:agent-skills|skills)\/index\.json$/.test(url.pathname);
  // Like upstream discovery, a scoped site/pack never widens to the root catalog.
  const base = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  const candidates = explicit ? [url.href] : ['agent-skills', 'skills'].map(path => `${base}/.well-known/${path}/index.json`);
  for (const address of candidates) {
    ctx.signal?.throwIfAborted();
    const response = await ctx.http.getJson(address);
    if (!response.ok) {
      if (response.status.state === 'rate_limited' || response.status.state === 'auth_failed') throw new RegistryFetchErrorV1(response.status);
      continue;
    }
    const parsed = z.object({ $schema: z.optional(z.string()), skills: z.array(z.unknown()) }).safeParse(response.value);
    if (!parsed.success || parsed.data.$schema !== undefined && parsed.data.$schema !== discoverySchema) continue;
    const entries = parsed.data.skills.flatMap(rawEntry => {
      const entry = entrySchema.safeParse(rawEntry);
      return entry.success ? [entry.data] : [];
    });
    const names = new Set<string>();
    // Duplicate identities are ambiguous, including when only one entry is readable.
    for (const rawEntry of parsed.data.skills) {
      const identity = z.object({ name: nameSchema }).safeParse(rawEntry);
      if (!identity.success) continue;
      if (names.has(identity.data.name)) return fail();
      names.add(identity.data.name);
    }
    return { url: address, entries, names, fetchedAt: response.fetchedAt };
  }
  return null;
}

async function bytes(ctx: RegistryFetchContextV1, url: string): Promise<Uint8Array> {
  ctx.signal?.throwIfAborted();
  const response = await ctx.http.getBytes(httpsUrl(url));
  if (!response.ok) throw new RegistryFetchErrorV1(response.status);
  return response.value;
}

async function archiveFiles(content: Uint8Array): Promise<readonly RegistrySkillFileBytesV1[]> {
  if (content[0] === 0x50 && content[1] === 0x4b) {
    return (await readSkillZipFilesV1(content)).map(file => ({ path: file.path,
      unixMode: file.unixMode != null && (file.unixMode & 0o111) !== 0 ? 0o755 : 0o644, bytes: decodeBase64(file.contentBase64) }));
  }
  if (content[0] !== 0x1f || content[1] !== 0x8b) return fail();
  // Index links run on the daemon through the existing non-browser fetch plan.
  // Its standard Web compression API avoids a Node-only import in Protocol.
  const stream = new Blob([new Uint8Array(content)]).stream().pipeThrough(new DecompressionStream('gzip'));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  const text = (header: Uint8Array, start: number, size: number) => new TextDecoder().decode(header.subarray(start, start + size)).split('\0')[0]!;
  const files: RegistrySkillFileBytesV1[] = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = text(header, 0, 100), prefix = text(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = text(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) return fail();
    const size = Number.parseInt(sizeText, 8);
    const type = header[156];
    offset += 512;
    if (!Number.isSafeInteger(size) || offset + size > tar.length) return fail();
    if (type === 0 || type === 0x30) files.push({ path, bytes: tar.slice(offset, offset + size),
      unixMode: (Number.parseInt(text(header, 100, 8).trim() || '0', 8) & 0o111) !== 0 ? 0o755 : 0o644 });
    else if (type !== 0x35 && type !== 0x78 && type !== 0x67) return fail();
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

async function materialize(ctx: RegistryFetchContextV1, index: Index, entry: IndexEntry, pin?: WellKnownSkillRefV1): Promise<Materialized> {
  let files: readonly RegistrySkillFileBytesV1[];
  let publishedDigest: string | undefined;
  if ('files' in entry) {
    if (entry.files.some(path => !safePath(path)) || new Set(entry.files).size !== entry.files.length) return fail();
    files = await Promise.all(entry.files.map(async path => ({ path, unixMode: 0o644 as const,
      bytes: await bytes(ctx, new URL(`${encodeURIComponent(entry.name)}/${path.split('/').map(encodeURIComponent).join('/')}`, index.url).href) })));
  } else {
    const content = await bytes(ctx, httpsUrl(entry.url, index.url));
    if (entry.digest !== undefined) {
      const actual = `sha256:${bytesToHex(sha256(content))}`;
      if (actual !== entry.digest) return fail();
      publishedDigest = actual;
    }
    files = entry.type === 'skill-md' ? [{ path: 'SKILL.md', unixMode: 0o644, bytes: content }] : await archiveFiles(content);
  }
  if (files.some(file => !safePath(file.path))) return fail();
  const body = { v: 1 as const, entries: files.map(file => skillFileFromBytesV1(file.path, file.bytes, file.unixMode)), createdAtMs: 0, updatedAtMs: 0 };
  if (!validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body }).ok) return fail();
  const skillMarkdown = new TextDecoder('utf-8', { fatal: true }).decode(files.find(file => file.path === 'SKILL.md')?.bytes ?? new Uint8Array());
  const frontmatter = readSkillFrontmatterV1(skillMarkdown);
  if (!frontmatter.name) return fail();
  const ref: WellKnownSkillRefV1 = { kind: 'wellKnown', indexUrl: index.url, name: entry.name,
    digest: computePromptBundleDigestV1(body), ...(publishedDigest ? { publishedDigest } : {}) };
  if (pin && (pin.indexUrl !== ref.indexUrl || pin.name !== ref.name || pin.digest !== ref.digest
    || pin.publishedDigest !== ref.publishedDigest)) return fail();
  return { files, item: { summary: { kind: 'skill', sourceId: deriveRegistrySourceIdV1(index.url), itemId: entry.name,
    title: frontmatter.name, description: frontmatter.description ?? entry.description, version: ref.digest,
    links: { website: index.url } }, fetchedAt: index.fetchedAt,
    payload: { kind: 'skill', skill: { ref, skillMarkdown, files: files.map(file => ({ path: file.path,
      size: file.bytes.length, unixMode: file.unixMode, blobSha: computeGitBlobShaV1(file.bytes) })) } } } };
}

/** One format reader for Link preview, re-verification, and Updates. No persistent cache. */
export async function readWellKnownSkillsV1(ctx: RegistryFetchContextV1, url: string, pin?: WellKnownSkillRefV1): Promise<readonly Materialized[] | null> {
  const index = await readIndex(ctx, pin?.indexUrl ?? url);
  if (!index) return pin ? fail() : null;
  if (pin) {
    const entry = index.entries.find(entry => entry.name === pin.name);
    return entry ? [await materialize(ctx, index, entry, pin)] : fail();
  }
  const items = await Promise.all(index.entries.map(async entry => {
    try { return await materialize(ctx, index, entry); }
    catch { ctx.signal?.throwIfAborted(); return null; }
  }));
  return items.filter(item => item !== null);
}

/** Missing entries are removed; unreadable or unverifiable entries remain unchecked. */
export async function readWellKnownSkillUpdatesV1(ctx: RegistryFetchContextV1, items: readonly RegistryProvenanceV1[]): Promise<ReadonlyMap<string, RegistryContentRefV1 | 'removed'>> {
  const result = new Map<string, RegistryContentRefV1 | 'removed'>();
  const indexes = new Map<string, Promise<Index | null>>();
  for (const item of items) {
    if (item.ref.kind !== 'wellKnown') continue;
    const address = item.ref.indexUrl;
    let read = indexes.get(address);
    if (!read) { read = readIndex(ctx, address); indexes.set(address, read); }
    const index = await read;
    if (!index) continue;
    const entry = index.entries.find(entry => entry.name === item.itemId);
    if (!entry) { if (!index.names.has(item.itemId)) result.set(item.itemId, 'removed'); continue; }
    try { result.set(item.itemId, (await materialize(ctx, index, entry)).item.payload.skill.ref); }
    catch { ctx.signal?.throwIfAborted(); }
  }
  return result;
}
