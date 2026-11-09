import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import * as tar from 'tar';

import { extractGitHubReleaseAsset } from './extractGitHubReleaseAsset.js';

async function writeArchive(rootDir: string, files: Readonly<Record<string, string>>): Promise<void> {
    const sourceDir = join(rootDir, 'source');
    for (const [name, contents] of Object.entries(files)) {
        const filePath = join(sourceDir, name);
        await mkdir(join(filePath, '..'), { recursive: true });
        await writeFile(filePath, contents);
    }
    await tar.c({ cwd: sourceDir, file: join(rootDir, 'codex.tar.gz'), gzip: true }, Object.keys(files));
}

describe('extractGitHubReleaseAsset', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('stages the archive-stem entry when extraction yields multiple top-level files', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-extract-github-release-'));
        tempDirs.push(rootDir);

        await writeArchive(rootDir, {
            'codex-command-runner.exe': 'runner',
            'codex-windows-sandbox-setup.exe': 'sandbox',
            'codex-x86_64-pc-windows-msvc.exe': 'codex',
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

        await writeArchive(rootDir, {
            'bin/codex.exe': 'codex',
            'bin/codex-code-mode-host.exe': 'host',
            'codex-resources/codex-command-runner.exe': 'runner',
            'codex-resources/codex-windows-sandbox-setup.exe': 'sandbox',
            'codex-path/rg.exe': 'undeclared',
        });

        const outputDir = join(rootDir, 'next');
        await extractGitHubReleaseAsset({
            archivePath: join(rootDir, 'codex.tar.gz'),
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

    it('applies explicit per-file and expanded-byte ceilings through the real extractor', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-extract-github-release-'));
        tempDirs.push(rootDir);

        await writeArchive(rootDir, { 'codex-aarch64-apple-darwin': 'codex' });

        await expect(extractGitHubReleaseAsset({
            archivePath: join(rootDir, 'codex.tar.gz'),
            archiveName: 'codex-aarch64-apple-darwin.tar.gz',
            extractDir: join(rootDir, 'extract'),
            outputPath: join(rootDir, 'current', 'bin', 'codex'),
            archiveExtractionLimits: {
                maxFileBytes: 4,
                maxExpandedBytes: 4,
            },
        })).rejects.toThrow(/limit/i);
        await expect(stat(join(rootDir, 'current', 'bin', 'codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('fails closed when multiple extracted entries do not contain an archive-stem match', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-extract-github-release-'));
        tempDirs.push(rootDir);

        await writeArchive(rootDir, { 'alpha.exe': 'alpha', 'beta.exe': 'beta' });

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

        await expect(stat(join(rootDir, 'extract'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(outputPath, 'utf8')).resolves.toBe('#!/bin/sh\nexit 0\n');
        if (process.platform !== 'win32') {
            const outputStat = await stat(outputPath);
            expect(outputStat.mode & 0o111).not.toBe(0);
        }
    });

    it.each(['tar.bz2', 'tbz2'])('extracts a declared nested file from a %s release instead of publishing compressed bytes', async (extension) => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-extract-github-bzip2-'));
        tempDirs.push(rootDir);
        const archiveName = `payload.${extension}`;
        const archivePath = join(rootDir, archiveName);
        const outputPath = join(rootDir, 'output', 'tool');
        // Python stdlib-produced tar.bz2: nested/tool, contents "bzip2-payload\n".
        await writeFile(archivePath, Buffer.from('QlpoOTFBWSZTWUkYzkMAAHT7gMqQBABAAvOAAgB2Jd4wCAggAFRCm1D1GjQAG1NNP1QSUTRoaDQAAH2kBqED3IQiPEZy6FD0CGBm0vba4TmCMHGWqFkyX4OeptJR21MgojFK5+PFwKf1Q0MzIvxdyRThQkEkYzkM', 'base64'));
        await extractGitHubReleaseAsset({
            archiveName, archivePath, outputPath,
            extractDir: join(rootDir, 'extract'),
            outputDir: join(rootDir, 'output'),
            archiveEntries: [{ archivePath: 'nested/tool', destinationPath: 'tool' }],
        });
        expect(await readFile(outputPath, 'utf8')).toBe('bzip2-payload\n');
    });
});
