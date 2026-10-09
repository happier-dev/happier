import { deriveArtifactExcerptV1 } from '@happier-dev/protocol/artifacts/artifactExcerptV1';
import { getArtifactUseTargetV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { isArtifactHtmlHeaderV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import type { ArtifactWorkspaceSourceV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { WorkflowDefinitionArtifactBodyV1ReadSchema, WorkflowDefinitionArtifactHeaderV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { workflowDefinitionPreviewStepsV1 } from '@happier-dev/protocol/workflows';
import { buildWorkBoardPreviewLayoutV1, WorkBoardPreviewLayoutV1Schema, readWorkBoardArtifactV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import type { HappierArtifactPreview } from '@happier-dev/plugin-ui/presentation';
import type { HappierTreeNode } from '@happier-dev/plugin-ui/presentation';
import type { PromptFolderEntryV1, PromptFoldersV1 } from '@happier-dev/protocol/prompts/library/promptFoldersV1';
import { resolveArtifactOrganizationHeaderV1 } from '@happier-dev/protocol/artifacts/artifactOrganizationV1';
import { PromptDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { RoleArtifactV1Schema } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

import { readBoardArtifactRoute } from '@/components/boards/boardsRoutes';
import { memoryDocumentHref } from '@/components/memory/memoryDocumentRoutes';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionRoutes';
import { profileRoute } from '@/components/settings/profiles/profileCollectionRoutes';
import { roleRoute } from '@/components/settings/roles/roleCollectionRoutes';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';

/**
 * The Artifacts browser's one reading of an Account Artifact: which kind it is, where it came from,
 * what its card previews and where opening it goes. Every Artifacts surface (browser, view, share)
 * asks this module; none of them reads `header.kind` itself.
 */

/** The browser's kinds. Documents are untyped and published text; the rest open in their own owner. */
export type ArtifactBrowserKind = 'document' | 'prompt' | 'memory' | 'board' | 'workflow' | 'role' | 'launchProfile';

export const ARTIFACT_BROWSER_KINDS: readonly ArtifactBrowserKind[] = ['document', 'prompt', 'memory', 'board', 'workflow', 'role', 'launchProfile'];

const USE_TARGET_TO_BROWSER_KIND = {
    open: 'document', prompt_doc: 'prompt', prompt_bundle: 'prompt', memory: 'memory', board: 'board',
    workflow: 'workflow', role: 'role', launch_profile: 'launchProfile',
} as const satisfies Readonly<Record<ReturnType<typeof getArtifactUseTargetV1>['kind'], ArtifactBrowserKind>>;

/** The browser kind, or `null` for a row the browser does not list. Locked rows stay listed as documents. */
export type ArtifactBrowserArtifact = Readonly<{
    id: string; title?: string | null; header?: Readonly<Record<string, unknown>> | null;
    rawHeader?: Readonly<Record<string, unknown>> | null; draft?: boolean;
    access?: DecryptedArtifact['access']; ownerAccountId?: string; createdAt?: number; updatedAt?: number;
}>;

export function classifyArtifactBrowserKind(artifact: ArtifactBrowserArtifact): ArtifactBrowserKind | null {
    if (artifact.draft === true) return null;
    const target = getArtifactUseTargetV1({ artifactId: artifact.id,
        header: artifact.rawHeader ?? artifact.header ?? {}, body: null });
    return target.browserListed ? USE_TARGET_TO_BROWSER_KIND[target.kind] : null;
}

/** Where opening an artifact goes: its kind's own page, else the Artifacts view. */
export function resolveArtifactOpenRoute(artifact: Pick<DecryptedArtifact, 'id' | 'header' | 'rawHeader'>): string {
    const target = getArtifactUseTargetV1({ artifactId: artifact.id, header: artifact.rawHeader ?? artifact.header ?? {}, body: null });
    switch (target.kind) {
        case 'prompt_doc': return promptCollectionItemHref('doc', artifact.id);
        case 'prompt_bundle': return promptCollectionItemHref('bundle', artifact.id);
        case 'memory': return memoryDocumentHref({ artifactId: artifact.id });
        // The Boards owner names its own route.
        case 'board': return readBoardArtifactRoute(artifact) ?? artifactViewRoute(artifact.id);
        case 'workflow': return createWorkflowDefinitionRoute(artifact.id);
        case 'role': return roleRoute(artifact.id);
        case 'launch_profile': {
            const profileId = artifact.header?.profileId;
            return typeof profileId === 'string' && profileId.length > 0 ? profileRoute(profileId) : artifactViewRoute(artifact.id);
        }
        default: return artifactViewRoute(artifact.id);
    }
}

export function artifactViewRoute(artifactId: string): string {
    return `/artifacts/${encodeURIComponent(artifactId)}`;
}

/** Whether the browser opens this artifact in its own view (beside the list, or as the page). */
export function opensInArtifactView(artifact: Pick<DecryptedArtifact, 'id' | 'header' | 'rawHeader'>): boolean {
    return resolveArtifactOpenRoute(artifact) === artifactViewRoute(artifact.id);
}

/** Opened private source metadata, never public preview content or caller authority. */
export type ArtifactProvenance = Readonly<ArtifactWorkspaceSourceV1>;

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function readArtifactProvenance(artifact: Pick<DecryptedArtifact, 'provenance'>): ArtifactProvenance | null {
    return artifact.provenance?.source ?? null;
}

/** What a card previews: the body when it is loaded, else the header's excerpt; never a request. */
export type ArtifactPreview = HappierArtifactPreview;

const CODE_EXTENSIONS: Readonly<Record<string, string>> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    json: 'JSON', py: 'Python', rs: 'Rust', go: 'Go', rb: 'Ruby', java: 'Java', kt: 'Kotlin', swift: 'Swift',
    sh: 'Shell', css: 'CSS', html: 'HTML', sql: 'SQL', yaml: 'YAML', yml: 'YAML', toml: 'TOML', c: 'C', cpp: 'C++',
};

function extensionOf(name: string | null): string | null {
    if (!name) return null;
    const match = /\.([a-z0-9]+)$/i.exec(name);
    return match ? match[1]!.toLowerCase() : null;
}

/** The artifact's content language for a code document (from its source path or title), else `null`. */
export function readArtifactCodeLanguage(artifact: Pick<DecryptedArtifact, 'header' | 'title' | 'provenance'>): string | null {
    const mime = nonEmptyString(artifact.header?.mime);
    if (mime === 'text/markdown') return null;
    const ext = extensionOf(readArtifactProvenance(artifact)?.path ?? null) ?? extensionOf(artifact.title);
    if (ext && ext !== 'md' && ext !== 'markdown' && ext !== 'txt') return CODE_EXTENSIONS[ext] ?? null;
    return null;
}

export function readArtifactPreview(artifact: Pick<DecryptedArtifact, 'id' | 'header' | 'rawHeader' | 'title' | 'body' | 'provenance'>): ArtifactPreview {
    const header = artifact.rawHeader ?? artifact.header;
    if (header?.kind === 'prompt_doc.v2' || header?.kind === 'role.v1') {
        const stored = artifact.body === undefined ? header.excerpt : artifact.body;
        if (typeof stored !== 'string') return { kind: 'none' };
        try {
            const content: unknown = JSON.parse(stored);
            let text: string | undefined;
            if (header.kind === 'prompt_doc.v2') {
                const parsed = PromptDocBodyV1Schema.safeParse(content);
                if (parsed.success) text = parsed.data.markdown;
            } else {
                const parsed = createStoredReadSchema(RoleArtifactV1Schema).safeParse(content);
                if (parsed.success) text = parsed.data.instructions;
            }
            const clipped = deriveArtifactExcerptV1(text ?? null);
            return clipped ? { kind: 'markdown', text: clipped } : { kind: 'none' };
        } catch {
            return { kind: 'none' };
        }
    }
    if (header?.kind === 'work-board.v1' && header.v === 1) {
        if (artifact.body !== undefined) {
            try {
                const board = readWorkBoardArtifactV1({ artifactId: artifact.id, header, body: artifact.body });
                return board ? { kind: 'board', layout: buildWorkBoardPreviewLayoutV1(board) } : { kind: 'none' };
            } catch { return { kind: 'none' }; }
        }
        const parsed = WorkBoardPreviewLayoutV1Schema.safeParse(header.previewLayout);
        return parsed.success ? { kind: 'board', layout: parsed.data } : { kind: 'none' };
    }
    if (header?.kind === 'workflow-definition.v1') {
        let labels: readonly string[] | undefined;
        if (typeof artifact.body === 'string') {
            try {
                const parsed = WorkflowDefinitionArtifactBodyV1ReadSchema.safeParse(JSON.parse(artifact.body));
                if (!parsed.success) return { kind: 'none' };
                labels = workflowDefinitionPreviewStepsV1(parsed.data.definition.blocks);
            } catch { return { kind: 'none' }; }
        } else {
            const parsed = WorkflowDefinitionArtifactHeaderV1Schema.shape.previewSteps.safeParse(header.previewSteps);
            if (parsed.success) labels = parsed.data;
        }
        return labels ? { kind: 'workflow', steps: labels.map((title) => ({ title })) } : { kind: 'none' };
    }
    if (isArtifactHtmlHeaderV1(artifact.rawHeader ?? artifact.header)) return { kind: 'html', name: artifact.title ?? '' };
    if (artifact.body !== null && typeof artifact.body === 'object') {
        const reference = artifact.body;
        return reference.mime.startsWith('image/') ? { kind: 'image', name: artifact.title ?? '' }
            : { kind: 'file', name: artifact.title ?? '', mime: reference.mime, sizeBytes: reference.sizeBytes };
    }
    const mime = nonEmptyString(artifact.header?.mime);
    if (mime?.startsWith('image/')) return { kind: 'image', name: artifact.title ?? '' };
    const text = typeof artifact.body === 'string' && artifact.body.length > 0
        ? artifact.body
        : nonEmptyString(artifact.header?.excerpt);
    if (!text) return { kind: 'none' };
    const clipped = deriveArtifactExcerptV1(text);
    if (clipped === undefined) return { kind: 'none' };
    const language = readArtifactCodeLanguage(artifact);
    return language ? { kind: 'code', text: clipped, language } : { kind: 'markdown', text: clipped };
}

export type ArtifactBrowserSort = 'updated_desc' | 'created_desc' | 'title_asc';
export type ArtifactBrowserFilter = Readonly<{ query: string; kind: ArtifactBrowserKind | 'all'; sort: ArtifactBrowserSort }>;

export type ArtifactBrowserRow<T extends ArtifactBrowserArtifact = DecryptedArtifact> = Readonly<{
    key: string;
    kind: ArtifactBrowserKind;
    artifact: T;
    folderId: string | null;
    tags: readonly string[];
    organizationError?: 'invalid-stored-content';
}>;

export type ArtifactBrowserOrganization = Readonly<{
    folders?: PromptFoldersV1 | null;
    collapsedFolderIds?: ReadonlySet<string>;
}>;

/** Listed kinds in the chosen order, searched through title and private organization. */
export function projectArtifactBrowserRows<T extends ArtifactBrowserArtifact>(
    artifacts: readonly T[],
    filter: ArtifactBrowserFilter,
    organization: ArtifactBrowserOrganization = {},
): readonly ArtifactBrowserRow<T>[] {
    const needle = filter.query.trim().toLocaleLowerCase();
    const rows: ArtifactBrowserRow<T>[] = [];
    const folders = new Map((organization.folders?.folders ?? []).map(folder => [folder.id, folder]));
    for (const artifact of artifacts) {
        const kind = classifyArtifactBrowserKind(artifact);
        if (kind === null) continue;
        if (filter.kind !== 'all' && kind !== filter.kind) continue;
        let placement: ReturnType<typeof resolveArtifactOrganizationHeaderV1> = {};
        let organizationError: ArtifactBrowserRow<T>['organizationError'];
        if (organization.folders) {
            try {
                placement = resolveArtifactOrganizationHeaderV1({ artifactId: artifact.id,
                    artifactHeadersById: organization.folders.artifactHeadersById, header: artifact.rawHeader ?? artifact.header ?? {},
                    owned: artifact.access === 'owner' });
            } catch { organizationError = 'invalid-stored-content'; }
        }
        const folderId = placement.folderId ?? null;
        const tags = placement.tags ?? [];
        if (needle && ![artifact.title ?? '', folders.get(folderId ?? '')?.name ?? '', ...tags].join('\n').toLocaleLowerCase().includes(needle)) continue;
        rows.push({ key: artifact.id, kind, artifact, folderId, tags, ...(organizationError ? { organizationError } : {}) });
    }
    const byTitle = (a: ArtifactBrowserRow<T>, b: ArtifactBrowserRow<T>) =>
        (a.artifact.title ?? '').localeCompare(b.artifact.title ?? '', undefined, { sensitivity: 'base' });
    rows.sort(filter.sort === 'title_asc' ? byTitle
        : filter.sort === 'created_desc' ? (a, b) => (b.artifact.createdAt ?? 0) - (a.artifact.createdAt ?? 0) || byTitle(a, b)
            : (a, b) => (b.artifact.updatedAt ?? 0) - (a.artifact.updatedAt ?? 0) || byTitle(a, b));
    return rows;
}

export type ArtifactBrowserTreeNode<T extends ArtifactBrowserArtifact = DecryptedArtifact> = HappierTreeNode & Readonly<{
    title: string;
}> & (Readonly<{ kind: 'branch'; folder: PromptFolderEntryV1 }> | Readonly<{ kind: 'leaf'; row: ArtifactBrowserRow<T> }>);

/** Visible rows for the shared Tree. Filtering keeps the ancestors of matching leaves. */
export function projectArtifactBrowserTree<T extends ArtifactBrowserArtifact>(artifacts: readonly T[], filter: ArtifactBrowserFilter,
    organization: ArtifactBrowserOrganization = {}): readonly ArtifactBrowserTreeNode<T>[] {
    const rows = projectArtifactBrowserRows(artifacts, filter, organization);
    const folders = new Map((organization.folders?.folders ?? []).map(folder => [folder.id, folder]));
    const parentById = new Map<string, string | null>();
    for (const folder of folders.values()) {
        const seen = new Set<string>([folder.id]);
        let parent = folder.parentId ?? null;
        while (parent && folders.has(parent) && !seen.has(parent)) {
            seen.add(parent); parent = folders.get(parent)?.parentId ?? null;
        }
        // Retained malformed topology remains visible; display never repairs persisted data.
        parentById.set(folder.id, parent && (seen.has(parent) || !folders.has(parent)) ? null : folder.parentId ?? null);
    }
    const searching = filter.query.trim().length > 0;
    const included = new Set<string>();
    const include = (folderId: string | null) => {
        let id = folderId;
        while (id && folders.has(id) && !included.has(id)) { included.add(id); id = parentById.get(id) ?? null; }
    };
    if (!searching && filter.kind === 'all') for (const id of folders.keys()) included.add(id);
    else if (!searching) {
        // A kind narrows what is listed, not where it can be filed: a folder holding nothing stays a place to file into
        // (a folder just made under a kind would otherwise vanish); one holding only other kinds is left out.
        const occupied = new Set<string>();
        for (const row of projectArtifactBrowserRows(artifacts, { ...filter, kind: 'all' }, organization)) {
            let id = row.folderId;
            while (id && folders.has(id) && !occupied.has(id)) { occupied.add(id); id = parentById.get(id) ?? null; }
        }
        for (const id of folders.keys()) if (!occupied.has(id)) include(id);
    }
    for (const row of rows) include(row.folderId);
    const children = new Map<string | null, PromptFolderEntryV1[]>();
    for (const folder of folders.values()) {
        if (!included.has(folder.id)) continue;
        const parent = parentById.get(folder.id) ?? null;
        const siblings = children.get(parent) ?? []; siblings.push(folder); children.set(parent, siblings);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const leaves = new Map<string | null, ArtifactBrowserRow<T>[]>();
    for (const row of rows) {
        const parent = row.folderId && folders.has(row.folderId) ? row.folderId : null;
        const siblings = leaves.get(parent) ?? []; siblings.push(row); leaves.set(parent, siblings);
    }
    const nodes: ArtifactBrowserTreeNode<T>[] = [];
    const append = (parentId: string | null, depth: number) => {
        const parentKey = parentId === null ? null : `folder:${parentId}`;
        for (const folder of children.get(parentId) ?? []) {
            const expanded = !organization.collapsedFolderIds?.has(folder.id);
            nodes.push({ key: `folder:${folder.id}`, parentKey, depth, kind: 'branch', expanded, title: folder.name, folder });
            if (expanded) append(folder.id, depth + 1);
        }
        for (const row of leaves.get(parentId) ?? []) nodes.push({ key: `artifact:${row.key}`, parentKey,
            depth, kind: 'leaf', expanded: false, title: row.artifact.title ?? '', row });
    };
    append(null, 0);
    return nodes;
}

/** How many listed artifacts each kind holds (for the kind filter); kinds with none are omitted. */
export function countArtifactBrowserKinds(artifacts: readonly DecryptedArtifact[]): ReadonlyMap<ArtifactBrowserKind, number> {
    const counts = new Map<ArtifactBrowserKind, number>();
    for (const artifact of artifacts) {
        const kind = classifyArtifactBrowserKind(artifact);
        if (kind !== null) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return counts;
}
