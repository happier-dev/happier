import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { createSkillStore, type SkillSessionDirItem } from './skillStore';

// Count materialization at the OS boundary without replacing store logic or filesystem behavior.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, cp: vi.fn(actual.cp), lstat: vi.fn(actual.lstat), readdir: vi.fn(actual.readdir) };
});

const scratch: string[] = [];
const pendingReadCleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of pendingReadCleanup.splice(0)) await cleanup();
    for (const root of scratch.splice(0)) {
        // The fixture deliberately contains read-only immutable trees.
        const writable = async (path: string): Promise<void> => {
            const info = await lstat(path);
            if (info.isSymbolicLink()) return;
            await chmod(path, info.isDirectory() ? 0o755 : 0o644);
            if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
        };
        await writable(root);
        await rm(root, { recursive: true, force: true });
    }
});
function skill(name = 'guide', content = name === 'guide' ? 'Use the guide' : `Use ${name}`): SkillSessionDirItem {
    const files = [
        { path: 'SKILL.md', contentKind: 'utf8' as const, contentBase64: Buffer.from(content).toString('base64') },
        { path: 'scripts/run.sh', contentKind: 'utf8' as const, contentBase64: Buffer.from('#!/bin/sh\necho guide\n').toString('base64'), unixMode: 0o755 },
    ];
    return { skillId: `skill:${name}`, name, files, digest: computePromptBundleDigestV1({ v: 1, entries: files, createdAtMs: 0, updatedAtMs: 0 }) };
}
async function fixture(platform: NodeJS.Platform = process.platform) {
    const happyHomeDir = await realpath(await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-')));
    scratch.push(happyHomeDir);
    const store = createSkillStore({ happyHomeDir, platform });
    const ensure = (ownerKey: string, items = [skill()]) => store.ensureSkillSessionDir({ ownerKey, items, nativeDisables: [] });
    const cachePath = (item: SkillSessionDirItem) => join(happyHomeDir, 'skills', 'cache', item.digest.slice(7));
    return { happyHomeDir, store, ensure, cachePath };
}
describe('daemon skill store', () => {
    it.each([
        { mode: 'default', platform: process.platform, materialization: undefined },
        { mode: 'copy', platform: process.platform, materialization: 'copy' as const },
        { mode: 'win32', platform: 'win32' as const, materialization: undefined },
    ])('materializes only a changed or damaged skill among 139 delivered items ($mode)', async ({ mode, platform, materialization }) => {
        const f = await fixture(platform);
        const withSupport = (name: string, content?: string): SkillSessionDirItem => {
            const item = skill(name, content);
            const files = [...item.files, { path: 'helper.txt', contentKind: 'utf8' as const,
                contentBase64: Buffer.from('Support fixture').toString('base64') }];
            return { ...item, files, digest: computePromptBundleDigestV1({ v: 1, entries: files, createdAtMs: 0, updatedAtMs: 0 }) };
        };
        const items = Array.from({ length: 139 }, (_, index) => withSupport(`guide-${index}`));
        items[2] = { ...items[2]!, sourceFolderName: 'kept-support-source' };
        const ensure = () => f.store.ensureSkillSessionDir({ ownerKey: 'session-one', items, nativeDisables: [], materialization });
        const result = await ensure();
        const unchangedEntry = join(result.skillsRoot, items[1]!.name, 'SKILL.md');
        const unchangedBefore = await stat(unchangedEntry);
        const copies = vi.mocked(fs.cp);
        const metadataReads = vi.mocked(fs.lstat);
        const directoryReads = vi.mocked(fs.readdir);
        copies.mockClear();
        metadataReads.mockClear(); directoryReads.mockClear();
        await ensure();
        expect(copies.mock.calls).toHaveLength(0);
        // Report the real metadata-read cost; only materialization counts are gated.
        console.info('[skill-store reuse cost]', JSON.stringify({ mode, skills: items.length,
            declaredEntries: items.reduce((sum, item) => sum + item.files.length, 0),
            lstat: metadataReads.mock.calls.length, readdir: directoryReads.mock.calls.length,
            deliveredPathLstat: metadataReads.mock.calls.filter(([path]) => String(path).startsWith(result.skillsRoot + '/')).length }));
        copies.mockClear();
        items[0] = withSupport(items[0]!.name, 'Changed guide');
        await ensure();
        expect(copies.mock.calls).toHaveLength(1);
        expect(await readFile(join(result.skillsRoot, items[0]!.name, 'SKILL.md'), 'utf8')).toBe('Changed guide');
        expect((await stat(unchangedEntry)).mtimeMs).toBe(unchangedBefore.mtimeMs);
        const damagedDirectory = result.items[2]!.directory;
        const support = join(damagedDirectory, 'helper.txt');
        await chmod(damagedDirectory, 0o700);
        if (!(await lstat(support)).isSymbolicLink()) await chmod(support, 0o600);
        await unlink(support);
        await chmod(damagedDirectory, 0o555);
        items[0] = withSupport(items[0]!.name, 'Changed while sibling support is missing');
        copies.mockClear();
        const repaired = await ensure();
        expect(repaired.failed).toEqual([]);
        expect(copies.mock.calls).toHaveLength(2);
        expect(await readFile(support, 'utf8')).toBe('Support fixture');
        expect((await lstat(join(damagedDirectory, 'SKILL.md'))).isFile()).toBe(true);
        expect((await stat(unchangedEntry)).mtimeMs).toBe(unchangedBefore.mtimeMs);
        await chmod(damagedDirectory, 0o700);
        if (!(await lstat(support)).isSymbolicLink()) await chmod(support, 0o600);
        await unlink(support);
        await mkdir(support);
        await chmod(damagedDirectory, 0o555);
        copies.mockClear();
        await ensure();
        expect(copies.mock.calls).toHaveLength(1);
        expect(await readFile(support, 'utf8')).toBe('Support fixture');
        await chmod(damagedDirectory, 0o700);
        await chmod(join(damagedDirectory, 'SKILL.md'), 0o600);
        await unlink(join(damagedDirectory, 'SKILL.md'));
        copies.mockClear();
        await ensure();
        expect(copies.mock.calls).toHaveLength(1);
        expect(await readFile(join(damagedDirectory, 'SKILL.md'), 'utf8')).toBe('Use guide-2');
        copies.mockClear();
        await ensure();
        expect(copies.mock.calls).toHaveLength(0);
        await chmod(result.skillsRoot, 0o700);
        await mkdir(join(result.skillsRoot, 'orphan'));
        await chmod(result.skillsRoot, 0o555);
        await ensure();
        expect(copies.mock.calls).toHaveLength(0);
        expect(await readdir(result.skillsRoot)).toHaveLength(items.length);
    });
    it('shares immutable cache entries, preserves executable bits and makes repeated ensure a no-op', async () => {
        const f = await fixture();
        const item = skill();
        const first = await f.ensure('session-one');
        const before = await stat(join(first.pluginRoot, 'session.json'));
        const again = await f.ensure('session-one');
        const other = await f.ensure('session-two');
        expect(again).toEqual(first);
        expect((await stat(join(first.pluginRoot, 'session.json'))).mtimeMs).toBe(before.mtimeMs);
        expect(await readdir(join(f.happyHomeDir, 'skills', 'cache'))).toEqual([item.digest.slice(7)]);
        expect(await readFile(join(other.skillsRoot, 'guide', 'scripts', 'run.sh'), 'utf8')).toContain('echo guide');
        if (process.platform !== 'win32') {
            expect((await stat(f.cachePath(item))).mode & 0o777).toBe(0o555);
            expect((await stat(join(f.cachePath(item), 'SKILL.md'))).mode & 0o777).toBe(0o444);
            expect((await stat(join(f.cachePath(item), 'scripts', 'run.sh'))).mode & 0o777).toBe(0o555);
            expect((await lstat(join(first.skillsRoot, 'guide'))).isDirectory()).toBe(true);
            expect((await lstat(join(first.skillsRoot, 'guide', 'SKILL.md'))).isFile()).toBe(true);
        }
    });
    it('updates links and session manifest in the same folder and serializes concurrent writes', async () => {
        const f = await fixture();
        const initial = await f.ensure('session-one');
        const next = skill('guide', 'Updated guide');
        await Promise.all([f.ensure('session-one', [skill('other')]), f.ensure('session-one', [next])]);
        expect(await readdir(initial.skillsRoot)).toEqual(['guide']);
        expect(await readFile(join(initial.skillsRoot, 'guide', 'SKILL.md'), 'utf8')).toBe('Updated guide');
        expect(JSON.parse(await readFile(join(initial.pluginRoot, 'session.json'), 'utf8'))).toMatchObject({ items: [{ skillId: next.skillId, name: next.name, digest: next.digest }] });
    });
    it('delivers each skill under its own name so a sibling reference resolves to the sibling skill', async () => {
        const f = await fixture();
        const { skillsRoot } = await f.ensure('session-one', [skill('prisma-cli', 'Set up with [the ORM guide](../prisma-orm-setup/SKILL.md)'), skill('prisma-orm-setup')]);
        expect(await readdir(skillsRoot)).toEqual(['prisma-cli', 'prisma-orm-setup']);
        // The relative link as written in prisma-cli's SKILL.md, followed by the operating system from where that file is delivered.
        expect(await readFile(join(skillsRoot, 'prisma-cli', '..', 'prisma-orm-setup', 'SKILL.md'), 'utf8')).toBe('Use prisma-orm-setup');
        expect(await readFile(`${skillsRoot}/prisma-cli/../prisma-orm-setup/SKILL.md`, 'utf8')).toBe('Use prisma-orm-setup');
    });
    it('uses read-only real copies on Windows', async () => {
        const f = await fixture('win32');
        const sibling = { ...skill('declared-b'), sourceFolderName: 'source-b' };
        const result = await f.ensure('session-one', [skill(), sibling]);
        expect((await lstat(join(result.skillsRoot, 'guide'))).isSymbolicLink()).toBe(false);
        expect(await readFile(join(result.skillsRoot, 'guide', 'SKILL.md'), 'utf8')).toBe('Use the guide');
        expect(await readFile(join(result.skillsRoot, 'source-b', 'SKILL.md'), 'utf8')).toBe('Use declared-b');
        const before = await stat(join(result.pluginRoot, 'session.json'));
        await f.ensure('session-one', [skill(), sibling]);
        expect((await stat(join(result.pluginRoot, 'session.json'))).mtimeMs).toBe(before.mtimeMs);
        await f.store.releaseSkillSessionDirs('session-one');
        await expect(lstat(result.pluginRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('publishes discoverable entrypoint files at source folders and repairs old linked entrypoints', async () => {
        const f = await fixture();
        const first = { ...skill('declared-a', 'Read ../source-b/SKILL.md'), sourceFolderName: 'source-a' };
        const sibling = { ...skill('declared-b', 'Read scripts/run.sh'), sourceFolderName: 'source-b' };
        const result = await f.ensure('session-one', [first, sibling]);
        const entry = join(result.items[0]!.directory, 'SKILL.md');
        expect((await lstat(entry)).isFile()).toBe(true);
        expect(result.items.map(item => item.directory)).toEqual([join(result.skillsRoot, 'source-a'), join(result.skillsRoot, 'source-b')]);
        expect(await readFile(join(result.items[0]!.directory, '..', 'source-b', 'SKILL.md'), 'utf8')).toBe('Read scripts/run.sh');
        expect(await readFile(join(result.items[1]!.directory, 'scripts', 'run.sh'), 'utf8')).toContain('echo guide');
        if (process.platform !== 'win32') {
            await chmod(result.items[0]!.directory, 0o700);
            await unlink(entry);
            await symlink(join(f.cachePath(first), 'SKILL.md'), entry);
            await chmod(result.items[0]!.directory, 0o555);
            await f.ensure('session-one', [first, sibling]);
            expect((await lstat(entry)).isFile()).toBe(true);
            expect(await readFile(entry, 'utf8')).toBe('Read ../source-b/SKILL.md');
            await f.store.ensureSkillSessionDir({ ownerKey: 'session-one', items: [first, sibling], nativeDisables: [], materialization: 'copy' });
            expect((await lstat(join(result.items[1]!.directory, 'scripts'))).isDirectory()).toBe(true);
            expect(await readFile(join(result.items[1]!.directory, 'scripts', 'run.sh'), 'utf8')).toContain('echo guide');
        }
    });
    it('rejects tampered bodies before publication and isolates a staging filesystem failure per item', async () => {
        const f = await fixture();
        const invalid = { ...skill('invalid'), digest: `sha256:${'a'.repeat(64)}` };
        const broken = skill('broken');
        broken.files.push({ path: 'SKILL.md/child', contentKind: 'utf8', contentBase64: Buffer.from('cannot be written under a file').toString('base64') });
        const brokenItem = { ...broken, digest: computePromptBundleDigestV1({ v: 1, entries: broken.files, createdAtMs: 0, updatedAtMs: 0 }) };
        const result = await f.ensure('session-one', [invalid, brokenItem, skill('valid')]);
        expect(result.failed).toMatchObject([{ skillId: invalid.skillId, reason: 'materialize_failed', detail: 'digest_mismatch' }, { skillId: broken.skillId, reason: 'materialize_failed' }]);
        expect(await readdir(result.skillsRoot)).toEqual(['valid']);
        expect(await readdir(join(f.happyHomeDir, 'skills', 'cache'))).toEqual([skill('valid').digest.slice(7)]);
    });
    it('refuses a source folder that could escape the Session skills root before writing', async () => {
        const f = await fixture();
        for (const sourceFolderName of ['..', '../outside', '..\\outside', '/outside', '.']) {
            await expect(f.ensure('session-one', [{ ...skill(), sourceFolderName }])).rejects.toThrow();
        }
        await expect(lstat(join(f.happyHomeDir, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('roots GC in session and Run manifests plus a successful library inventory', async () => {
        const f = await fixture();
        const session = skill('session'); const run = skill('run'); const library = skill('library'); const unused = skill('unused');
        await f.ensure('session-one', [session]);
        await f.ensure('session-one/runs/run-one', [run]);
        const independentRun = skill('independent-run');
        await f.ensure('index-parent/runs/run-only', [independentRun]);
        await f.ensure('retired', [library, unused]);
        await f.store.releaseSkillSessionDirs('retired');
        const staging = join(f.happyHomeDir, 'skills', 'cache', '.staging-interrupted');
        await mkdir(staging);
        await writeFile(join(staging, 'partial'), 'partial');
        await f.store.collectSkillCache({ libraryDigests: null });
        expect(await lstat(f.cachePath(unused))).toBeDefined();
        expect(await lstat(staging)).toBeDefined();
        await f.store.collectSkillCache({ libraryDigests: [library.digest] });
        expect(await readdir(join(f.happyHomeDir, 'skills', 'cache'))).toEqual(expect.arrayContaining([session.digest.slice(7), run.digest.slice(7), library.digest.slice(7)]));
        await expect(lstat(f.cachePath(unused))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
        const roots = await f.store.readLiveSkillCachePaths();
        expect(roots.reliable).toBe(true);
        expect(roots.paths.has(f.cachePath(session))).toBe(true);
        expect(roots.paths.has(f.cachePath(run))).toBe(true);
        expect(roots.paths.has(f.cachePath(independentRun))).toBe(true);
    });
    it('does not block ensure on external GC reads and sweeps using the latest Session and Run manifests', async () => {
        const f = await fixture();
        let entered!: () => void;
        let release!: () => void;
        const readEntered = new Promise<void>(resolve => { entered = resolve; });
        const externalRead = new Promise<void>(resolve => { release = resolve; });
        let readFinished = false;
        let readUnavailable = false;
        const store = createSkillStore({ happyHomeDir: f.happyHomeDir,
            // The Account library read is an external service boundary; its response is held open.
            readLibraryDigests: async () => {
                if (readUnavailable) throw new Error('Account library is unavailable');
                entered(); await externalRead; readFinished = true; return [];
            } });
        const unused = skill('unused');
        await store.ensureSkillSessionDir({ ownerKey: 'retired', items: [unused], nativeDisables: [] });
        await store.releaseSkillSessionDirs('retired');
        const collection = store.collectSkillCache();
        await readEntered;
        const live = skill('live'); const run = skill('live-run');
        const sessionEnsure = store.ensureSkillSessionDir({ ownerKey: 'live', items: [live], nativeDisables: [] });
        const runEnsure = store.ensureSkillSessionDir({ ownerKey: 'live/runs/run-one', items: [run], nativeDisables: [] });
        const cleanup = async () => { release(); await Promise.allSettled([collection, sessionEnsure, runEnsure]); };
        pendingReadCleanup.push(cleanup);
        try {
            await Promise.all([sessionEnsure, runEnsure]);
            expect(readFinished).toBe(false);
            release(); await collection;
            expect(await readFile(join(f.cachePath(live), 'SKILL.md'), 'utf8')).toBe('Use live');
            expect(await readFile(join(f.cachePath(run), 'SKILL.md'), 'utf8')).toBe('Use live-run');
            await expect(lstat(f.cachePath(unused))).rejects.toMatchObject({ code: 'ENOENT' });
            const stale = await store.ensureSkillSessionDir({ ownerKey: 'stale', items: [unused], nativeDisables: [] });
            const libraryOnly = skill('library-only');
            await store.ensureSkillSessionDir({ ownerKey: 'library-only', items: [libraryOnly], nativeDisables: [] });
            await store.releaseSkillSessionDirs('library-only');
            readUnavailable = true;
            await store.collectSkillCache();
            await store.reconcileSkillSessionDirs({ liveSessionIds: ['live'] });
            expect(await lstat(stale.pluginRoot)).toBeDefined();
            expect(await lstat(f.cachePath(unused))).toBeDefined();
            expect(await lstat(f.cachePath(libraryOnly))).toBeDefined();
        } finally { await cleanup(); }
    });
    it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('isolates an unwritable staging parent without publishing partial cache content', async () => {
        const f = await fixture();
        const cache = join(f.happyHomeDir, 'skills', 'cache');
        await mkdir(cache, { recursive: true });
        await chmod(cache, 0o555);
        try {
            const result = await f.ensure('session-one');
            expect(result.failed).toEqual([{ skillId: skill().skillId, reason: 'materialize_failed', detail: 'EACCES' }]);
            expect(await readdir(cache)).toEqual([]);
            expect(await readdir(result.skillsRoot)).toEqual([]);
        } finally { await chmod(cache, 0o700); }
    });
    it('retains everything when a session manifest or live inventory is unreadable', async () => {
        const f = await fixture();
        const session = await f.ensure('session-one');
        await chmod(join(session.pluginRoot, 'session.json'), 0o600);
        await writeFile(join(session.pluginRoot, 'session.json'), '{bad');
        expect((await f.store.readLiveSkillCachePaths()).reliable).toBe(false);
        await f.store.collectSkillCache({ libraryDigests: [] });
        expect(await lstat(f.cachePath(skill()))).toBeDefined();
        await f.store.reconcileSkillSessionDirs({ liveSessionIds: null, libraryDigests: [] });
        expect(await lstat(session.pluginRoot)).toBeDefined();
    });
    it('sweeps stale session folders after re-adoption, including their Runs, and keeps tracked sessions', async () => {
        const f = await fixture();
        const live = await f.ensure('live'); const stale = await f.ensure('stale');
        await f.ensure('stale/runs/run-one', [skill('run')]);
        await f.store.reconcileSkillSessionDirs({ liveSessionIds: ['live'], libraryDigests: null });
        expect(await lstat(stale.pluginRoot)).toBeDefined();
        await f.store.reconcileSkillSessionDirs({ liveSessionIds: ['live'], libraryDigests: [] });
        expect(await lstat(live.pluginRoot)).toBeDefined();
        await expect(lstat(stale.pluginRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
