import { ForgeReleaseV1Schema, ForgeReleaseActionResultSchemasV1, type ForgeReleaseV1 } from '../../v1/index.js';

/** Public provider-independent vector; absent optional immutability is not inferred. */
export function createForgeReleaseV1Fixture(overrides: Partial<ForgeReleaseV1> = {}): ForgeReleaseV1 {
    return ForgeReleaseV1Schema.parse({
        repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' },
        repositoryId: '42', releaseId: '7', tagName: 'v7', targetCommitish: 'main', name: 'Release 7',
        body: 'Release notes', draft: true, prerelease: false, createdAt: '2026-10-24T10:00:00Z',
        updatedAt: '2026-10-24T10:00:00Z', publishedAt: null, webUrl: 'https://github.com/acme/widgets/releases/7',
        repositoryVisibility: 'unknown', assets: { rows: [], omittedRowCount: 0, projectionTruncated: false,
            continuation: null, incomplete: 'pagination' }, ...overrides,
    });
}

export function assertForgeReleaseReadResultV1(value: unknown): void {
    ForgeReleaseActionResultSchemasV1.readRelease.parse(value);
}
