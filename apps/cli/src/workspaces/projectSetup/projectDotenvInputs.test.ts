import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentWorkspaceSource, runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { createProjectDotenvPreparation, readProjectDotenvEnvironment } from './projectDotenv';

describe('private Project dotenv inputs', () => {
    const roots: string[] = [];
    afterEach(async () => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    });
    async function fixture(files: Readonly<Record<string, string>>) {
        const rootPath = await mkdtemp(join(tmpdir(), 'happier-project-dotenv-'));
        roots.push(rootPath);
        await Promise.all(Object.entries(files).map(([file, content]) => writeFile(join(rootPath, file), content)));
        return { rootPath };
    }

    it('projects declared names from the complete file family without mutating the original upstream view', async () => {
        const workspace = await fixture({
            '.env': 'DATABASE_URL=base\nHOST=base\nPRIVATE=private-sentinel\n',
            '.env.development': 'DATABASE_URL=development\nHOST=development\n',
            '.env.local': 'DATABASE_URL=local\n',
            '.env.development.local': 'DATABASE_URL=postgres://${HOST}/app\n',
            '.env.example': 'DATABASE_URL=never-runtime\n',
        });
        const originalEnvironment = { DATABASE_URL: 'upstream-sentinel', UNRELATED: 'kept' };
        const result = await readProjectDotenvEnvironment({ root: workspace.rootPath, declaredNames: ['DATABASE_URL'], originalEnvironment });
        expect(result).toEqual({ kind: 'ready', environment: { DATABASE_URL: 'postgres://development/app' },
            originalEnvironment, sources: [{ name: 'DATABASE_URL', file: '.env.development.local' }] });
        originalEnvironment.DATABASE_URL = 'changed-after-preparation';
        expect(result.kind === 'ready' && result.originalEnvironment.DATABASE_URL).toBe('upstream-sentinel');
    });

    it('uses standard dotenv quoting, multiline values, export, comments and empty values', async () => {
        const workspace = await fixture({ '.env': '# comment\nexport EMPTY=\nQUOTE="a # b" # ignored\nMULTI="line one\nline two"\nESCAPED="first\\nsecond"\nWINDOWS="C:\\\\tools\\\\"\n' });
        const result = await readProjectDotenvEnvironment({ root: workspace.rootPath, declaredNames: ['EMPTY', 'QUOTE', 'MULTI', 'ESCAPED', 'WINDOWS'], originalEnvironment: {} });
        expect(result.kind === 'ready' && result.environment).toEqual({ EMPTY: '', QUOTE: 'a # b', MULTI: 'line one\nline two', ESCAPED: 'first\nsecond', WINDOWS: 'C:\\\\tools\\\\' });
    });

    it('treats missing files as no input and refreshes only on a later demand', async () => {
        const workspace = await fixture({});
        const input = { root: workspace.rootPath, declaredNames: ['VALUE'], originalEnvironment: { VALUE: 'upstream' } };
        const first = await readProjectDotenvEnvironment(input);
        expect(first).toEqual({ kind: 'ready', environment: {}, originalEnvironment: input.originalEnvironment, sources: [] });
        await writeFile(join(workspace.rootPath, '.env.local'), 'VALUE=fresh\n');
        const second = await readProjectDotenvEnvironment(input);
        expect(second.kind === 'ready' && second.environment).toEqual({ VALUE: 'fresh' });
        expect(first.kind === 'ready' && first.environment).toEqual({});
    });

    it('reads each selected file once per demanded preparation, independent of declared name count', async () => {
        const workspace = await fixture({ '.env': 'A=one\nB=two\n', '.env.development': 'A=three\n',
            '.env.local': 'B=four\n', '.env.development.local': 'C=five\n' });
        // Filesystem is the genuine boundary; every observed read still reaches real bytes.
        const source = currentWorkspaceSource();
        const reads = vi.fn((path: string) => source.readFile(path));
        const result = await runWithWorkspaceSource({ ...source, readFile: reads }, () =>
            readProjectDotenvEnvironment({ root: workspace.rootPath, declaredNames: ['A', 'B', 'C'], originalEnvironment: {} }));
        expect(result.kind).toBe('ready');
        expect(reads.mock.calls.map(([path]) => basename(path)).sort()).toEqual(['.env', '.env.development', '.env.development.local', '.env.local']);
    });

    it('performs no filesystem work when no names are declared', async () => {
        const workspace = await fixture({ '.env': 'malformed input is not demanded\n' });
        const source = currentWorkspaceSource();
        const reads = vi.fn((path: string) => source.readFile(path));
        const paths = vi.fn((path: string) => source.realpath(path));
        const result = await runWithWorkspaceSource({ ...source, readFile: reads, realpath: paths }, () =>
            readProjectDotenvEnvironment({ root: workspace.rootPath, declaredNames: [], originalEnvironment: { UPSTREAM: 'preserved' } }));
        expect(result).toEqual({ kind: 'ready', environment: {}, originalEnvironment: { UPSTREAM: 'preserved' }, sources: [] });
        expect(reads).not.toHaveBeenCalled();
        expect(paths).not.toHaveBeenCalled();
    });

    it('captures the admitted source and original environment and shares concurrent snapshot reads', async () => {
        const workspace = await fixture({ '.env': 'A=one\nB=two\n', '.env.development': '', '.env.local': '', '.env.development.local': '' });
        const source = currentWorkspaceSource();
        const reads: string[] = [];
        const originalEnvironment = { UPSTREAM: 'before' };
        const prepared = runWithWorkspaceSource({ ...source, async readFile(path) {
            reads.push(path);
            return source.readFile(path);
        } }, () => createProjectDotenvPreparation(workspace.rootPath, originalEnvironment));
        originalEnvironment.UPSTREAM = 'after';
        const results = await Promise.all([prepared.read(['A']), prepared.read(['B'])]);
        expect(results).toEqual([
            { kind: 'ready', environment: { A: 'one' }, originalEnvironment: { UPSTREAM: 'before' }, sources: [{ name: 'A', file: '.env' }] },
            { kind: 'ready', environment: { B: 'two' }, originalEnvironment: { UPSTREAM: 'before' }, sources: [{ name: 'B', file: '.env' }] },
        ]);
        const selectedUpstream = { UPSTREAM: 'selected' };
        const selected = await prepared.read(['A'], selectedUpstream);
        selectedUpstream.UPSTREAM = 'changed';
        expect(selected.kind === 'ready' && selected.originalEnvironment).toEqual({ UPSTREAM: 'selected' });
        const next = await prepared.read(['A']);
        expect(next.kind === 'ready' && next.originalEnvironment).toEqual({ UPSTREAM: 'before' });
        expect(reads.map(path => basename(path))).toEqual(['.env', '.env.development', '.env.local', '.env.development.local']);
    });

    it.each([
        ['missing', 'URL=postgres://${HOST}/db\n'],
        ['cycle', 'URL=${OTHER}\nOTHER=${URL}\n'],
        ['unsupported', 'URL=${HOST:-localhost}\n'],
    ])('reports %s references without using ambient or upstream environment', async (_kind, content) => {
        vi.stubEnv('HOST', 'ambient-secret-sentinel');
        const workspace = await fixture({ '.env': content });
        const result = await readProjectDotenvEnvironment({ root: workspace.rootPath, declaredNames: ['URL'], originalEnvironment: { HOST: 'upstream-secret-sentinel' } });
        expect(result).toEqual({ kind: 'refused', code: 'project_environment_binding_unavailable', diagnostics: [{ code: 'unresolved_dotenv_reference', file: '.env', name: 'URL' }] });
        expect(JSON.stringify(result)).not.toContain('sentinel');
    });

    it('keeps shell syntax literal and ignores undeclared unresolved values', async () => {
        const workspace = await fixture({ '.env': 'VALUE=$(printf injected) $AMBIENT `whoami`\nUNDECLARED=${MISSING}\n' });
        const result = await readProjectDotenvEnvironment({ root: workspace.rootPath, declaredNames: ['VALUE'], originalEnvironment: {} });
        expect(result.kind === 'ready' && result.environment).toEqual({ VALUE: '$(printf injected) $AMBIENT `whoami`' });
    });

    it('keeps concurrent worktree inputs separate', async () => {
        const [first, second] = await Promise.all([fixture({ '.env': 'VALUE=first-private\n' }), fixture({ '.env': 'VALUE=second-private\n' })]);
        const results = await Promise.all([first, second].map(workspace => readProjectDotenvEnvironment({ root: workspace.rootPath, declaredNames: ['VALUE'], originalEnvironment: {} })));
        expect(results.map(result => result.kind === 'ready' && result.environment)).toEqual([{ VALUE: 'first-private' }, { VALUE: 'second-private' }]);
    });

    it.each(['VALUE="secret-sentinel\n', 'VALUE secret-sentinel\n', 'VALUE=secret\0sentinel\n'])('rejects malformed selected input without exposing raw bytes', async content => {
        const workspace = await fixture({ '.env.local': content });
        const result = await readProjectDotenvEnvironment({ root: workspace.rootPath, declaredNames: ['VALUE'], originalEnvironment: {} });
        expect(result).toMatchObject({ kind: 'refused', diagnostics: [{ code: 'malformed_dotenv', file: '.env.local' }] });
        expect(JSON.stringify(result)).not.toContain('sentinel');
    });

    it('allows contained links and refuses a selected file linked outside the admitted worktree', async () => {
        const workspace = await fixture({});
        await mkdir(join(workspace.rootPath, 'private'));
        await writeFile(join(workspace.rootPath, 'private', 'values'), 'VALUE=inside\n');
        await symlink(join(workspace.rootPath, 'private', 'values'), join(workspace.rootPath, '.env'));
        const input = { root: workspace.rootPath, declaredNames: ['VALUE'], originalEnvironment: {} };
        expect((await readProjectDotenvEnvironment(input)).kind).toBe('ready');
        const outside = await fixture({ values: 'VALUE=outside-secret-sentinel\n' });
        await symlink(join(outside.rootPath, 'values'), join(workspace.rootPath, '.env.local'));
        expect(await readProjectDotenvEnvironment(input)).toEqual({ kind: 'refused', code: 'project_environment_binding_unavailable', diagnostics: [{ code: 'outside_root', file: '.env.local' }] });
    });

    it('returns an unreadable selected source as unavailable rather than silently dropping it', async () => {
        const workspace = await fixture({});
        await mkdir(join(workspace.rootPath, '.env'));
        expect(await readProjectDotenvEnvironment({ root: workspace.rootPath, declaredNames: ['VALUE'], originalEnvironment: {} }))
            .toEqual({ kind: 'refused', code: 'project_environment_binding_unavailable', diagnostics: [{ code: 'unreadable_definition', file: '.env' }] });
    });
});
