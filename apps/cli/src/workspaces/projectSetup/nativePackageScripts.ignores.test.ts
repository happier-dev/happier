import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';

const listed = vi.hoisted(() => ({ directories: [] as string[] }));
// Observe directory reads while exercising the real walk and real Git.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readdir: (...args: Parameters<typeof actual.readdir>) => {
        listed.directories.push(String(args[0]));
        return actual.readdir(...args);
    } };
});

import { collectNativePackageDirectories } from './nativePackageScripts';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function gitRegistry() {
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime) throw new Error('Git SCM registration must declare its executable definition');
    return createScmBackendRegistry([createRegisteredScmBackendAdapter({
        definition: { id: 'git' }, qualifiedId: 'test:git', executableDefinition: registration.runtime, registration,
    })]);
}

async function packageTree(root: string, relativeDirectories: readonly string[]): Promise<void> {
    for (const directory of relativeDirectories) {
        await mkdir(join(root, directory), { recursive: true });
        await writeFile(join(root, directory, 'package.json'), '{"scripts":{"dev":"vite"}}');
    }
}

it('skips package trees the repository ignores, as Git applies its exclude sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-package-ignores-'));
    temporary.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const ignoredPackages = Array.from({ length: 40 }, (_, index) => `.project/tmp/lane-${index}/app`);
    await packageTree(root, ['.', 'apps/web', 'apps/web/scratch', 'vendor/kept', 'vendor/excluded', ...ignoredPackages]);
    await packageTree(root, ['.project/plans/tracked']);
    await writeFile(join(root, '.gitignore'), '**/.project/\napps/web/scratch/\n');
    // `.git/info/exclude` is one of Git's standard exclude sources, not a .gitignore file.
    await writeFile(join(root, '.git', 'info', 'exclude'), 'vendor/excluded/\n');
    // A force-added package inside an ignored folder is tracked source and stays listed.
    execFileSync('git', ['add', '-f', '.project/plans/tracked/package.json'], { cwd: root });

    listed.directories.length = 0;
    const packages = await collectNativePackageDirectories(root, { scmRegistry: gitRegistry() });

    expect(packages.map(directory => directory.slice(root.length).replaceAll('\\', '/')).sort())
        .toEqual(['', '/.project/plans/tracked', '/apps/web', '/vendor/kept']);
    // Ignored trees are never opened: 40 ignored lanes cost no directory reads.
    expect(listed.directories.filter(directory => directory.includes('lane-')).length).toBe(0);
});

it('keeps the full walk for a folder that is not a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-package-plain-'));
    temporary.push(root);
    await packageTree(root, ['.', '.project/tmp/a']);
    await writeFile(join(root, '.gitignore'), '**/.project/\n');

    const packages = await collectNativePackageDirectories(root, { scmRegistry: gitRegistry() });

    expect(packages.map(directory => directory.slice(root.length).replaceAll('\\', '/')).sort()).toEqual(['', '/.project/tmp/a']);
});

it('keeps the full walk and warns once per root when Git cannot list ignored paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-package-ignore-failure-'));
    temporary.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    await packageTree(root, ['.', '.project/tmp/a']);
    await writeFile(join(root, '.gitignore'), '**/.project/\n');
    // Git still finds the repository but refuses to list it (as for a `safe.directory` refusal).
    await writeFile(join(root, '.git', 'index'), 'not-an-index');
    const warnings = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
        for (let read = 0; read < 2; read += 1) {
            const packages = await collectNativePackageDirectories(root, { scmRegistry: gitRegistry() });
            expect(packages.map(directory => directory.slice(root.length).replaceAll('\\', '/')).sort()).toEqual(['', '/.project/tmp/a']);
        }
        expect(warnings).toHaveBeenCalledOnce();
        expect(warnings.mock.calls[0]?.[1]).toMatchObject({ errorCode: expect.any(String) });
    } finally { warnings.mockRestore(); }
});

it('does not warn for a folder that is not a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-package-plain-quiet-'));
    temporary.push(root);
    await packageTree(root, ['.']);
    const warnings = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
        await collectNativePackageDirectories(root, { scmRegistry: gitRegistry() });
        expect(warnings).not.toHaveBeenCalled();
    } finally { warnings.mockRestore(); }
});
