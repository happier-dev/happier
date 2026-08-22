/**
 * `qa/QA-PROTOCOL.md` QB-01's install half, and the deciding evidence for the
 * Plan's `U-QA-THIRD-PARTY-INSTALL`.
 *
 * The other three suites in this fixture answer "can an outside author write a
 * Triage source against the published contract" while resolving
 * `@happier-dev/triage-protocol` through the repository's own workspace
 * symlink. A symlinked workspace exposes the package's whole directory, so it
 * cannot answer the question an installed consumer actually asks: does the
 * *tarball* carry the modules the export map promises, and does this source
 * still load when nothing but that tarball is present?
 *
 * The failure that gap hides is silent and total. A `files` list that stopped
 * selecting `dist`, an export condition pointing at a module npm does not pack,
 * or a packed module importing a sibling the tarball omits all leave every
 * workspace-resolved test green and every installed consumer broken on its
 * first import.
 *
 * So this packs the real tarball with npm's own packing rules, installs it into
 * a consumer outside the repository, and runs this fixture's real source
 * against it — asserting by measurement that every published entry point
 * resolved inside that consumer rather than back into the repository.
 *
 * The peer dependency is deliberately not packed. `@happier-dev/plugin-sdk` is
 * delivered by the published host, which bundles it, so it is linked here the
 * way an installed host provides it; `packages/triage-protocol`'s publication
 * boundary asserts that both travel that same route.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(fixtureRoot, '../../../../..');
const protocolRoot = join(repoRoot, 'packages', 'triage-protocol');
const sdkRoot = join(repoRoot, 'packages', 'plugin-sdk');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(args, cwd) {
    return execFileSync(npmCommand, args, {
        cwd,
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 16_000_000,
        windowsHide: true,
    });
}

async function newestModificationTime(directory, exclude) {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const times = await Promise.all(entries
        .filter((entry) => entry.isFile() && /\.(?:ts|js|json)$/u.test(entry.name))
        .filter((entry) => !exclude.test(entry.name))
        .map(async (entry) => (await stat(join(entry.parentPath, entry.name))).mtimeMs));
    return times.length === 0 ? Number.NaN : Math.max(...times);
}

async function oldestModificationTime(directory) {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const times = await Promise.all(entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => (await stat(join(entry.parentPath, entry.name))).mtimeMs));
    return times.length === 0 ? Number.NaN : Math.min(...times);
}

/**
 * Installs the packed protocol into a consumer outside the repository.
 *
 * `--offline` and `--ignore-scripts` keep the install a pure extraction of the
 * tarball under test, and `--legacy-peer-deps` stops npm reaching for the peer
 * the published host supplies instead.
 */
async function installPackedProtocolConsumer(consumerRoot) {
    const tarball = runNpm(
        ['pack', '--ignore-scripts', '--silent', '--pack-destination', consumerRoot],
        protocolRoot,
    ).trim().split(/\r?\n/u).at(-1);
    assert.match(tarball, /^happier-dev-triage-protocol-.*\.tgz$/u);

    await writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify({
        name: 'out-of-tree-triage-source-installed-consumer',
        private: true,
        version: '0.0.0',
        type: 'module',
    }, null, 2)}\n`, 'utf8');

    runNpm([
        'install',
        `./${tarball}`,
        '--legacy-peer-deps',
        '--offline',
        '--ignore-scripts',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
    ], consumerRoot);

    await mkdir(join(consumerRoot, 'node_modules', '@happier-dev'), { recursive: true });
    await symlink(sdkRoot, join(consumerRoot, 'node_modules', '@happier-dev', 'plugin-sdk'), 'junction');
    await cp(join(fixtureRoot, 'src'), join(consumerRoot, 'src'), { recursive: true });

    // Resolution is measured from inside the consumer, because that is the only
    // place the question means anything: the test file's own resolution would
    // walk back up into the repository and answer about the workspace.
    await writeFile(join(consumerRoot, 'probe.mjs'), `
export const resolved = {
    root: await import.meta.resolve('@happier-dev/triage-protocol'),
    v1: await import.meta.resolve('@happier-dev/triage-protocol/v1'),
    testingV1: await import.meta.resolve('@happier-dev/triage-protocol/testing/v1'),
    sdk: await import.meta.resolve('@happier-dev/plugin-sdk'),
};
export const source = await import('./src/index.mjs');
export const { checkTriageSourceContributionV1 } = await import('@happier-dev/triage-protocol/testing/v1');
`, 'utf8');

    return tarball;
}

test('QB-01: the packed protocol installs out of tree and this source loads against it', async (t) => {
    const [newestSource, oldestEmit] = await Promise.all([
        newestModificationTime(join(protocolRoot, 'src'), /\.(?:test|spec)\.ts$/u),
        oldestModificationTime(join(protocolRoot, 'dist')),
    ]);
    assert.ok(
        oldestEmit >= newestSource,
        'packages/triage-protocol/dist is older than its source, so this proof would certify bytes '
            + 'nobody is shipping. Run `yarn --cwd packages/triage-protocol -s build` first.',
    );

    const installRoot = await mkdtemp(join(tmpdir(), 'happier-triage-installed-consumer-'));
    t.after(() => rm(installRoot, { recursive: true, force: true, maxRetries: 3 }));
    await installPackedProtocolConsumer(installRoot);

    const consumerUrl = pathToFileURL(join(installRoot, 'probe.mjs')).href;
    const { resolved, source, checkTriageSourceContributionV1 } = await import(consumerUrl);

    // Through `realpath`, because a temporary directory is itself commonly a
    // symlink and the loader reports the resolved path.
    const installedPrefix = pathToFileURL(join(await realpath(installRoot), 'node_modules')).href;
    for (const [subpath, target] of Object.entries(resolved)) {
        if (subpath === 'sdk') continue;
        assert.ok(
            target.startsWith(`${installedPrefix}/@happier-dev/triage-protocol/`),
            `${subpath} resolved to ${target}, which is not the installed package`,
        );
        assert.ok(target.includes('/dist/'), `${subpath} resolved outside the published build output`);
    }

    // The source this fixture ships really runs on the installed bytes, and the
    // installed bytes really admit it.
    const conformance = checkTriageSourceContributionV1(JSON.parse(JSON.stringify(source.manifest)));
    assert.deepEqual(conformance.ok === true ? [] : conformance.errors, []);
    assert.equal(typeof source.activate, 'function');
});

test('QB-01: the installed package is the built artifact, not this repository directory', async (t) => {
    const installRoot = await mkdtemp(join(tmpdir(), 'happier-triage-installed-shape-'));
    t.after(() => rm(installRoot, { recursive: true, force: true, maxRetries: 3 }));
    await installPackedProtocolConsumer(installRoot);

    const installed = join(installRoot, 'node_modules', '@happier-dev', 'triage-protocol');
    const entries = (await readdir(installed)).sort();

    // A consumer that could reach `src` could import an internal module the
    // export map never admitted, and would stop proving anything about `dist`.
    assert.equal(entries.includes('src'), false);
    assert.equal(entries.includes('node_modules'), false);
    assert.deepEqual(entries, ['README.md', 'dist', 'package.json']);
});
