import { deriveArtifactExcerptV1, getArtifactUseTargetV1, isArtifactHtmlHeaderV1, type ArtifactWorkspaceSourceV1 } from '@happier-dev/protocol';
import { WorkflowDefinitionArtifactBodyV1ReadSchema, WorkflowDefinitionArtifactHeaderV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { workflowDefinitionPreviewStepsV1 } from '@happier-dev/protocol/workflows';
import { buildWorkBoardPreviewLayoutV1, WorkBoardPreviewLayoutV1Schema, readWorkBoardArtifactV1 } from '@happier-dev/protocol';
import type { HappierArtifactPreview } from '@happier-dev/plugin-ui/presentation';

import { readBoardArtifactRoute } from '@/components/boards/boardsRoutes';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';
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
export type ArtifactBrowserKind = 'document' | 'prompt' | 'board' | 'workflow' | 'role' | 'launchProfile';

export const ARTIFACT_BROWSER_KINDS: readonly ArtifactBrowserKind[] = ['document', 'prompt', 'board', 'workflow', 'role', 'launchProfile'];

const USE_TARGET_TO_BROWSER_KIND = {
    open: 'document', prompt_doc: 'prompt', prompt_bundle: 'prompt', board: 'board',
    workflow: 'workflow', role: 'role', launch_profile: 'launchProfile',
} as const satisfies Readonly<Record<ReturnType<typeof getArtifactUseTargetV1>['kind'], ArtifactBrowserKind>>;

/** The browser kind, or `null` for a row the browser does not list. Locked rows stay listed as documents. */
export function classifyArtifactBrowserKind(artifact: Pick<DecryptedArtifact, 'id' | 'header' | 'rawHeader' | 'draft'>): ArtifactBrowserKind | null {
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

export type ArtifactBrowserRow = Readonly<{
    key: string;
    kind: ArtifactBrowserKind;
    artifact: DecryptedArtifact;
}>;

/** The browser's rows: listed kinds only, matched by title, in the chosen order. */
export function projectArtifactBrowserRows(
    artifacts: readonly DecryptedArtifact[],
    filter: ArtifactBrowserFilter,
): readonly ArtifactBrowserRow[] {
    const needle = filter.query.trim().toLocaleLowerCase();
    const rows: ArtifactBrowserRow[] = [];
    for (const artifact of artifacts) {
        const kind = classifyArtifactBrowserKind(artifact);
        if (kind === null) continue;
        if (filter.kind !== 'all' && kind !== filter.kind) continue;
        if (needle.length > 0 && !(artifact.title ?? '').toLocaleLowerCase().includes(needle)) continue;
        rows.push({ key: artifact.id, kind, artifact });
    }
    const byTitle = (a: ArtifactBrowserRow, b: ArtifactBrowserRow) =>
        (a.artifact.title ?? '').localeCompare(b.artifact.title ?? '', undefined, { sensitivity: 'base' });
    rows.sort(filter.sort === 'title_asc' ? byTitle
        : filter.sort === 'created_desc' ? (a, b) => b.artifact.createdAt - a.artifact.createdAt || byTitle(a, b)
            : (a, b) => b.artifact.updatedAt - a.artifact.updatedAt || byTitle(a, b));
    return rows;
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
