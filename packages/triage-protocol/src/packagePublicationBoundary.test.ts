import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const packageDirectory = new URL('../', import.meta.url);
const packageRoot = fileURLToPath(packageDirectory);

type PackageManifest = Readonly<{
    name?: string;
    private?: boolean;
    exports?: Record<string, unknown>;
    files?: readonly string[];
    dependencies?: Readonly<Record<string, string>>;
    peerDependencies?: Readonly<Record<string, string>>;
    bundledDependencies?: readonly string[];
}>;

async function readManifest(url: URL): Promise<PackageManifest> {
    return JSON.parse(await readFile(url, 'utf8')) as PackageManifest;
}

/**
 * Every module path an installed consumer can reach through the export map,
 * both conditions of every subpath.
 *
 * The declaration path matters as much as the runtime one: a tarball that
 * carried `dist/**\/*.js` and no `.d.ts` resolves at runtime and fails at
 * `tsc`, which is the half an existence check on the working tree cannot see.
 */
function exportTargets(manifest: PackageManifest): readonly string[] {
    const targets: string[] = [];
    for (const condition of Object.values(manifest.exports ?? {})) {
        for (const target of Object.values(condition as Record<string, unknown>)) {
            if (typeof target === 'string') targets.push(target.replace(/^\.\//u, ''));
        }
    }
    return [...new Set(targets)].sort();
}

/**
 * The real packed file list, from npm's own packing rules.
 *
 * `--dry-run` still runs the full selection — `files`, `.npmignore`, and npm's
 * always-included set — so this is the tarball's manifest without writing one.
 * Modelling those rules locally instead is how a `files` entry that publishes
 * nothing passes its own producer's test.
 */
async function packedFilePaths(): Promise<readonly string[]> {
    const { stdout } = await execFileAsync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['pack', '--dry-run', '--json', '--ignore-scripts'],
        { cwd: packageRoot, timeout: 120_000, maxBuffer: 8_000_000, windowsHide: true },
    );
    const packed = JSON.parse(stdout) as readonly Readonly<{
        files?: readonly Readonly<{ path?: string }>[];
    }>[];
    return (packed[0]?.files ?? [])
        .map((file) => file.path ?? '')
        .filter((path) => path.length > 0);
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(new URL(path, packageDirectory));
        return true;
    } catch {
        return false;
    }
}

describe('Triage protocol publication boundary', () => {
    it('is publishable and contains exactly the explicit root, V1, and testing-V1 entrypoints', async () => {
        const packageJson = JSON.parse(await readFile(
            new URL('package.json', packageDirectory),
            'utf8',
        )) as Readonly<{
            name?: string;
            private?: boolean;
            exports?: Record<string, unknown>;
            files?: readonly string[];
        }>;

        expect(packageJson.name).toBe('@happier-dev/triage-protocol');
        expect(packageJson.private).not.toBe(true);
        expect(packageJson.files).toContain('README.md');
        expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([
            '.',
            './testing/v1',
            './v1',
        ]);

        await expect(Promise.all([
            'README.md',
            'src/index.ts',
            'src/v1/index.ts',
            'src/v1/sourceAdministration.ts',
            'src/testing/v1/index.ts',
            'dist/index.js',
            'dist/index.d.ts',
            'dist/v1/index.js',
            'dist/v1/index.d.ts',
            'dist/testing/v1/index.js',
            'dist/testing/v1/index.d.ts',
        ].map(async (path) => ({ path, exists: await fileExists(path) })))).resolves.toEqual([
            { path: 'README.md', exists: true },
            { path: 'src/index.ts', exists: true },
            { path: 'src/v1/index.ts', exists: true },
            { path: 'src/v1/sourceAdministration.ts', exists: true },
            { path: 'src/testing/v1/index.ts', exists: true },
            { path: 'dist/index.js', exists: true },
            { path: 'dist/index.d.ts', exists: true },
            { path: 'dist/v1/index.js', exists: true },
            { path: 'dist/v1/index.d.ts', exists: true },
            { path: 'dist/testing/v1/index.js', exists: true },
            { path: 'dist/testing/v1/index.d.ts', exists: true },
        ]);
    });

    it('is registered as a repository workspace so its published name resolves', async () => {
        const rootPackageJson = JSON.parse(await readFile(
            new URL('../../../package.json', import.meta.url),
            'utf8',
        )) as Readonly<{ workspaces?: Readonly<{ packages?: readonly string[] }> }>;

        expect(rootPackageJson.workspaces?.packages).toContain('packages/triage-protocol');
    });

    /**
     * The publication half of `PLAN.md` `B5`: the package presence and export
     * map above say what this package *intends* to publish, and this says what
     * npm would actually put in the tarball.
     *
     * The two can disagree in exactly one direction that matters — an export
     * target no `files` entry selects — and that failure is invisible to every
     * check that reads the working tree, because the working tree has the file.
     */
    it('packs every module its export map promises an installed consumer', async () => {
        const manifest = await readManifest(new URL('package.json', packageDirectory));
        const packed = new Set(await packedFilePaths());
        const targets = exportTargets(manifest);

        expect(targets).toEqual([
            'dist/index.d.ts',
            'dist/index.js',
            'dist/testing/v1/index.d.ts',
            'dist/testing/v1/index.js',
            'dist/v1/index.d.ts',
            'dist/v1/index.js',
        ]);
        expect(targets.filter((target) => !packed.has(target))).toEqual([]);
        expect(packed.has('package.json')).toBe(true);
        expect(packed.has('README.md')).toBe(true);
    });

    /**
     * The tarball ships the built artifact and nothing an author writes. A
     * published `src` would let a consumer import an unversioned internal path
     * the export map never admitted, and a published test would ship the
     * package's own fixtures as product bytes.
     */
    it('packs no source, test, or build-configuration byte', async () => {
        const packed = await packedFilePaths();

        expect(packed.filter((path) => path.startsWith('src/'))).toEqual([]);
        expect(packed.filter((path) => /\.(?:test|spec)\.[cm]?[jt]s$/u.test(path))).toEqual([]);
        expect(packed.filter((path) => /^(?:tsconfig|vitest)\./u.test(path))).toEqual([]);
        expect(packed.filter((path) => path.endsWith('.tsbuildinfo'))).toEqual([]);
    });

    /**
     * Publication is not the same question as reachability. This package is
     * `private: false`, but the way a real Triage source author receives it is
     * the published host: `apps/cli` carries it in the workspace closure it
     * bundles into its own tarball. If it were dropped from that closure the
     * package would still pack perfectly and still be unreachable from an
     * installed host, so the registration is asserted at the canonical owner
     * rather than assumed from `private: false`.
     *
     * Its declared peer travels the same route, because a peer the host does
     * not carry is a peer an installed source cannot satisfy.
     */
    it('is carried by the canonical published host that delivers it to a source author', async () => {
        const manifest = await readManifest(new URL('package.json', packageDirectory));
        const cli = await readManifest(new URL('../../../apps/cli/package.json', import.meta.url));
        const peers = Object.keys(manifest.peerDependencies ?? {});

        expect(peers).toEqual(['@happier-dev/plugin-sdk']);
        for (const name of ['@happier-dev/triage-protocol', ...peers]) {
            expect(cli.bundledDependencies ?? [], `${name} must be bundled by the published host`)
                .toContain(name);
            expect(Object.keys(cli.dependencies ?? {}), `${name} must be a host dependency`)
                .toContain(name);
        }
    });
});
