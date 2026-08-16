import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { extractArchivePayloadToDirectoryMock } = vi.hoisted(() => ({
    extractArchivePayloadToDirectoryMock: vi.fn(async () => undefined),
}));

vi.mock('@happier-dev/release-runtime/archiveExtraction', () => ({
    extractArchivePayloadToDirectory: extractArchivePayloadToDirectoryMock,
}));

import { extractGitHubReleaseAsset } from './extractGitHubReleaseAsset.js';

describe('extractGitHubReleaseAsset', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        extractArchivePayloadToDirectoryMock.mockReset();
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('stages the archive-stem entry when extraction yields multiple top-level files', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-extract-github-release-'));
        tempDirs.push(rootDir);

        extractArchivePayloadToDirectoryMock.mockImplementationOnce(async () => {
            const extractDir = join(rootDir, 'extract');
            await mkdir(extractDir, { recursive: true });
            await writeFile(join(extractDir, 'codex-command-runner.exe'), 'runner', 'utf8');
            await writeFile(join(extractDir, 'codex-windows-sandbox-setup.exe'), 'sandbox', 'utf8');
            await writeFile(join(extractDir, 'codex-x86_64-pc-windows-msvc.exe'), 'codex', 'utf8');
        });

        const outputPath = join(rootDir, 'current', 'bin', 'codex.exe');
        await extractGitHubReleaseAsset({
            archivePath: join(rootDir, 'codex.tar.gz'),
            archiveName: 'codex-x86_64-pc-windows-msvc.exe.tar.gz',
            extractDir: join(rootDir, 'extract'),
            outputPath,
        });

        await expect(readFile(outputPath, 'utf8')).resolves.toBe('codex');
        await expect(readFile(join(rootDir, 'extract', 'codex-command-runner.exe'), 'utf8')).resolves.toBe('runner');
    });

    it('publishes only the declared runtime files from a provider package archive', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-extract-github-release-layout-'));
        tempDirs.push(rootDir);

        extractArchivePayloadToDirectoryMock.mockImplementationOnce(async () => {
            const extractDir = join(rootDir, 'extract');
            await mkdir(join(extractDir, 'bin'), { recursive: true });
            await mkdir(join(extractDir, 'codex-path'), { recursive: true });
            await mkdir(join(extractDir, 'codex-resources'), { recursive: true });
            await writeFile(join(extractDir, 'bin', 'codex.exe'), 'codex', 'utf8');
            await writeFile(join(extractDir, 'bin', 'codex-code-mode-host.exe'), 'host', 'utf8');
            await writeFile(join(extractDir, 'codex-resources', 'codex-command-runner.exe'), 'runner', 'utf8');
            await writeFile(join(extractDir, 'codex-resources', 'codex-windows-sandbox-setup.exe'), 'sandbox', 'utf8');
            await writeFile(join(extractDir, 'codex-path', 'rg.exe'), 'undeclared', 'utf8');
        });

        const outputDir = join(rootDir, 'next');
        await extractGitHubReleaseAsset({
            archivePath: join(rootDir, 'codex-package.tar.gz'),
            archiveName: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
            extractDir: join(rootDir, 'extract'),
            outputPath: join(outputDir, 'bin', 'codex.exe'),
            archiveEntries: [
                { archivePath: 'bin/codex.exe', destinationPath: 'bin/codex.exe' },
                { archivePath: 'bin/codex-code-mode-host.exe', destinationPath: 'bin/codex-code-mode-host.exe' },
                {
                    archivePath: 'codex-resources/codex-command-runner.exe',
                    destinationPath: 'codex-resources/codex-command-runner.exe',
                },
                {
                    archivePath: 'codex-resources/codex-windows-sandbox-setup.exe',
                    destinationPath: 'codex-resources/codex-windows-sandbox-setup.exe',
                },
            ],
        });

        await expect(readFile(join(outputDir, 'bin', 'codex.exe'), 'utf8')).resolves.toBe('codex');
        await expect(readFile(join(outputDir, 'bin', 'codex-code-mode-host.exe'), 'utf8')).resolves.toBe('host');
        await expect(readFile(join(outputDir, 'codex-resources', 'codex-command-runner.exe'), 'utf8')).resolves.toBe('runner');
        await expect(readFile(join(outputDir, 'codex-resources', 'codex-windows-sandbox-setup.exe'), 'utf8')).resolves.toBe('sandbox');
        await expect(readFile(join(outputDir, 'codex-path', 'rg.exe'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('fails closed when multiple extracted entries do not contain an archive-stem match', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-extract-github-release-'));
        tempDirs.push(rootDir);

        extractArchivePayloadToDirectoryMock.mockImplementationOnce(async () => {
            const extractDir = join(rootDir, 'extract');
            await mkdir(extractDir, { recursive: true });
            await writeFile(join(extractDir, 'alpha.exe'), 'alpha', 'utf8');
            await writeFile(join(extractDir, 'beta.exe'), 'beta', 'utf8');
        });

        await expect(extractGitHubReleaseAsset({
            archivePath: join(rootDir, 'codex.tar.gz'),
            archiveName: 'codex-x86_64-pc-windows-msvc.exe.tar.gz',
            extractDir: join(rootDir, 'extract'),
            outputPath: join(rootDir, 'current', 'bin', 'codex.exe'),
        })).rejects.toThrow(/expected exactly one extracted entry/i);
    });

    it('forwards bounded provider archive limits to the shared extraction policy', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-extract-github-release-'));
        tempDirs.push(rootDir);
        const extractDir = join(rootDir, 'extract');
        const archiveExtractionLimits = {
            maxFileBytes: 384 * 1024 * 1024,
            maxExpandedBytes: 384 * 1024 * 1024,
        };

        extractArchivePayloadToDirectoryMock.mockImplementationOnce(async () => {
            await mkdir(extractDir, { recursive: true });
            await writeFile(join(extractDir, 'codex-x86_64-pc-windows-msvc.exe'), 'codex', 'utf8');
        });

        await extractGitHubReleaseAsset({
            archivePath: join(rootDir, 'codex.zip'),
            archiveName: 'codex-x86_64-pc-windows-msvc.exe.zip',
            extractDir,
            outputPath: join(rootDir, 'current', 'bin', 'codex.exe'),
            archiveExtractionLimits,
        });

        expect(extractArchivePayloadToDirectoryMock).toHaveBeenCalledWith(expect.objectContaining({
            limits: archiveExtractionLimits,
        }));
    });
});
