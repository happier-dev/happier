import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractReleasePayloadRootFromArchive } from './extractReleasePayloadRootFromArchive';
import { resolveCliBinaryAssetBundleFromReleaseAssets } from './releaseAssetBundle';

describe('releaseAssetBundle', () => {
    it('picks the newest matching rolling asset bundle', () => {
        const bundle = resolveCliBinaryAssetBundleFromReleaseAssets({
            assets: [
                { name: 'happier-v1.0.0-linux-x64.tar.gz', browser_download_url: 'https://example.test/old.tgz' },
                { name: 'checksums-happier-v1.0.0.txt', browser_download_url: 'https://example.test/old.txt' },
                { name: 'checksums-happier-v1.0.0.txt.minisig', browser_download_url: 'https://example.test/old.minisig' },
                { name: 'happier-v1.0.1-linux-x64.tar.gz', browser_download_url: 'https://example.test/new.tgz' },
                { name: 'checksums-happier-v1.0.1.txt', browser_download_url: 'https://example.test/new.txt' },
                { name: 'checksums-happier-v1.0.1.txt.minisig', browser_download_url: 'https://example.test/new.minisig' },
            ],
            os: 'linux',
            arch: 'x64',
            preferVersion: null,
        });

        expect(bundle.version).toBe('1.0.1');
        expect(bundle.archive.name).toBe('happier-v1.0.1-linux-x64.tar.gz');
    });

    it('prefers a windows zip archive when one is published', () => {
        const bundle = resolveCliBinaryAssetBundleFromReleaseAssets({
            assets: [
                { name: 'happier-v1.0.1-windows-x64.tar.gz', browser_download_url: 'https://example.test/windows.tgz' },
                { name: 'happier-v1.0.1-windows-x64.zip', browser_download_url: 'https://example.test/windows.zip' },
                { name: 'checksums-happier-v1.0.1.txt', browser_download_url: 'https://example.test/checksums.txt' },
                { name: 'checksums-happier-v1.0.1.txt.minisig', browser_download_url: 'https://example.test/checksums.minisig' },
            ],
            os: 'windows',
            arch: 'x64',
            preferVersion: null,
        });

        expect(bundle.version).toBe('1.0.1');
        expect(bundle.archive.name).toBe('happier-v1.0.1-windows-x64.zip');
    });

    it('extracts the single payload root from a release archive', async () => {
        const root = mkdtempSync(join(tmpdir(), 'first-party-runtime-release-bundle-'));
        try {
            const version = '9.9.10-preview.3';
            const stem = `happier-v${version}-linux-x64`;
            const artifactDir = join(root, stem);
            mkdirSync(join(artifactDir, 'package-dist'), { recursive: true });
            writeFileSync(join(artifactDir, 'happier'), 'new-binary\n', 'utf8');
            chmodSync(join(artifactDir, 'happier'), 0o755);
            writeFileSync(join(artifactDir, 'package-dist', 'index.mjs'), 'export default "ok";\n', 'utf8');

            const archiveName = `${stem}.tar.gz`;
            const archivePath = join(root, archiveName);
            const tarRes = spawnSync('tar', ['-czf', archivePath, '-C', root, stem], { encoding: 'utf8' });
            expect(tarRes.status).toBe(0);

            const extractedRoot = await extractReleasePayloadRootFromArchive({
                archivePath,
                archiveName,
                extractDir: join(root, 'extract'),
            });

            expect(readFileSync(join(extractedRoot, 'happier'), 'utf8')).toBe('new-binary\n');
            expect(readFileSync(join(extractedRoot, 'package-dist', 'index.mjs'), 'utf8')).toBe('export default "ok";\n');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
