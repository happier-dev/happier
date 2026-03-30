import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    fetchGitHubReleaseByTagMock,
    resolveReleaseAssetBundleMock,
    downloadVerifiedReleaseAssetBundleMock,
    extractReleasePayloadRootFromArchiveMock,
} = vi.hoisted(() => ({
    fetchGitHubReleaseByTagMock: vi.fn(),
    resolveReleaseAssetBundleMock: vi.fn(),
    downloadVerifiedReleaseAssetBundleMock: vi.fn(),
    extractReleasePayloadRootFromArchiveMock: vi.fn(),
}));

vi.mock('@happier-dev/release-runtime/github', () => ({
    fetchGitHubReleaseByTag: fetchGitHubReleaseByTagMock,
}));

vi.mock('@happier-dev/release-runtime/assets', () => ({
    resolveReleaseAssetBundle: resolveReleaseAssetBundleMock,
}));

vi.mock('@happier-dev/release-runtime/verifiedDownload', () => ({
    downloadVerifiedReleaseAssetBundle: downloadVerifiedReleaseAssetBundleMock,
}));

vi.mock('./extractReleasePayloadRootFromArchive.js', () => ({
    extractReleasePayloadRootFromArchive: extractReleasePayloadRootFromArchiveMock,
}));

import { prepareFirstPartyComponentPayloadFromGitHubRelease } from './prepareFirstPartyComponentPayloadFromGitHubRelease.js';

