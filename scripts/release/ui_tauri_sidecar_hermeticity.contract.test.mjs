import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function readJson(relativePath) {
    return JSON.parse(await readFile(join(repoRoot, relativePath), 'utf8'));
}

test('ui tauri workflows build the bootstrap sidecar before dev/build and cargo tracks the source artifact', async () => {
    const uiPackageJson = await readJson('apps/ui/package.json');
    const bootstrapPackageJson = await readJson('apps/bootstrap/package.json');
    const tauriConfig = await readJson('apps/ui/src-tauri/tauri.conf.json');
    const buildRs = await readFile(join(repoRoot, 'apps', 'ui', 'src-tauri', 'build.rs'), 'utf8');
    const bootstrapBuildBinaryScript = await readFile(join(repoRoot, 'apps', 'bootstrap', 'scripts', 'buildBinary.mjs'), 'utf8');

    assert.match(
        String(bootstrapPackageJson?.scripts?.['build:binary'] ?? ''),
        /\bbuild:shared\b/,
        'bootstrap build:binary should build its shared workspace dependencies first'
    );

    assert.match(
        String(uiPackageJson?.scripts?.start ?? ''),
        /ensure:workspace:built/,
        'ui start script should ensure internal workspace dist outputs exist before Metro/Tauri import them'
    );

    assert.match(
        String(uiPackageJson?.scripts?.['tauri:prepare:sidecar'] ?? ''),
        /node \.\/scripts\/prepareTauriSidecar\.mjs/,
        'ui package should route sidecar preparation through the target-aware preparation script'
    );
    assert.match(
        String(uiPackageJson?.scripts?.['tauri:prepare:dev'] ?? ''),
        /prepareTauriSidecar\.mjs/,
        'tauri dev preparation should run sidecar preparation before starting Expo'
    );
    assert.match(
        String(uiPackageJson?.scripts?.['tauri:prepare:build'] ?? ''),
        /prepareTauriSidecar\.mjs/,
        'tauri build preparation should run sidecar preparation before exporting the web frontend'
    );
    assert.match(
        buildRs,
        /cargo:rerun-if-env-changed=TARGET/,
        'build.rs should track the Cargo target triple for the bundled sidecar copy step'
    );
    assert.match(
        String(tauriConfig?.build?.beforeDevCommand ?? ''),
        /tauri:prepare:dev/,
        'tauri beforeDevCommand should route through the sidecar-aware dev preparation script'
    );
    assert.match(
        String(tauriConfig?.build?.beforeBuildCommand ?? ''),
        /tauri:prepare:build/,
        'tauri beforeBuildCommand should route through the sidecar-aware build preparation script'
    );
    assert.match(
        buildRs,
        /cargo:rerun-if-changed=\{\}/,
        'build.rs should register the resolved sidecar source path as a Cargo rerun input'
    );

    assert.doesNotMatch(
        bootstrapBuildBinaryScript,
        /packages\/cli-common\/dist\//,
        'bootstrap buildBinary script should import cli-common via workspace exports, not by reaching into packages/*/dist directly'
    );
});
