import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { removeHappierTempDir } from '@happier-dev/cli-common/tempDirs';
import { runScmCommand } from '@/scm/runtime';
import {
  RegistryFetchErrorV1, computeGitBlobShaV1, computeGitTreeShaV1, type RegistryFetchContextV1, type RegistrySourceV1,
  type RegistrySkillSourceV1, type RegistrySkillFileBytesV1, type RegistryContentRefV1
} from '@happier-dev/protocol/registries';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { registryTokenHeader } from './registryTokenHeader';

function admitRepository(url: string): void {
  const valid = /^(https|ssh|git):\/\//.test(url) || /^[\w.-]+@[\w.-]+:[^\0]+$/.test(url) || isAbsolute(url) || /^[A-Za-z]:[\\/]/.test(url);
  if (!valid || url.includes('\0') || url.startsWith('-')) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
}
function admitPath(path: string): string {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.' || part === '')) {
    if (path === '') return ''; throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  }
  return path;
}
type GitProtocol = NonNullable<RegistryFetchContextV1['git']>;
type GitReadOptions = Pick<Parameters<typeof runScmCommand>[0], 'maxOutputBytes' | 'stdoutConsumer'>;
type Repository = Readonly<{ commit: string; run: (args: string[], options?: GitReadOptions) => Promise<string> }>;
export function createRegistryGitProtocolV1(input: Readonly<{ signal?: AbortSignal; resolveToken?: (source: RegistrySourceV1) => Promise<string | null> }>): NonNullable<RegistryFetchContextV1['git']> {
  async function repositoryEnv(source: RegistrySourceV1): Promise<Record<string, string>> {
    admitRepository(source.url);
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
    if (source.token) {
      const value = await input.resolveToken?.(source);
      if (!value) throw new RegistryFetchErrorV1({ state: 'auth_failed' });
      if (!source.url.startsWith('https://')) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      let header: ReturnType<typeof registryTokenHeader>;
      try { header = registryTokenHeader(source, value); } catch { throw new RegistryFetchErrorV1({ state: 'auth_failed' }); }
      // Git matches scoped headers against the original URL, not redirect URLs.
      // A credentialed repository must therefore use its final HTTPS destination.
      const rawCount = process.env.GIT_CONFIG_COUNT ?? '';
      const inheritedCount = rawCount === '' ? 0 : /^[ \t\n\r\f\v]*[+-]?\d+$/.test(rawCount) ? Number(rawCount) : NaN;
      // Preserve operator config (including scoped TLS trust) and its errors;
      // derive exact indices only, leaving Git's own config limits unchanged.
      if (inheritedCount < 0 || !Number.isSafeInteger(inheritedCount + 3)) throw new RegistryFetchErrorV1({ state: 'unreachable' });
      env.GIT_CONFIG_COUNT = String(inheritedCount + 3);
      // extraHeader is multi-valued. Reset it at this exact source before adding
      // its managed credential, so an inherited header cannot change identity.
      env[`GIT_CONFIG_KEY_${inheritedCount}`] = `http.${source.url}.extraHeader`; env[`GIT_CONFIG_VALUE_${inheritedCount}`] = '';
      env[`GIT_CONFIG_KEY_${inheritedCount + 1}`] = `http.${source.url}.extraHeader`; env[`GIT_CONFIG_VALUE_${inheritedCount + 1}`] = `${header.name}: ${header.value}`;
      env[`GIT_CONFIG_KEY_${inheritedCount + 2}`] = `http.${source.url}.followRedirects`; env[`GIT_CONFIG_VALUE_${inheritedCount + 2}`] = 'false';
    }
    return env;
  }
  async function withOperation<T>(consume: (git: GitProtocol) => Promise<T>): Promise<T> {
    const directories: string[] = [];
    const repositories = new Map<string, Promise<Repository>>();
    const pending: Promise<unknown>[] = [];
    const keyFor = (source: RegistrySourceV1, ref: string) => JSON.stringify([source.url, source.token ?? null, ref]);
    async function acquireRepository(source: RegistrySourceV1, version: string | undefined): Promise<Repository> {
      const env = await repositoryEnv(source);
      const pinnedRef = source.ref && /^[a-f0-9]{40}$/i.test(source.ref) ? source.ref : undefined;
      const pin = version ?? pinnedRef;
      if (pin && !/^[a-f0-9]{40}$/i.test(pin)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      input.signal?.throwIfAborted();
      const cwd = await mkdtemp(join(tmpdir(), 'happier-registry-git-'));
      directories.push(cwd);
      async function command(directory: string, args: string[], options?: GitReadOptions) {
        input.signal?.throwIfAborted();
        const result = await runScmCommand({ bin: 'git', cwd: directory, args: ['-c', 'core.symlinks=false', ...args], env, signal: input.signal, ...options });
        input.signal?.throwIfAborted();
        if (!result.success) throw new RegistryFetchErrorV1({ state: 'unreachable' });
        return result.stdout;
      }
      // Even local sources use upload-pack so filtering does not copy every object by hardlink.
      await command(cwd, ['clone', '--depth', '1', '--filter=blob:none', '--no-local', '--no-checkout', ...(source.ref && !pinnedRef ? ['--branch', source.ref] : []), '--', source.url, join(cwd, 'repo')]);
      const repoCwd = join(cwd, 'repo');
      const run: Repository['run'] = (args, options) => command(repoCwd, args, options);
      const head = (await run(['rev-parse', 'HEAD'])).trim();
      if (pin && head !== pin) await run(['fetch', '--depth', '1', '--filter=blob:none', 'origin', pin]);
      const commit = (await run(['rev-parse', pin ?? 'HEAD'])).trim();
      return { commit, run };
    }
    function withRepository<T>(source: RegistrySourceV1, version: string | undefined, read: (repository: Repository) => Promise<T>): Promise<T> {
      const key = keyFor(source, version ?? source.ref ?? 'HEAD');
      let repository = repositories.get(key);
      if (!repository) {
        repository = acquireRepository(source, version).then(value => {
          repositories.set(keyFor(source, value.commit), Promise.resolve(value));
          return value;
        });
        repositories.set(key, repository);
      }
      const result = repository.then(read);
      pending.push(result);
      return result;
    }
    async function tree(repository: Repository, path?: string) {
      // Listing names needs trees only. Blob sizes are read only inside the selected folder.
      const output = await repository.run(['ls-tree', '-r', '-z', ...(path === undefined ? [] : ['-l']), repository.commit,
        ...(path ? ['--', `:(literal)${admitPath(path)}/`] : [])]);
      return output.split('\0').filter(Boolean).map(line => { const match = /^(\d+) (\w+) ([a-f0-9]+)(?: +(-|\d+))?\t([\s\S]+)$/.exec(line); if (!match) throw new RegistryFetchErrorV1({ state: 'invalid_source' }); return { mode: match[1]!, type: match[2]!, sha: match[3]!, size: !match[4] || match[4] === '-' ? 0 : Number(match[4]), path: match[5]! }; });
    }
    async function bytes(repository: Repository, path: string, size: number): Promise<Uint8Array> {
      const chunks: Uint8Array[] = [];
      // Git's observed blob size owns this read, not SCM's default diagnostic-output budget.
      await repository.run(['show', `${repository.commit}:${admitPath(path)}`], { maxOutputBytes: Math.max(1, size), stdoutConsumer: chunk => { chunks.push(new Uint8Array(chunk)); return 'continue'; } });
      const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
    }
    const files = async (skill: RegistrySkillSourceV1, source: RegistrySourceV1) => {
      if (skill.ref.kind !== 'gitTree') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const ref = skill.ref;
      return withRepository(source, ref.commit, async repository => {
      const settled = await Promise.allSettled(skill.files.map(async file => {
        const content = await bytes(repository, [ref.path, file.path].filter(Boolean).join('/'), file.size);
        if (computeGitBlobShaV1(content) !== file.blobSha) throw new Error('registry_blob_sha_mismatch'); return { path: file.path, unixMode: file.unixMode, bytes: content };
      }));
      const files: RegistrySkillFileBytesV1[] = settled.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
      if (computeGitTreeShaV1(files) !== ref.treeSha) throw new Error('registry_tree_sha_mismatch'); return files;
    }); };
    const git: GitProtocol = {
      files,
      async list(_ctx, req) {
        return withRepository(req.source, undefined, async repository => {
          const { commit } = repository;
          const root = admitPath(req.source.path ?? ''); const entries = await tree(repository); const query = req.query?.toLowerCase();
          const paths = entries.filter(entry => entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md')).map(entry => entry.path === 'SKILL.md' ? '' : entry.path.slice(0, -9))
            .filter(path => !root || path === root || path.startsWith(root + '/')).map(path => root ? path.slice(root.length).replace(/^\//, '') : path).filter(path => !query || path.toLowerCase().includes(query));
          return { sourceId: req.source.id, status: { state: 'ok', fetchedAt: Date.now() }, nextCursor: null, items: paths.map(path => ({ sourceId: req.source.id, kind: 'skill', itemId: path, title: path.split('/').at(-1) || req.source.title, version: commit })) };
        });
      },
      async read(_ctx, req) {
        return withRepository(req.source, req.version, async repository => {
          const { commit, run } = repository;
          const path = admitPath([req.source.path, req.itemId].filter(Boolean).join('/')); const prefix = path ? path + '/' : '';
          const entries = await tree(repository, path);
          if (!entries.some(entry => entry.path === prefix + 'SKILL.md')) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
          const unsupported = entries.find(entry => entry.mode === '120000' || entry.mode === '160000');
          const treeSha = (await run(['rev-parse', path ? `${commit}:${path}` : `${commit}^{tree}`])).trim();
          const skillMarkdown = unsupported ? '' : new TextDecoder().decode(await bytes(repository, prefix + 'SKILL.md', entries.find(entry => entry.path === prefix + 'SKILL.md')!.size)); const frontmatter = readSkillFrontmatterV1(skillMarkdown);
          return {
            summary: {
              sourceId: req.source.id, kind: 'skill', itemId: req.itemId,
              title: frontmatter.name || req.itemId.split('/').at(-1) || req.source.title,
              description: frontmatter.description, version: commit,
              ...(unsupported ? { problem: { code: 'unsupported_entry' as const, reason: unsupported.mode === '120000' ? 'symlink' as const : 'submodule' as const } } : {}),
            },
            payload: {
              kind: 'skill', skill: {
                ref: { kind: 'gitTree', repo: req.source.url, path, commit, treeSha }, skillMarkdown,
                files: entries.filter(entry => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755'))
                  .map(entry => ({ path: entry.path.slice(prefix.length), size: entry.size, unixMode: entry.mode === '100755' ? 0o755 : 0o644, blobSha: entry.sha })),
              },
            },
            fetchedAt: Date.now(),
          };
        });
      },
      async latest(_ctx, items, options) {
        const result = new Map<string, RegistryContentRefV1 | 'removed'>();
        for (const url of new Set(items.map(item => item.sourceUrl))) {
          const group = items.filter(item => item.sourceUrl === url && item.ref.kind === 'gitTree');
          if (!group.length) continue;
          if (options && options.source.url !== url || group.some(item => item.ref.kind === 'gitTree' && item.ref.repo !== url))
            throw new RegistryFetchErrorV1({ state: 'invalid_source' });
          const source: RegistrySourceV1 = options?.source ?? { id: group[0]!.sourceId, title: url, format: 'git', kinds: ['skill'], url, enabled: true, addedAt: 0 };
          const env = await repositoryEnv(source);
          const pin = source.ref && /^[a-f0-9]{40}$/i.test(source.ref) ? source.ref : undefined;
          const ref = pin ? 'HEAD' : source.ref ?? 'HEAD';
          const advertised = await runScmCommand({ bin: 'git', cwd: tmpdir(), args: ['ls-remote', '--', source.url, ref, ...(ref === 'HEAD' ? [] : [`${ref}^{}`])], env, signal: input.signal });
          if (!advertised.success) throw new RegistryFetchErrorV1({ state: 'unreachable' });
          const references = new Map(advertised.stdout.trim().split(/\r?\n/).flatMap(line => {
            const match = /^([a-f0-9]{40})\s+(\S+)$/.exec(line); return match ? [[match[2]!, match[1]!] as const] : [];
          }));
          const commit = pin ?? references.get(ref) ?? references.get(`refs/heads/${ref}`) ?? references.get(`refs/tags/${ref}^{}`) ?? references.get(`refs/tags/${ref}`);
          if (!commit) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
          const changed = group.filter(item => item.ref.kind === 'gitTree' && item.ref.commit !== commit);
          for (const item of group) if (item.ref.kind === 'gitTree' && item.ref.commit === commit) result.set(item.itemId, item.ref);
          if (!changed.length) continue;
          await withRepository(source, commit, async repository => {
            const { commit: resolved, run } = repository;
            const entries = await tree(repository);
            for (const item of changed) {
              if (item.ref.kind !== 'gitTree') continue;
              const path = admitPath(item.ref.path), skillPath = path ? `${path}/SKILL.md` : 'SKILL.md';
              if (!entries.some(entry => entry.path === skillPath && entry.type === 'blob')) { result.set(item.itemId, 'removed'); continue; }
              const subtree = (await run(['rev-parse', path ? `${resolved}:${path}` : `${resolved}^{tree}`])).trim();
              result.set(item.itemId, { kind: 'gitTree', repo: source.url, path, commit: resolved, treeSha: subtree });
            }
          });
        }
        return result;
      },
    };
    try {
      input.signal?.throwIfAborted();
      const result = await consume(git);
      input.signal?.throwIfAborted();
      return result;
    }
    finally {
      // A parallel reader's failure must not remove the acquisition beneath readers still settling.
      await Promise.allSettled(pending);
      for (const directory of directories) removeHappierTempDir(directory);
    }
  }
  return {
    withOperation,
    list: (...args) => withOperation(git => git.list(...args)),
    read: (...args) => withOperation(git => git.read(...args)),
    files: (...args) => withOperation(git => git.files(...args)),
    latest: (...args) => withOperation(git => git.latest(...args)),
  };
}
