import { sha1 } from '@noble/hashes/sha1';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';
import type { RegistrySkillSourceV1 } from './registryItemsV1.js';
import type { RegistryFetchContextV1 } from './formats/registryFormatAdapterV1.js';
import { RegistryFetchErrorV1 } from './registryListV1.js';

export type RegistrySkillFileBytesV1 = Readonly<{ path: string; unixMode: 0o644 | 0o755; bytes: Uint8Array }>;
const encode = (s: string) => new TextEncoder().encode(s);
function hashObject(kind: 'blob' | 'tree', bytes: Uint8Array): string {
  return bytesToHex(sha1(concatBytes(encode(`${kind} ${bytes.length}\0`), bytes)));
}
export function computeGitBlobShaV1(bytes: Uint8Array): string { return hashObject('blob', bytes); }
export function computeGitTreeShaV1(files: readonly RegistrySkillFileBytesV1[]): string {
  return computeGitTreeShaFromEntriesV1(files.map(file => ({ ...file, blobSha: computeGitBlobShaV1(file.bytes) })));
}
/** A selected file set has the same native Git identity whether acquired as
 * bytes or read from the repository's pinned blob metadata. */
export function computeGitTreeShaFromEntriesV1(files: readonly Readonly<{ path: string; unixMode: 0o644 | 0o755; blobSha: string }>[]): string {
  type Entry = typeof files[number];
  type Tree = Map<string, Tree | Entry>;
  const root: Tree = new Map();
  for (const file of files) {
    const parts = file.path.split('/');
    if (!/^[a-f0-9]{40}$/i.test(file.blobSha)) throw new Error('invalid_blob_sha');
    if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\0') || p.includes('\\'))) throw new Error('invalid_file_path');
    let tree = root;
    for (const part of parts.slice(0, -1)) {
      const prior = tree.get(part);
      if (prior && !(prior instanceof Map)) throw new Error('invalid_file_path');
      const next = prior ?? new Map<string, Tree | Entry>(); tree.set(part, next); tree = next;
    }
    const leaf = parts.at(-1)!;
    if (tree.has(leaf)) throw new Error('duplicate_file_path');
    tree.set(leaf, file);
  }
  function hash(tree: Tree): string {
    const entries = [...tree].map(([name, child]) => ({ name, child, key: encode(name + (child instanceof Map ? '/' : '')) }));
    entries.sort((a, b) => {
      for (let i = 0; i < Math.min(a.key.length, b.key.length); i++) { const diff = a.key[i]! - b.key[i]!; if (diff) return diff; }
      return a.key.length - b.key.length;
    });
    return hashObject('tree', concatBytes(...entries.map(({ name, child }) => concatBytes(
      encode(`${child instanceof Map ? '40000' : child.unixMode === 0o755 ? '100755' : '100644'} ${name}\0`),
      hexToBytes(child instanceof Map ? hash(child) : child.blobSha),
    ))));
  }
  return hash(root);
}
export async function fetchRegistrySkillFilesV1(ctx: RegistryFetchContextV1, skill: RegistrySkillSourceV1): Promise<readonly RegistrySkillFileBytesV1[]> {
  if (skill.ref.kind !== 'gitTree') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const ref = skill.ref;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(ref.repo);
  if (!match) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const files = await Promise.all(skill.files.map(async file => {
    const path = [ref.path, file.path].filter(Boolean).join('/');
    const response = await ctx.http.getBytes(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${encodeURIComponent(ref.commit)}/${path.split('/').map(encodeURIComponent).join('/')}`);
    if (!response.ok) throw new RegistryFetchErrorV1(response.status);
    if (computeGitBlobShaV1(response.value) !== file.blobSha) throw new Error('registry_blob_sha_mismatch');
    return { path: file.path, unixMode: file.unixMode, bytes: response.value };
  }));
  if (computeGitTreeShaV1(files) !== ref.treeSha) throw new Error('registry_tree_sha_mismatch');
  return files;
}
