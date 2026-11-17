import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { currentWorkspaceSource, runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { createProjectDotenvPreparation, readProjectDotenvEnvironment, inspectProjectEnvironmentImport } from './projectDotenv';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'project-dotenv-')); roots.push(path); return path; }

it('reads the selected file family once, resolves family references and projects declared names only', async () => {
    const path = await root();
    await writeFile(join(path, '.env'), 'HOST=localhost\nURL=postgres://${HOST}/db\nTOKEN=private\n');
    await writeFile(join(path, '.env.development'), 'HOST=development\n');
    await writeFile(join(path, '.env.local'), 'HOST=local\n');
    await writeFile(join(path, '.env.development.local'), 'HOST=last\n');
    const source = currentWorkspaceSource();
    const reads: string[] = [];
    const prepared = await runWithWorkspaceSource({ ...source, async readFile(file) { reads.push(file); return source.readFile(file); } },
        () => readProjectDotenvEnvironment({ root: path, declaredNames: ['URL'] }));
    expect(prepared).toMatchObject({ kind: 'ready', environment: { URL: 'postgres://last/db' } });
    expect(reads.map(file => file.slice(path.length + 1))).toEqual(['.env', '.env.development', '.env.local', '.env.development.local']);
    expect(JSON.stringify(prepared)).not.toContain('private');
});

it('refuses selected unresolved references without ambient expansion or value disclosure', async () => {
    const path = await root();
    await writeFile(join(path, '.env'), 'URL=private-sentinel-${UNBOUND}\nOTHER=${IGNORED}\n');
    expect(await readProjectDotenvEnvironment({ root: path, declaredNames: ['URL'] })).toEqual({ kind: 'refused',
        code: 'project_environment_binding_unavailable', diagnostics: [{ file: '.env', name: 'URL', code: 'unresolved_dotenv_reference' }] });
});

it('reuses one private file snapshot across consumers within a preparation and refreshes on the next demand', async () => {
    const path = await root();
    for (const file of ['.env', '.env.development', '.env.local', '.env.development.local']) {
        await writeFile(join(path, file), 'URL=original\nMODE=development\n');
    }
    const source = currentWorkspaceSource();
    const reads: string[] = [];
    const selected = { ...source, async readFile(file: string) { reads.push(file); return source.readFile(file); } };
    await runWithWorkspaceSource(selected, async () => {
        const prepared = createProjectDotenvPreparation(path);
        expect(await prepared.read(['URL'])).toMatchObject({ kind: 'ready', environment: { URL: 'original' } });
        await writeFile(join(path, '.env.development.local'), 'URL=changed\nMODE=production\n');
        expect(await prepared.read(['MODE'])).toMatchObject({ kind: 'ready', environment: { MODE: 'development' } });
        expect(reads).toHaveLength(4);
        expect(await readProjectDotenvEnvironment({ root: path, declaredNames: ['URL'] }))
            .toMatchObject({ kind: 'ready', environment: { URL: 'changed' } });
        expect(reads).toHaveLength(8);
    });
});

it('refuses an escaping file link but admits an ordinary contained file and missing optional files', async () => {
    const path = await root();
    const outside = await root();
    await writeFile(join(outside, '.env'), 'URL=outside-private\n');
    await symlink(join(outside, '.env'), join(path, '.env'));
    expect(await readProjectDotenvEnvironment({ root: path, declaredNames: ['URL'] })).toMatchObject({ kind: 'refused',
        diagnostics: [{ file: '.env', code: 'outside_root' }] });
    expect(await readProjectDotenvEnvironment({ root: outside, declaredNames: ['URL'] })).toMatchObject({ kind: 'ready', environment: { URL: 'outside-private' } });
});

it('imports names without interpolation or example literals and reports skipped malformed lines', async () => {
    const path = await root();
    await writeFile(join(path, '.env.example'), 'TOKEN=secret-sentinel\nURL=${TOKEN}\nINVALID LINE\nTOKEN=last\n');
    const imported = await inspectProjectEnvironmentImport(path);
    expect(imported).toEqual({ kind: 'environment', file: '.env.example', requirements: [
        { name: 'TOKEN', kind: 'config', required: false }, { name: 'URL', kind: 'config', required: false },
    ], diagnostics: [{ line: 3, code: 'malformed_dotenv' }] });
});

it('does no dotenv read without a declared consumer and preserves standard quoted multiline values', async () => {
    const path = await root();
    await writeFile(join(path, '.env'), 'VALUE="line one\nline two"\nUNUSED=${MISSING}\n');
    const source = currentWorkspaceSource();
    const reads: string[] = [];
    const selected = { ...source, async readFile(file: string) { reads.push(file); return source.readFile(file); } };
    expect(await runWithWorkspaceSource(selected, () => readProjectDotenvEnvironment({ root: path, declaredNames: [] })))
        .toMatchObject({ kind: 'ready', environment: {} });
    expect(reads).toEqual([]);
    expect(await readProjectDotenvEnvironment({ root: path, declaredNames: ['VALUE'] }))
        .toMatchObject({ kind: 'ready', environment: { VALUE: 'line one\nline two' } });
});
