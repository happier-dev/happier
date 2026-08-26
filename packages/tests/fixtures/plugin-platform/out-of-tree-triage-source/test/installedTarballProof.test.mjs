/**
 * `qa/QA-PROTOCOL.md` QB-01's install half, and the deciding evidence for the
 * Plan's `U-QA-THIRD-PARTY-INSTALL`.
 *
 * The other three suites answer the source-authoring and protocol contracts.
 * This suite answers the package question they cannot: does the
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
 * All three author-facing packages are packed. In particular, the SDK comes
 * from the canonical pack sandbox, whose prepublication step vendors its
 * private workspace closure. A repository symlink would let Node walk back
 * into private source dependencies and make this proof green for bytes an
 * external author can never install.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(fixtureRoot, '../../../../..');
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

/**
 * Installs the packed protocol into a consumer outside the repository.
 *
 * `--offline` and `--ignore-scripts` keep the install a pure extraction of the
 * tarball under test, and `--legacy-peer-deps` stops npm reaching for the peer
 * the published host supplies instead.
 */
async function installPackedSourceConsumer(consumerRoot) {
    const { exportPackSandboxTarball } = await import(pathToFileURL(
        join(repoRoot, 'apps', 'stack', 'scripts', 'pack.mjs'),
    ).href);
    const sdkPacked = await exportPackSandboxTarball({
        monorepoRoot: repoRoot,
        packageRelDir: 'packages/plugin-sdk',
        destinationDir: consumerRoot,
    });
    const protocolPacked = await exportPackSandboxTarball({
        monorepoRoot: repoRoot,
        packageRelDir: 'packages/triage-protocol',
        destinationDir: consumerRoot,
    });
    const fixtureTarball = runNpm(
        ['pack', '--ignore-scripts', '--silent', '--pack-destination', consumerRoot],
        fixtureRoot,
    ).trim().split(/\r?\n/u).at(-1);
    const sdkTarball = sdkPacked.tarball?.name;
    const protocolTarball = protocolPacked.tarball?.name;
    assert.match(sdkTarball, /^happier-dev-plugin-sdk-.*\.tgz$/u);
    assert.match(protocolTarball, /^happier-dev-triage-protocol-.*\.tgz$/u);
    assert.match(fixtureTarball, /^happier-out-of-tree-triage-source-.*\.tgz$/u);

    await writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify({
        name: 'out-of-tree-triage-source-installed-consumer',
        private: true,
        version: '0.0.0',
        type: 'module',
    }, null, 2)}\n`, 'utf8');

    runNpm([
        'install',
        `./${sdkTarball}`,
        `./${protocolTarball}`,
        `./${fixtureTarball}`,
        '--legacy-peer-deps',
        '--offline',
        '--ignore-scripts',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
    ], consumerRoot);

    // Resolution is measured from inside the consumer, because that is the only
    // place the question means anything: the test file's own resolution would
    // walk back up into the repository and answer about the workspace.
    await writeFile(join(consumerRoot, 'probe.mjs'), `
export const resolved = {
    root: await import.meta.resolve('@happier-dev/triage-protocol'),
    v1: await import.meta.resolve('@happier-dev/triage-protocol/v1'),
    testingV1: await import.meta.resolve('@happier-dev/triage-protocol/testing/v1'),
    sdk: await import.meta.resolve('@happier-dev/plugin-sdk'),
    sourcePackage: await import.meta.resolve('happier-out-of-tree-triage-source'),
};
export const source = await import('happier-out-of-tree-triage-source');
export const { checkTriageSourceContributionV1 } = await import('@happier-dev/triage-protocol/testing/v1');
`, 'utf8');

}

test('QB-01: the prepublication closure installs out of tree and this packed source loads', async (t) => {
    const installRoot = await mkdtemp(join(tmpdir(), 'happier-triage-installed-consumer-'));
    t.after(() => rm(installRoot, { recursive: true, force: true, maxRetries: 3 }));
    await installPackedSourceConsumer(installRoot);

    const consumerUrl = pathToFileURL(join(installRoot, 'probe.mjs')).href;
    const { resolved, source, checkTriageSourceContributionV1 } = await import(consumerUrl);

    // Through `realpath`, because a temporary directory may itself be an OS
    // indirection and the loader reports the resolved path.
    const installedPrefix = pathToFileURL(join(await realpath(installRoot), 'node_modules')).href;
    for (const [subpath, target] of Object.entries(resolved)) {
        const packageName = subpath === 'sdk'
            ? 'plugin-sdk'
            : subpath === 'sourcePackage'
                ? 'happier-out-of-tree-triage-source'
                : 'triage-protocol';
        assert.ok(
            target.startsWith(subpath === 'sourcePackage'
                ? `${installedPrefix}/happier-out-of-tree-triage-source/`
                : `${installedPrefix}/@happier-dev/${packageName}/`),
            `${subpath} resolved to ${target}, which is not the installed package`,
        );
        if (subpath !== 'sourcePackage') {
            assert.ok(target.includes('/dist/'), `${subpath} resolved outside the published build output`);
        }
    }

    // The source this fixture ships really runs on the installed bytes, and the
    // installed bytes really admit it.
    const conformance = checkTriageSourceContributionV1(JSON.parse(JSON.stringify(source.manifest)));
    assert.deepEqual(conformance.ok === true ? [] : conformance.errors, []);
    assert.equal(typeof source.activate, 'function');

    const installed = join(installRoot, 'node_modules', '@happier-dev', 'triage-protocol');
    const entries = (await readdir(installed)).sort();

    // A consumer that could reach `src` could import an internal module the
    // export map never admitted, and would stop proving anything about `dist`.
    assert.equal(entries.includes('src'), false);
    assert.equal(entries.includes('node_modules'), false);
    assert.deepEqual(entries, ['README.md', 'dist', 'package.json']);
});
