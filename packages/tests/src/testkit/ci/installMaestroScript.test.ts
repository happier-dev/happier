import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function sha256File(filePath: string): Promise<string> {
    const data = await (await import('node:fs/promises')).readFile(filePath);
    return createHash('sha256').update(data).digest('hex');
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
        await execFileAsync('zip', ['-qr', zipPath, '.'], { cwd: zipRoot });

        const expectedSha = await sha256File(zipPath);
        const installDir = join(scratch, 'install');

        await execFileAsync(
            'bash',
            [join(repoRoot, 'scripts/ci/install_maestro.sh')],
            {
                cwd: repoRoot,
                env: {
                    ...process.env,
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
        await execFileAsync('zip', ['-qr', zipPath, '.'], { cwd: zipRoot });

        const installDir = join(scratch, 'install');

        await expect(
            execFileAsync(
                'bash',
                [join(repoRoot, 'scripts/ci/install_maestro.sh')],
                {
                    cwd: repoRoot,
                    env: {
                        ...process.env,
                        INSTALL_DIR: installDir,
                        MAESTRO_ZIP_URL_OVERRIDE: `file://${zipPath}`,
                        MAESTRO_ZIP_SHA256: 'deadbeef',
                    },
                },
            ),
        ).rejects.toBeTruthy();
    });
});
