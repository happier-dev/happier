import type { PromptFoldersV1, PromptInvocationsV1 } from '@happier-dev/protocol';

import { classifyArtifactBrowserKind, projectArtifactBrowserTree, type ArtifactBrowserArtifact, type ArtifactBrowserTreeNode } from '@/components/artifacts/artifactBrowserModel';
import { createHappierCollectionVisitMemory, resolveHappierCollectionInitialKey } from '@happier-dev/plugin-ui/presentation';
import type { PromptCollectionKind } from './promptCollectionRoutes';
export { promptCollectionRoot, promptCollectionItemHref, promptCollectionDraftHref, resolvePromptCollectionRoute } from './promptCollectionRoutes';
export type { PromptCollectionKind, PromptCollectionRoute } from './promptCollectionRoutes';

/**
 * The three named collections of the prompt library: prompts (`doc`), skills (`bundle`) and slash
 * templates (`template`). Each is a list beside the selected item's editor.
 */
export type PromptCollectionRow = Readonly<{
    id: string;
    title: string;
    /** A distinguishing fact where the collection has one (a template's slash command). */
    subtitle?: string;
}>;

export type PromptCollectionGroup = Readonly<{
    /** The folder the rows share; `null` for items outside any folder. */
    id: string | null;
    title: string | null;
    rows: readonly PromptCollectionRow[];
}>;

export type PromptCollection = Readonly<{
    /** Items in the collection before the search filter. */
    total: number;
    groups: readonly PromptCollectionGroup[];
    /** The same hierarchy consumed by the Artifacts browser and shared Tree. */
    tree?: readonly ArtifactBrowserTreeNode<ArtifactBrowserArtifact>[];
}>;

type ArtifactLike = ArtifactBrowserArtifact;

const ARTIFACT_KIND: Readonly<Record<'doc' | 'bundle', string>> = {
    doc: 'prompt_doc.v2',
    bundle: 'prompt_bundle.v2',
};

function compareTitles(left: PromptCollectionRow, right: PromptCollectionRow): number {
    return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
}

export function readPromptArtifactTitle(artifact: ArtifactLike, untitledTitle: string): string {
    const headerTitle = artifact.header?.title;
    if (typeof headerTitle === 'string' && headerTitle.trim()) return headerTitle;
    return artifact.title?.trim() ? artifact.title : untitledTitle;
}

/**
 * Prompts or skills, grouped by folder (folders by name, then the items outside any folder). With no
 * item in a folder the list stays ungrouped rather than showing a heading that says nothing.
 */
export function buildPromptLibraryCollection(params: Readonly<{
    kind: 'doc' | 'bundle';
    artifacts: readonly ArtifactLike[];
    folders: PromptFoldersV1 | null | undefined;
    query: string;
    untitledTitle: string;
}>): PromptCollection {
    const members = params.artifacts.filter(artifact => classifyArtifactBrowserKind(artifact) === 'prompt'
        && (artifact.rawHeader ?? artifact.header)?.kind === ARTIFACT_KIND[params.kind]);
    const tree = projectArtifactBrowserTree(members.map(artifact => ({ ...artifact,
        title: readPromptArtifactTitle(artifact, params.untitledTitle) })),
        { query: params.query, kind: 'prompt', sort: 'title_asc' }, { folders: params.folders });
    const groups = new Map<string | null, { id: string | null; title: string | null; rows: PromptCollectionRow[] }>();
    const folderNames = new Map(tree.filter(node => node.kind === 'branch').map(node => [node.key, node.title]));
    for (const node of tree) {
        if (node.kind !== 'leaf') continue;
        const id = node.parentKey === null ? null : node.row.folderId;
        const group = groups.get(id) ?? { id, title: node.parentKey === null ? null : folderNames.get(node.parentKey) ?? null, rows: [] };
        group.rows.push({ id: node.row.key, title: node.title }); groups.set(id, group);
    }
    return { total: members.length, groups: [...groups.values()], tree };
}

/** Slash templates, by name, each with its command. */
export function buildPromptTemplateCollection(params: Readonly<{
    invocations: Pick<PromptInvocationsV1, 'entries'> | Readonly<{ entries: readonly Readonly<{ id: string; title: string; token: string }>[] }> | null | undefined;
    query: string;
}>): PromptCollection {
    const entries = params.invocations?.entries ?? [];
    const query = params.query.trim().toLocaleLowerCase();
    const rows = entries
        .filter((entry) => !query || `${entry.title}\n${entry.token}`.toLocaleLowerCase().includes(query))
        .map((entry): PromptCollectionRow => ({ id: entry.id, title: entry.title, subtitle: entry.token }))
        .sort(compareTitles);
    return { total: entries.length, groups: rows.length > 0 ? [{ id: null, title: null, rows }] : [] };
}

/** Where a wide collection lands when its route names no item: the last one opened, else the first. */
export function resolvePromptCollectionLandingId(collection: PromptCollection, lastVisitedId: string | null): string | null {
    const ids = collection.groups.flatMap((group) => group.rows.map((row) => row.id));
    return resolveHappierCollectionInitialKey({ keys: ids, lastVisited: lastVisitedId });
}

/**
 * The item last opened in each collection during this app session. Session memory only: a
 * navigation convenience, not a preference, so it is neither persisted nor synced.
 */
const promptVisits: Record<PromptCollectionKind, ReturnType<typeof createHappierCollectionVisitMemory<string>>> = {
    doc: createHappierCollectionVisitMemory<string>(),
    bundle: createHappierCollectionVisitMemory<string>(),
    template: createHappierCollectionVisitMemory<string>(),
};

export function recordPromptCollectionVisit(kind: PromptCollectionKind, id: string): void {
    promptVisits[kind].record(id);
}

export function readLastVisitedPromptCollectionId(kind: PromptCollectionKind): string | null {
    return promptVisits[kind].read();
}
