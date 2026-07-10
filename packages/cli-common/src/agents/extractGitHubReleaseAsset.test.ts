import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { extractArchivePayloadToDirectoryMock } = vi.hoisted(() => ({
    extractArchivePayloadToDirectoryMock: vi.fn(async () => undefined),
}));

vi.mock('../firstPartyRuntime/extractArchivePayloadToDirectory.js', () => ({
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

    it('stages a direct executable asset without archive extraction', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-extract-github-release-'));
        tempDirs.push(rootDir);

        const archivePath = join(rootDir, 'omp-darwin-arm64');
        const outputPath = join(rootDir, 'current', 'bin', 'omp');
        await writeFile(archivePath, '#!/bin/sh\nexit 0\n', 'utf8');

        await extractGitHubReleaseAsset({
            archivePath,
            archiveName: 'omp-darwin-arm64',
            extractDir: join(rootDir, 'extract'),
            outputPath,
        });

        expect(extractArchivePayloadToDirectoryMock).not.toHaveBeenCalled();
        await expect(readFile(outputPath, 'utf8')).resolves.toBe('#!/bin/sh\nexit 0\n');
        if (process.platform !== 'win32') {
            const outputStat = await stat(outputPath);
            expect(outputStat.mode & 0o111).not.toBe(0);
        }
    });
});