describe('prepareFirstPartyComponentPayloadFromGitHubRelease', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('uses an explicit GitHub release source override when provided', async () => {
        fetchGitHubReleaseByTagMock.mockResolvedValue({
            assets: [
                { name: 'hstack-v1.2.3-linux-x64.tar.gz', browser_download_url: 'https://example.test/archive.tgz' },
                { name: 'checksums-hstack-v1.2.3.txt', browser_download_url: 'https://example.test/checksums.txt' },
                { name: 'checksums-hstack-v1.2.3.txt.minisig', browser_download_url: 'https://example.test/checksums.txt.minisig' },
            ],
        });
        resolveReleaseAssetBundleMock.mockReturnValue({
            version: '1.2.3',
            archive: { name: 'hstack-v1.2.3-linux-x64.tar.gz', url: 'https://example.test/archive.tgz' },
            checksums: { name: 'checksums-hstack-v1.2.3.txt', url: 'https://example.test/checksums.txt' },
            checksumsSig: { name: 'checksums-hstack-v1.2.3.txt.minisig', url: 'https://example.test/checksums.txt.minisig' },
        });
        downloadVerifiedReleaseAssetBundleMock.mockResolvedValue({
            archivePath: '/tmp/archive.tgz',
            archiveName: 'hstack-v1.2.3-linux-x64.tar.gz',
        });
        extractReleasePayloadRootFromArchiveMock.mockResolvedValue('/tmp/payload-root');

        const params = {
            componentId: 'hstack',
            channel: 'stable',
            os: 'linux',
            arch: 'x64',
            artifactSource: {
                kind: 'github-release',
                githubRepo: 'acme/private-hstack',
                githubToken: 'secret-token',
                userAgent: 'custom-agent',
            },
        } as unknown as Parameters<typeof prepareFirstPartyComponentPayloadFromGitHubRelease>[0] & Readonly<{
            artifactSource: Readonly<{
                kind: 'github-release';
                githubRepo: string;
                githubToken: string;
                userAgent: string;
            }>;
        }>;

        const result = await prepareFirstPartyComponentPayloadFromGitHubRelease(params);

        expect(fetchGitHubReleaseByTagMock).toHaveBeenCalledWith({
            githubRepo: 'acme/private-hstack',
            tag: 'stack-stable',
            githubToken: 'secret-token',
            userAgent: 'custom-agent',
        });
        expect(result).toMatchObject({
            componentId: 'hstack',
            channel: 'stable',
            versionId: '1.2.3',
            payloadRoot: '/tmp/payload-root',
            source: 'https://example.test/archive.tgz',
        });
    });

    it('uses release source environment overrides when no explicit source is provided', async () => {
        const previousRepo = process.env.HAPPIER_FIRST_PARTY_RELEASE_REPO;
        const previousToken = process.env.HAPPIER_FIRST_PARTY_RELEASE_TOKEN;
        const previousUserAgent = process.env.HAPPIER_FIRST_PARTY_RELEASE_USER_AGENT;

        try {
            process.env.HAPPIER_FIRST_PARTY_RELEASE_REPO = 'acme/env-hstack';
            process.env.HAPPIER_FIRST_PARTY_RELEASE_TOKEN = 'env-secret-token';
            process.env.HAPPIER_FIRST_PARTY_RELEASE_USER_AGENT = 'env-agent';

            fetchGitHubReleaseByTagMock.mockResolvedValue({
                assets: [
                    { name: 'hstack-v1.2.3-linux-x64.tar.gz', browser_download_url: 'https://example.test/archive.tgz' },
                    { name: 'checksums-hstack-v1.2.3.txt', browser_download_url: 'https://example.test/checksums.txt' },
                    { name: 'checksums-hstack-v1.2.3.txt.minisig', browser_download_url: 'https://example.test/checksums.txt.minisig' },
                ],
            });
            resolveReleaseAssetBundleMock.mockReturnValue({
                version: '1.2.3',
                archive: { name: 'hstack-v1.2.3-linux-x64.tar.gz', url: 'https://example.test/archive.tgz' },
                checksums: { name: 'checksums-hstack-v1.2.3.txt', url: 'https://example.test/checksums.txt' },
                checksumsSig: { name: 'checksums-hstack-v1.2.3.txt.minisig', url: 'https://example.test/checksums.txt.minisig' },
            });
            downloadVerifiedReleaseAssetBundleMock.mockResolvedValue({
                archivePath: '/tmp/archive.tgz',
                archiveName: 'hstack-v1.2.3-linux-x64.tar.gz',
            });
            extractReleasePayloadRootFromArchiveMock.mockResolvedValue('/tmp/payload-root');

            await prepareFirstPartyComponentPayloadFromGitHubRelease({
                componentId: 'hstack',
                channel: 'stable',
                os: 'linux',
                arch: 'x64',
            });

            expect(fetchGitHubReleaseByTagMock).toHaveBeenCalledWith({
                githubRepo: 'acme/env-hstack',
                tag: 'stack-stable',
                githubToken: 'env-secret-token',
                userAgent: 'env-agent',
            });
        } finally {
            if (previousRepo === undefined) {
                delete process.env.HAPPIER_FIRST_PARTY_RELEASE_REPO;
            } else {
                process.env.HAPPIER_FIRST_PARTY_RELEASE_REPO = previousRepo;
            }
            if (previousToken === undefined) {
                delete process.env.HAPPIER_FIRST_PARTY_RELEASE_TOKEN;
            } else {
                process.env.HAPPIER_FIRST_PARTY_RELEASE_TOKEN = previousToken;
            }
            if (previousUserAgent === undefined) {
                delete process.env.HAPPIER_FIRST_PARTY_RELEASE_USER_AGENT;
            } else {
                process.env.HAPPIER_FIRST_PARTY_RELEASE_USER_AGENT = previousUserAgent;
            }
        }
    });

    it('surfaces a source-aware error when GitHub release lookup returns 404', async () => {
        const error = new Error('Not Found');
        Reflect.set(error, 'status', 404);
        fetchGitHubReleaseByTagMock.mockRejectedValue(error);

        const params = {
            componentId: 'hstack',
            channel: 'preview',
            os: 'linux',
            arch: 'x64',
            artifactSource: {
                kind: 'github-release',
                githubRepo: 'acme/private-hstack',
                githubToken: '',
                userAgent: 'custom-agent',
            },
        } as unknown as Parameters<typeof prepareFirstPartyComponentPayloadFromGitHubRelease>[0] & Readonly<{
            artifactSource: Readonly<{
                kind: 'github-release';
                githubRepo: string;
                githubToken: string;
                userAgent: string;
            }>;
        }>;

        await expect(prepareFirstPartyComponentPayloadFromGitHubRelease(params)).rejects.toThrow(/acme\/private-hstack/i);
        await expect(prepareFirstPartyComponentPayloadFromGitHubRelease(params)).rejects.toThrow(/stack-preview/i);
    });
});
