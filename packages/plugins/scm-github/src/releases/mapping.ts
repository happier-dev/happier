import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import {
    ForgeReleaseAssetV1Schema, ForgeReleaseV1Schema,
    type ForgeReleaseAssetV1, type ForgeReleaseAssetPageV1, type ForgeReleaseV1, type ForgeReleasePageV1,
} from '@happier-dev/triage-protocol/releases/v1';

export function releaseRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}
function nativeId(value: unknown): unknown {
    return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
}
function webUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    try {
        const url = new URL(value);
        return url.origin === 'https://github.com' && !url.username && !url.password ? url.toString() : undefined;
    } catch { return undefined; }
}
export function mapGithubReleaseAssetV1(value: unknown): ForgeReleaseAssetV1 | null {
    const raw = releaseRecord(value);
    if (!raw) return null;
    const parsed = ForgeReleaseAssetV1Schema.safeParse({
        assetId: nativeId(raw.id), name: raw.name, label: raw.label ?? null, contentType: raw.content_type,
        size: raw.size, state: raw.state,
        ...(raw.digest === undefined ? {} : { digest: raw.digest }),
        ...(raw.download_count === undefined ? {} : { downloadCount: raw.download_count }),
        ...(raw.updated_at === undefined ? {} : { updatedAt: raw.updated_at }),
        ...(webUrl(raw.browser_download_url) === undefined ? {} : { webUrl: webUrl(raw.browser_download_url) }),
    });
    return parsed.success ? parsed.data : null;
}
export function mapGithubReleaseV1(value: unknown, target: Pick<ForgeReleaseV1, 'repository' | 'repositoryId' | 'repositoryVisibility'>): ForgeReleaseV1 | null {
    const raw = releaseRecord(value);
    if (!raw || !Array.isArray(raw.assets)) return null;
    const assets = raw.assets.map(mapGithubReleaseAssetV1).filter((row): row is ForgeReleaseAssetV1 => row !== null);
    const parsed = ForgeReleaseV1Schema.safeParse({
        ...target, releaseId: nativeId(raw.id), tagName: raw.tag_name, targetCommitish: raw.target_commitish,
        name: raw.name, body: raw.body ?? null, draft: raw.draft, prerelease: raw.prerelease,
        ...(typeof raw.immutable === 'boolean' ? { immutable: raw.immutable } : {}),
        createdAt: raw.created_at, ...(typeof raw.updated_at === 'string' ? { updatedAt: raw.updated_at } : {}),
        publishedAt: raw.published_at, webUrl: webUrl(raw.html_url),
        ...(typeof releaseRecord(raw.author)?.login === 'string' ? { author: releaseRecord(raw.author)?.login } : {}),
        assets: { rows: assets, omittedRowCount: raw.assets.length - assets.length, projectionTruncated: false,
            continuation: null, incomplete: 'pagination' },
    });
    return parsed.success ? parsed.data : null;
}

/** The native latest endpoint excludes drafts and prereleases; malformed responses are failures. */
export function mapGithubLatestStableReleaseV1(value: unknown, target: Pick<ForgeReleaseV1, 'repository' | 'repositoryId' | 'repositoryVisibility'>): ForgeReleaseV1 | null {
    const release = mapGithubReleaseV1(value, target);
    return release && !release.draft && !release.prerelease ? release : null;
}

/** GitHub's generated draft tag is native write identity, not a tag people chose to display. */
export function projectGithubReleaseIdentityV1(release: Pick<ForgeReleaseV1, 'draft' | 'tagName' | 'name'>): Readonly<{
    tagName: string | null; name: string | null;
}> {
    const name = release.name?.trim();
    return {
        tagName: release.draft && release.tagName.startsWith('untagged-') ? null : release.tagName,
        name: name && name !== release.tagName ? name : null,
    };
}

const assetFields = ['assetId', 'name', 'label', 'contentType', 'size', 'state', 'digest', 'downloadCount', 'updatedAt', 'webUrl'] as const;
const releaseFields = ['repositoryId', 'releaseId', 'tagName', 'targetCommitish', 'name', 'body', 'draft', 'prerelease',
    'immutable', 'createdAt', 'updatedAt', 'publishedAt', 'webUrl', 'author', 'repositoryVisibility'] as const;

