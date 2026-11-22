import { StorageInventoryKindV1Schema, type StorageInventoryItemV1, type StorageInventoryKindV1, type StorageInventoryV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { PromptFoldersV1 } from '@happier-dev/protocol/prompts/library/promptFoldersV1';

import { projectArtifactBrowserRows, type ArtifactBrowserRow } from '@/components/artifacts/artifactBrowserModel';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

/**
 * The Account Storage view's projection of the storage read owner's result (`storage.inventory.read`). Every number
 * here is the server's own: the view draws ratios of those numbers to the server's total or limit, and never sums or
 * estimates a size itself.
 */
export type AccountStorageMeasuredKind = keyof StorageInventoryV1['byKind'];
export type AccountStorageKindId = StorageInventoryKindV1;

/** The lab's order: what the Artifact limit counts first (Artifacts, then their old versions), what a person adds, then plugins'. */
const KIND_ORDER: readonly StorageInventoryKindV1[] = [
    'artifacts', 'artifactOldVersions', 'discussionAttachments', 'accountPets', 'pluginCollections', 'pluginArtifacts',
];
const IMAGE_KINDS: readonly StorageInventoryKindV1[] = ['profilePictures', 'avatars', 'teamLogos'];

/** The near-the-limit share from the approved storage-view lab (scene 2 "Near the limit", ≥ 90%). */
const ARTIFACT_LIMIT_NEAR_SHARE = 0.9;

export type AccountStorageKind = Readonly<{ id: StorageInventoryKindV1; bytes: number | null }>;

/**
 * One row per kind. The ordinary kinds are known before the read lands (their names render while sizes load). With the
 * owner's per-kind sizes, Artifacts and their old versions are two rows and measured images join; an owner without them
 * reports Artifacts with their versions, and images it does not measure as unmeasured.
 */
export function projectAccountStorageKinds(inventory: StorageInventoryV1 | null): readonly AccountStorageKind[] {
    const sized = inventory?.kinds;
    if (inventory === null) return KIND_ORDER.map((id) => ({ id, bytes: null }));
    if (!sized) {
        return [
            ...KIND_ORDER.filter((id): id is AccountStorageMeasuredKind => id in inventory.byKind)
                .map((id) => ({ id, bytes: inventory.byKind[id] })),
            ...inventory.unmeasuredKinds.map((id) => ({ id, bytes: null })),
        ];
    }
    return [
        ...KIND_ORDER.filter((id) => sized[id] !== undefined || id in inventory.byKind)
            .map((id) => ({ id, bytes: sized[id]?.storedSizeBytes ?? (id in inventory.byKind ? inventory.byKind[id as AccountStorageMeasuredKind] : null) })),
        ...IMAGE_KINDS.filter((id) => sized[id] !== undefined || inventory.unmeasuredKinds.includes(id as StorageInventoryV1['unmeasuredKinds'][number]))
            .map((id) => ({ id, bytes: sized[id]?.storedSizeBytes ?? null })),
    ];
}

/**
 * The kinds the view shows (What's stored, the Account bar's legend): a kind that holds something, or whose size the
 * Home does not record ("— Size not recorded"); a kind holding 0 B says nothing. While the read is out every known
 * kind keeps its place. The sizes stay the owner's; this decides only what is drawn.
 */
export function projectShownAccountStorageKinds(inventory: StorageInventoryV1 | null): readonly AccountStorageKind[] {
    const kinds = projectAccountStorageKinds(inventory);
    return inventory === null ? kinds : kinds.filter((kind) => kind.bytes === null || kind.bytes > 0);
}

export type ArtifactLimitStanding = Readonly<{
    usedBytes: number;
    limitBytes: number;
    leftBytes: number;
    state: 'room' | 'near' | 'over';
}>;

/** The Artifact limit as the server reports it; `null` when no limit is set (the server default). */
export function projectArtifactLimit(inventory: StorageInventoryV1 | null): ArtifactLimitStanding | null {
    if (!inventory || inventory.artifactLimitBytes === null) return null;
    const usedBytes = inventory.byKind.artifacts;
    const limitBytes = inventory.artifactLimitBytes;
    const state = usedBytes >= limitBytes ? 'over'
        : limitBytes > 0 && usedBytes / limitBytes >= ARTIFACT_LIMIT_NEAR_SHARE ? 'near' : 'room';
    return { usedBytes, limitBytes, leftBytes: Math.max(0, limitBytes - usedBytes), state };
}

/** Nothing stored in any kind the server measures, and no kind it could not measure. */
export function isAccountStorageEmpty(inventory: StorageInventoryV1): boolean {
    return inventory.totalBytes === 0 && inventory.unmeasuredKinds.length === 0;
}

/**
 * What the view's sentence says: near the limit leads with it; over the limit says nothing (the shipped quota notice
 * says it once); otherwise the total and the kind holding the most.
 */
export type AccountStorageSay =
    | Readonly<{ kind: 'near'; limit: ArtifactLimitStanding }>
    | Readonly<{ kind: 'stored'; totalBytes: number; atLeast: boolean; largest: AccountStorageMeasuredKind | null; mostly: boolean }>
    | Readonly<{ kind: 'none' }>;

const MEASURED_ORDER: readonly AccountStorageMeasuredKind[] = ['artifacts', 'discussionAttachments', 'accountPets', 'pluginCollections', 'pluginArtifacts'];

export function describeAccountStorage(inventory: StorageInventoryV1): AccountStorageSay {
    const limit = projectArtifactLimit(inventory);
    if (limit?.state === 'over' || isAccountStorageEmpty(inventory)) return { kind: 'none' };
    if (limit?.state === 'near') return { kind: 'near', limit };
    const largest = MEASURED_ORDER.reduce<AccountStorageMeasuredKind | null>((best, id) =>
        inventory.byKind[id] > 0 && (best === null || inventory.byKind[id] > inventory.byKind[best]) ? id : best, null);
    return {
        kind: 'stored',
        totalBytes: inventory.totalBytes,
        atLeast: inventory.unmeasuredKinds.length > 0,
        largest,
        mostly: largest !== null && inventory.totalBytes > 0 && inventory.byKind[largest] * 2 > inventory.totalBytes,
    };
}

/** What the items list shows: every kind, or one, as the storage read owner selects it. */
export type AccountStorageItemFilter = 'all' | StorageInventoryKindV1;

export function parseAccountStorageItemFilter(value: unknown): AccountStorageItemFilter {
    const parsed = StorageInventoryKindV1Schema.safeParse(value);
    return parsed.success ? parsed.data : 'all';
}

/** The kinds the list can be narrowed to: those the owner reports holding anything. */
export function listAccountStorageItemKinds(inventory: StorageInventoryV1 | null): readonly StorageInventoryKindV1[] {
    return projectAccountStorageKinds(inventory).filter((kind) => kind.bytes !== null && kind.bytes > 0).map((kind) => kind.id);
}

/** One listed item: the owner's item, with its Artifact's opened row when it lives in an Artifact. */
export type AccountStorageItem = Readonly<{
    key: string;
    /** The owner's item id (an Artifact's id, a Discussion file's blob id). */
    id: string;
    kind: StorageInventoryKindV1;
    /** `undefined` while the server has not measured it. */
    bytes: number | undefined;
    createdAt: number | null;
    location: StorageInventoryItemV1['location'];
    /** The Artifact it lives in, once this device has its header; `null` for other kinds, or while it is read. */
    row: ArtifactBrowserRow<DecryptedArtifact> | null;
    /** An Artifact item whose header this device has not read yet: its name shimmers. */
    pending: boolean;
    /** The personal folder its Artifact is filed in, for "where it lives" (Artifacts › Marketing). */
    folderName: string | null;
    /** The server admits this viewer removing the file (`viewerMayRemove`: the message's author or the Discussion's owner). */
    viewerMayRemove: boolean;
    /** The server admits this viewer clearing the Artifact's old versions (`viewerMayTrim`). */
    viewerMayTrim: boolean;
}>;

const ALL_KINDS = { query: '', kind: 'all', sort: 'size_desc' } as const;

/** The Artifact ids a page names, once each (an Artifact and its old versions share one). */
export function readAccountStorageItemArtifactIds(items: readonly StorageInventoryItemV1[]): readonly string[] {
    return [...new Set(items.flatMap((item) => item.location.kind === 'artifact' ? [item.location.artifactId] : []))];
}

/**
 * The owner's items in its order, each joined with the Artifact header this device read for the page (titles live in
 * the header, which can be end-to-end encrypted). The key keeps an Artifact's own id and names its old versions apart.
 */
export function projectAccountStorageItems(items: readonly StorageInventoryItemV1[], artifacts: ReadonlyMap<string, DecryptedArtifact | null>,
    folders?: PromptFoldersV1 | null): readonly AccountStorageItem[] {
    const names = new Map((folders?.folders ?? []).map((folder) => [folder.id, folder.name]));
    return items.map((item) => {
        const artifactId = item.location.kind === 'artifact' ? item.location.artifactId : null;
        const artifact = artifactId === null ? undefined : artifacts.get(artifactId);
        const row = artifact ? projectArtifactBrowserRows([artifact], ALL_KINDS, { folders })[0] ?? null : null;
        return {
            key: item.kind === 'artifacts' ? item.id : `${item.kind}-${item.id}`,
            id: item.id,
            kind: item.kind,
            bytes: item.storedSizeBytes ?? undefined,
            createdAt: item.createdAt,
            location: item.location,
            row,
            pending: artifactId !== null && artifact === undefined,
            folderName: row?.folderId ? names.get(row.folderId) ?? null : null,
            // Absent on the wire means not admitted: the view offers only what the producer grants.
            viewerMayRemove: item.viewerMayRemove === true,
            viewerMayTrim: item.viewerMayTrim === true,
        };
    });
}
