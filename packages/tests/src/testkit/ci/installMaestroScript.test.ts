import { describe, expect, it } from 'vitest';
import { createWriteStream } from 'node:fs';
import { mkdtemp, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import archiver from 'archiver';

const execFileAsync = promisify(execFile);

async function sha256File(filePath: string): Promise<string> {
    const data = await (await import('node:fs/promises')).readFile(filePath);
    return createHash('sha256').update(data).digest('hex');
}

async function createZipArchive(sourceDir: string, zipPath: string): Promise<void> {
    await new Promise<void>((resolveArchive, rejectArchive) => {
        const output = createWriteStream(zipPath);
        const archive = archiver('zip');
        output.once('close', resolveArchive);
        output.once('error', rejectArchive);
        archive.once('error', rejectArchive);
        archive.pipe(output);
        archive.directory(sourceDir, false);
        void archive.finalize();
    });
}

async function createUnzipFixture(scratch: string): Promise<string> {
    const fixtureBinDir = join(scratch, 'fixture-bin');
    const unzipPath = join(fixtureBinDir, 'unzip');
    const require = createRequire(import.meta.url);
    const extractZipModuleUrl = pathToFileURL(require.resolve('extract-zip')).href;
    await mkdir(fixtureBinDir, { recursive: true });
    await writeFile(
        unzipPath,
        [
            '#!/usr/bin/env node',
            `const extractZipModuleUrl = ${JSON.stringify(extractZipModuleUrl)};`,
            "const args = process.argv.slice(2);",
            "const destinationFlagIndex = args.indexOf('-d');",
            "const zipPath = args.find((arg, index) => !arg.startsWith('-') && index !== destinationFlagIndex + 1);",
            "if (destinationFlagIndex < 0 || !zipPath || !args[destinationFlagIndex + 1]) process.exit(2);",
            "import(extractZipModuleUrl)",
            "  .then(({ default: extractZip }) => extractZip(zipPath, { dir: require('node:path').resolve(args[destinationFlagIndex + 1]) }))",
            "  .catch((error) => { console.error(error); process.exit(1); });",
            '',
        ].join('\n'),
        'utf8',
    );
    await chmod(unzipPath, 0o755);
    return fixtureBinDir;
}

describe('scripts/ci/install_maestro.sh', () => {
    it('installs a provided maestro.zip when sha256 matches', async () => {
        const repoRoot = resolve(__dirname, '../../../../..');
        const scratch = await mkdtemp(join(tmpdir(), 'happier-install-maestro-'));
        const zipRoot = join(scratch, 'ziproot');
        const maestroHomeDir = join(zipRoot, 'maestro');
        const binDir = join(maestroHomeDir, 'bin');
        const libDir = join(maestroHomeDir, 'lib');
        const maestroBin = join(binDir, 'maestro');
        await mkdir(binDir, { recursive: true });
        await mkdir(libDir, { recursive: true });
        await writeFile(join(libDir, 'marker.txt'), 'ok\n', 'utf8');
        await writeFile(
            maestroBin,
            [
                '#!/usr/bin/env sh',
                // `/bin/sh` is `dash` on Ubuntu and does not support `pipefail`.
                'set -eu',
                'script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
                'if [ ! -f "$script_dir/../lib/marker.txt" ]; then',
                '  echo "missing-marker" >&2',
                '  exit 1',
                'fi',
                'echo maestro-stub',
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(maestroBin, 0o755);

        const zipPath = join(scratch, 'maestro.zip');
        await createZipArchive(zipRoot, zipPath);
        const fixtureBinDir = await createUnzipFixture(scratch);

        const expectedSha = await sha256File(zipPath);
        const installDir = join(scratch, 'install');

        await execFileAsync(
            'bash',
            [join(repoRoot, 'scripts/ci/install_maestro.sh')],
            {
                cwd: repoRoot,
                env: {
                    ...process.env,
                    PATH: `${fixtureBinDir}${delimiter}${process.env.PATH ?? ''}`,
                    INSTALL_DIR: installDir,
                    MAESTRO_ZIP_URL_OVERRIDE: `file://${zipPath}`,
                    MAESTRO_ZIP_SHA256: expectedSha,
                },
            },
        );

        const { stdout } = await execFileAsync(join(installDir, 'maestro'), ['--version'], {
            env: { ...process.env },
        });
        expect(stdout).toContain('maestro-stub');
    });

    it('fails when sha256 does not match', async () => {
        const repoRoot = resolve(__dirname, '../../../../..');
        const scratch = await mkdtemp(join(tmpdir(), 'happier-install-maestro-'));
        const zipRoot = join(scratch, 'ziproot');
        const maestroHomeDir = join(zipRoot, 'maestro');
        const binDir = join(maestroHomeDir, 'bin');
        const libDir = join(maestroHomeDir, 'lib');
        const maestroBin = join(binDir, 'maestro');
        await mkdir(binDir, { recursive: true });
        await mkdir(libDir, { recursive: true });
        await writeFile(join(libDir, 'marker.txt'), 'ok\n', 'utf8');
        await writeFile(
            maestroBin,
            [
                '#!/usr/bin/env sh',
                // `/bin/sh` is `dash` on Ubuntu and does not support `pipefail`.
                'set -eu',
                'script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
                'if [ ! -f "$script_dir/../lib/marker.txt" ]; then',
                '  echo "missing-marker" >&2',
                '  exit 1',
                'fi',
                'echo maestro-stub',
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(maestroBin, 0o755);

        const zipPath = join(scratch, 'maestro.zip');
        await createZipArchive(zipRoot, zipPath);
        const fixtureBinDir = await createUnzipFixture(scratch);

        const installDir = join(scratch, 'install');

        await expect(
            execFileAsync(
                'bash',
                [join(repoRoot, 'scripts/ci/install_maestro.sh')],
                {
                    cwd: repoRoot,
                    env: {
                        ...process.env,
                        PATH: `${fixtureBinDir}${delimiter}${process.env.PATH ?? ''}`,
                        INSTALL_DIR: installDir,
                        MAESTRO_ZIP_URL_OVERRIDE: `file://${zipPath}`,
                        MAESTRO_ZIP_SHA256: 'deadbeef',
                    },
                },
            ),
        ).rejects.toBeTruthy();
    });
});
