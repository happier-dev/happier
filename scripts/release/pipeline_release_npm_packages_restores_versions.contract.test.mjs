import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function writeJson(root, relPath, value) {
    const filePath = resolve(root, relPath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(root, relPath, value) {
    const filePath = resolve(root, relPath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, value, 'utf8');
}

function readVersion(root, relPath) {
    return JSON.parse(readFileSync(resolve(root, relPath), 'utf8')).version;
}

test('pipeline npm release restores preview-patched package manifests after the full run', async () => {
    const tempRepo = mkdtempSync(path.join(tmpdir(), 'happier-release-packages-restore-'));
    const fakeBinDir = resolve(tempRepo, 'bin');
    mkdirSync(fakeBinDir, { recursive: true });

    writeJson(tempRepo, 'package.json', { name: 'tmp-root', private: true });

    writeJson(tempRepo, 'apps/cli/package.json', {
        name: '@happier-dev/cli',
        version: '1.2.3',
        scripts: {
            build: 'node build.mjs',
            prepublishOnly: 'node build.mjs',
        },
    });
    writeText(tempRepo, 'apps/cli/build.mjs', 'process.exit(0);\n');
    writeText(tempRepo, 'apps/cli/scripts/bundleWorkspaceDeps.mjs', 'process.exit(0);\n');
    writeText(
        tempRepo,
        'apps/cli/scripts/packTarball.mjs',
        `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const destIndex = args.indexOf('--dest-dir');
const destDir = destIndex >= 0 ? resolve(args[destIndex + 1]) : process.cwd();
mkdirSync(destDir, { recursive: true });
const tarballPath = resolve(destDir, 'cli-packed.tgz');
writeFileSync(tarballPath, 'cli', 'utf8');

const packageJsonPath = resolve(process.cwd(), 'package.json');
const mutateScript = [
  "const fs = require('node:fs');",
  "const path = process.argv[1];",
  "setTimeout(() => {",
  "  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));",
  "  pkg.version = '1.2.3-preview.late';",
  "  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\\\\n', 'utf8');",
  "}, 100);",
  "setTimeout(() => process.exit(0), 150);",
].join('\\n');
spawn(process.execPath, ['-e', mutateScript, packageJsonPath], {
  detached: true,
  stdio: 'ignore',
}).unref();

console.log(tarballPath);
        `.trim() + '\n',
    );

    writeJson(tempRepo, 'apps/stack/package.json', {
        name: '@happier-dev/stack',
        version: '9.9.9',
    });
    writeText(tempRepo, 'apps/stack/scripts/bundleWorkspaceDeps.mjs', 'process.exit(0);\n');

    // The stubbed bundlers do not copy the release-built Windows service launcher; stage the
    // minimal x64 GUI PE the release check accepts where real bundling places it.
    const launcher = Buffer.alloc(512);
    launcher.writeUInt16LE(0x5a4d, 0);
    launcher.writeUInt32LE(0x80, 0x3c);
    launcher.writeUInt32LE(0x00004550, 0x80);
    launcher.writeUInt16LE(0x8664, 0x84);
    launcher.writeUInt16LE(0x20b, 0x98);
    launcher.writeUInt16LE(2, 0x98 + 68);
    launcher.write('HAPPIER_SERVICE_LAUNCHER_V1', 0x120, 'ascii');
    for (const pkgDir of ['apps/cli', 'apps/stack']) {
        writeText(tempRepo, `${pkgDir}/node_modules/@happier-dev/cli-common/native/windows/bin/windows-x64/happier-service-launcher.exe`, launcher);
    }

    writeText(
        tempRepo,
        'scripts/pipeline/npm/publish-tarball.mjs',
        'setTimeout(() => process.exit(0), 50);\n',
    );

    writeText(
        tempRepo,
        'bin/yarn',
        `#!/bin/sh
exit 0
`,
    );
    writeText(
        tempRepo,
        'bin/npm',
        `#!/bin/sh
sleep 0.25
pkgdir="$PWD"
name=$(node -e "const pkg=require(process.argv[1]); process.stdout.write(String(pkg.name).replace(/^@/, '').replace('/', '-'))" "$pkgdir/package.json")
version=$(node -e "const pkg=require(process.argv[1]); process.stdout.write(String(pkg.version))" "$pkgdir/package.json")
touch "$pkgdir/$name-$version.tgz"
printf '[{"filename":"%s"}]\\n' "$name-$version.tgz"
`,
    );
    execFileSync('chmod', ['+x', resolve(tempRepo, 'bin/yarn'), resolve(tempRepo, 'bin/npm')]);

    execFileSync(
        process.execPath,
        [
            resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'release-packages.mjs'),
            '--channel',
            'preview',
            '--publish-cli',
            'true',
            '--publish-stack',
            'true',
            '--publish-server',
            'false',
            '--run-tests',
            'false',
        ],
        {
            cwd: tempRepo,
            env: {
                ...process.env,
                PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
                HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            timeout: 30_000,
        },
    );

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));

    assert.equal(readVersion(tempRepo, 'apps/cli/package.json'), '1.2.3');
    assert.equal(readVersion(tempRepo, 'apps/stack/package.json'), '9.9.9');
});