/** Review compares effect/consequence facts, not incidental counters or asset order. */
export function sameReleaseReviewFieldsV1(reviewed: ForgeReleaseV1, current: ForgeReleaseV1): boolean {
    return sameScmHostingRepositoryIdentity(reviewed.repository, current.repository)
        && releaseFields.every(key => reviewed[key] === current[key]);
}
export function hasCompleteReleaseAssetsV1(assets: ForgeReleaseAssetPageV1): boolean {
    return assets.incomplete === null && assets.omittedRowCount === 0 && !assets.projectionTruncated
        && assets.continuation === null && new Set(assets.rows.map(row => row.assetId)).size === assets.rows.length;
}
export function sameReleaseReviewAssetsV1(reviewed: ForgeReleaseAssetPageV1, current: ForgeReleaseAssetPageV1): boolean {
    if (!hasCompleteReleaseAssetsV1(reviewed) || !hasCompleteReleaseAssetsV1(current) || reviewed.rows.length !== current.rows.length) return false;
    const byId = new Map(current.rows.map(row => [row.assetId, row]));
    return reviewed.rows.every(row => {
        const fresh = byId.get(row.assetId);
        return fresh !== undefined && assetFields.every(key => key === 'downloadCount' || key === 'webUrl' || row[key] === fresh[key]);
    });
}

/** Called while producing the admitted result, before any semantic publication. */
function reconcileRows<T>(previous: readonly T[] | undefined, incoming: readonly T[], id: (row: T) => string,
    reconcile: (previous: T | undefined, incoming: T) => T): readonly T[] {
    if (!previous) return incoming;
    const baseline = new Map(previous.map(row => [id(row), row]));
    const rows = incoming.map(row => reconcile(baseline.get(id(row)), row));
    return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}
export function reconcileReleaseAssetsV1(previous: ForgeReleaseAssetPageV1 | undefined, incoming: ForgeReleaseAssetPageV1): ForgeReleaseAssetPageV1 {
    const rows = reconcileRows(previous?.rows, incoming.rows, row => row.assetId,
        (old, row) => old && assetFields.every(key => old[key] === row[key]) ? old : row);
    if (previous && rows === previous.rows && previous.omittedRowCount === incoming.omittedRowCount
        && previous.projectionTruncated === incoming.projectionTruncated && previous.continuation === incoming.continuation
        && previous.incomplete === incoming.incomplete) return previous;
    return rows === incoming.rows ? incoming : { ...incoming, rows };
}
export function reconcileReleaseV1(previous: ForgeReleaseV1 | null | undefined, incoming: ForgeReleaseV1): ForgeReleaseV1 {
    if (!previous || !sameScmHostingRepositoryIdentity(previous.repository, incoming.repository)
        || previous.repositoryId !== incoming.repositoryId || previous.releaseId !== incoming.releaseId) return incoming;
    const assets = reconcileReleaseAssetsV1(previous.assets, incoming.assets);
    if (assets === previous.assets && releaseFields.every(key => previous[key] === incoming[key])) return previous;
    return { ...incoming, repository: previous.repository, assets };
}
export function reconcileReleasePageV1(previous: ForgeReleasePageV1 | undefined, incoming: ForgeReleasePageV1): ForgeReleasePageV1 {
    const rows = reconcileReleaseRowsV1(previous?.rows, incoming.rows);
    if (previous && rows === previous.rows && previous.omittedRowCount === incoming.omittedRowCount
        && previous.projectionTruncated === incoming.projectionTruncated && previous.continuation === incoming.continuation
        && previous.incomplete === incoming.incomplete) return previous;
    return rows === incoming.rows ? incoming : { ...incoming, rows };
}
export function reconcileReleaseRowsV1(previous: readonly ForgeReleaseV1[] | undefined, incoming: readonly ForgeReleaseV1[]): readonly ForgeReleaseV1[] {
    // Provider pages can overlap as new releases arrive. One native id remains one Collection row.
    const unique = new Map(incoming.map(row => [row.releaseId, row]));
    return reconcileRows(previous, unique.size === incoming.length ? incoming : [...unique.values()], row => row.releaseId, reconcileReleaseV1);
}
