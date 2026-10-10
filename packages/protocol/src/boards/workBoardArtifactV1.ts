import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { WidgetGridSizeV1Schema, WidgetSizeFootprintV1Schema, getWidgetSizeFootprintV1 } from '../widgets/widgetPresentationV1.js';
import {
    applyWorkBoardIntentV1, DEFAULT_WORK_BOARDS_V1, WorkBoardV1Schema,
    buildWorkBoardWidgetKeyV1, resolveWorkBoardItemOrderV1, WORK_BOARD_MODES_V1, WORK_BOARD_SECTIONS_V1, WorkBoardPositionV1Schema,
    type WorkBoardIntentV1, type WorkBoardV1, type WorkBoardsV1,
} from './workBoardV1.js';
import { artifactSavedByFromActionContextV1, type ArtifactBodyV1, type ArtifactSavedByV1 } from '../artifacts/artifactBinaryV1.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import type { ArtifactCallerAccessV1 } from '../artifacts/artifactAccessV1.js';

export const WORK_BOARD_ARTIFACT_KIND_V1 = 'work-board.v1';
/** Saved structure only: no resolved memberships, widget inputs or runtime counts. */
export const WorkBoardPreviewLayoutV1Schema = createStoredReadSchema(lazyZodSchema(() => z.object({
    mode: z.enum(WORK_BOARD_MODES_V1),
    source: z.object({ sections: z.array(z.enum(WORK_BOARD_SECTIONS_V1)), hasFilter: z.boolean(), pickedCount: z.number().int().nonnegative() }).strict(),
    widgets: z.array(z.object({ title: z.string().nullable(), size: WidgetGridSizeV1Schema,
        footprint: WidgetSizeFootprintV1Schema.pick({ columns: true, columnSpan: true, rowSpan: true }),
        position: WorkBoardPositionV1Schema.optional() }).strict()),
}).strict()));
export type WorkBoardPreviewLayoutV1 = z.infer<typeof WorkBoardPreviewLayoutV1Schema>;

export function buildWorkBoardPreviewLayoutV1(board: WorkBoardV1): WorkBoardPreviewLayoutV1 {
    const widgets = new Map((board.widgets ?? []).map(placement => [buildWorkBoardWidgetKeyV1(placement.ref), placement]));
    return { mode: board.mode, source: { sections: [...board.source.sections ?? []], hasFilter: board.source.filter !== undefined,
        pickedCount: board.source.picked.length }, widgets: resolveWorkBoardItemOrderV1(board).flatMap(key => {
            const placement = widgets.get(key);
            if (!placement) return [];
            const title = placement.instance.displayName ?? (placement.instance.definition.kind === 'inline' ? placement.instance.definition.definition.name : null);
            const position = board.positionsByItemRef[key];
            const { columns, columnSpan, rowSpan } = getWidgetSizeFootprintV1('workBoard', placement.size)!;
            return [{ title, size: placement.size, footprint: { columns, columnSpan, rowSpan }, ...(position ? { position } : {}) }];
        }) };
}
export type WorkBoardArtifactRevisionV1 = Readonly<{ headerVersion: number; bodyVersion: number }>;
export type WorkBoardArtifactV1 = Readonly<{
    artifactId: string; header: Readonly<Record<string, unknown>>; body: ArtifactBodyV1 | null;
    revision: WorkBoardArtifactRevisionV1;
    ownerAccountId?: string;
    access?: ArtifactCallerAccessV1;
    /** Actual grant census from the admitted Artifact transport, including owner reads. */
    shared?: boolean;
}>;
export type WorkBoardArtifactSummaryV1 = Readonly<{
    id: string; name: string; pinnedInSessions: boolean;
    /** Header projection, used solely to mount the existing Inbox boundary. */
    source: Readonly<{ sections: readonly ('needs_you')[] }>;
}>;
export type WorkBoardArtifactTransportV1 = Readonly<{
    read(artifactId: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<WorkBoardArtifactV1 | null>;
    list(options: Readonly<{ limit: number; cursor?: string; signal?: AbortSignal }>): Promise<Readonly<{
        items: readonly Readonly<{ artifactId: string; header: Readonly<Record<string, unknown>>; headerVersion: number;
            bodyVersion?: number; ownerAccountId?: string; access?: ArtifactCallerAccessV1 }>[];
        nextCursor?: string;
    }>>;
    create(input: Readonly<{ artifactId: string; header: Readonly<Record<string, unknown>>; body: string; savedBy?: ArtifactSavedByV1; signal?: AbortSignal }>): Promise<unknown>;
    update(input: Readonly<{ artifactId: string; expectedRevision: WorkBoardArtifactRevisionV1;
        header: Readonly<Record<string, unknown>>; body: string; savedBy?: ArtifactSavedByV1; signal?: AbortSignal }>): Promise<
        Readonly<{ ok: true; revision: WorkBoardArtifactRevisionV1 }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
    delete(artifactId: string, options?: Readonly<{ signal?: AbortSignal; expectedRevision?: WorkBoardArtifactRevisionV1 }>): Promise<
        Readonly<{ ok: true; revision?: never }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
}>;

export class WorkBoardMutationErrorV1 extends Error {
    constructor(readonly code: 'board_not_found' | 'invalid_board_record' | 'board_scope_retired' | 'artifact_access_denied' | 'account_target_mismatch') {
        super(code); this.name = 'WorkBoardMutationErrorV1';
    }
}

/** Header metadata is a projection written atomically with the authoritative Board body. */
export function buildWorkBoardArtifactHeaderV1(board: WorkBoardV1): Readonly<Record<string, unknown>> {
    return { kind: WORK_BOARD_ARTIFACT_KIND_V1, v: 1, title: board.name,
        pinnedInSessions: board.pinnedInSessions, readsNeedsYou: board.source.sections?.includes('needs_you') === true,
        previewLayout: buildWorkBoardPreviewLayoutV1(board) };
}

export function readWorkBoardArtifactSummaryV1(artifactId: string, header: Readonly<Record<string, unknown>>): WorkBoardArtifactSummaryV1 | null {
    if (header.kind !== WORK_BOARD_ARTIFACT_KIND_V1 || header.v !== 1 || typeof header.title !== 'string'
        || typeof header.pinnedInSessions !== 'boolean' || typeof header.readsNeedsYou !== 'boolean') return null;
    return { id: artifactId, name: header.title, pinnedInSessions: header.pinnedInSessions,
        source: { sections: header.readsNeedsYou ? ['needs_you'] : [] } };
}

function readBody(artifact: Pick<WorkBoardArtifactV1, 'artifactId' | 'header' | 'body'>): unknown {
    if (artifact.header.kind !== WORK_BOARD_ARTIFACT_KIND_V1 || artifact.header.v !== 1 || typeof artifact.body !== 'string') {
        throw new WorkBoardMutationErrorV1('invalid_board_record');
    }
    try { return JSON.parse(artifact.body); } catch {
        // Syntax-invalid Board content is unreadable data; retain its original bytes for isolation.
        return artifact.body;
    }
}

export function readWorkBoardArtifactV1(artifact: Pick<WorkBoardArtifactV1, 'artifactId' | 'header' | 'body'>): WorkBoardV1 | null {
    const parsed = WorkBoardV1Schema.safeParse(readBody(artifact));
    return parsed.success && parsed.data.id === artifact.artifactId ? parsed.data : null;
}

export type WorkBoardArtifactPortV1 = Readonly<{
    read(signal?: AbortSignal): Promise<WorkBoardsV1>;
    list(signal?: AbortSignal): Promise<readonly WorkBoardArtifactSummaryV1[]>;
    readBoard(boardId: string, signal?: AbortSignal): Promise<WorkBoardV1 | null>;
    readBoardAccess(boardId: string, signal?: AbortSignal): Promise<Readonly<{ board: WorkBoardV1; canEdit: boolean; isShared: boolean; ownerAccountId?: string }> | null>;
    apply(intent: WorkBoardIntentV1, signal?: AbortSignal, context?: ActionExecutorContext): Promise<WorkBoardsV1>;
}>;

function boardAccess(artifact: WorkBoardArtifactV1) {
    const canEdit = artifact.access === 'owner' || artifact.access === 'edit' || artifact.access === 'admin';
    return { canEdit, isShared: artifact.shared === true || artifact.access === 'view' || artifact.access === 'edit' || artifact.access === 'admin' };
}

/** The only persisted Board edit path: one Artifact, pure semantic replay on its current CAS winner. */
export function createWorkBoardArtifactPortV1(transport: WorkBoardArtifactTransportV1, options: Readonly<{
    shouldContinue?: () => boolean;
    onBoard?: (boardId: string, board: WorkBoardV1 | null, revision?: WorkBoardArtifactRevisionV1) => void;
}> = {}): WorkBoardArtifactPortV1 {
    const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (options.shouldContinue && !options.shouldContinue()) throw new WorkBoardMutationErrorV1('board_scope_retired');
    };
    const fetch = async (id: string, signal?: AbortSignal) => {
        check(signal);
        try {
            const artifact = await transport.read(id, { signal });
            check(signal);
            return artifact;
        } catch (error) {
            check(signal);
            // Undefined is unreadable content; null remains an actually missing Artifact.
            // Transport, auth and Account mode/material failures stay request-wide.
            if (error instanceof Error && 'code' in error && error.code === 'content_unavailable') return undefined;
            throw error;
        }
    };
    const list = async (signal?: AbortSignal) => {
        const summaries: WorkBoardArtifactSummaryV1[] = [];
        let cursor: string | undefined;
        do {
            check(signal);
            // Artifact's canonical page maximum; this is paging, never a Board quota.
            const page = await transport.list({ limit: 500, ...(cursor ? { cursor } : {}), signal });
            check(signal);
            for (const item of page.items) {
                const summary = readWorkBoardArtifactSummaryV1(item.artifactId, item.header);
                if (summary) summaries.push(summary);
            }
            cursor = page.nextCursor;
        } while (cursor);
        return summaries;
    };
    const readBoard = async (id: string, signal?: AbortSignal) => {
        const artifact = await fetch(id, signal);
        if (!artifact) { options.onBoard?.(id, null); return null; }
        const board = readWorkBoardArtifactV1(artifact);
        options.onBoard?.(id, board, artifact.revision);
        return board;
    };
    return {
        list, readBoard,
        async readBoardAccess(id, signal) {
            const artifact = await fetch(id, signal);
            if (!artifact) return null;
            const board = readWorkBoardArtifactV1(artifact);
            if (!board) throw new WorkBoardMutationErrorV1('invalid_board_record');
            return { board, ...boardAccess(artifact), ...(artifact.ownerAccountId ? { ownerAccountId: artifact.ownerAccountId } : {}) };
        },
        async read(signal) {
            const boards: WorkBoardV1[] = [];
            const unreadable: unknown[] = [];
            for (const summary of await list(signal)) {
                const artifact = await fetch(summary.id, signal);
                if (artifact === undefined) {
                    unreadable.push({ id: summary.id });
                    options.onBoard?.(summary.id, null);
                    continue;
                }
                if (!artifact) continue;
                const board = readWorkBoardArtifactV1(artifact);
                if (board) { boards.push(board); options.onBoard?.(board.id, board, artifact.revision); }
                else {
                    unreadable.push(readBody(artifact));
                    options.onBoard?.(artifact.artifactId, null, artifact.revision);
                }
            }
            return { v: 1, boards, ...(unreadable.length ? { unreadable } : {}) };
        },
        async apply(intent, signal, context) {
            const savedBy = artifactSavedByFromActionContextV1(context);
            const id = intent.kind === 'create' ? intent.board.id.trim() : intent.boardId;
            for (;;) {
                const artifact = await fetch(id, signal);
                if (artifact === undefined) throw new WorkBoardMutationErrorV1('invalid_board_record');
                const board = artifact ? readWorkBoardArtifactV1(artifact) : null;
                if (artifact && !board) throw new WorkBoardMutationErrorV1('invalid_board_record');
                if (artifact?.ownerAccountId && 'ref' in intent && 'surface' in intent.ref
                    && intent.ref.surface.accountId !== artifact.ownerAccountId) throw new WorkBoardMutationErrorV1('account_target_mismatch');
                if (artifact && !boardAccess(artifact).canEdit) throw new WorkBoardMutationErrorV1('artifact_access_denied');
                const applied = applyWorkBoardIntentV1(board ? { v: 1, boards: [board] } : DEFAULT_WORK_BOARDS_V1, intent,
                    { shared: artifact ? boardAccess(artifact).isShared : false });
                if (applied.status !== 'applied') throw new WorkBoardMutationErrorV1('board_not_found');
                const next = applied.boards.boards[0] ?? null;
                check(signal);
                if (!artifact) {
                    if (!next) throw new WorkBoardMutationErrorV1('board_not_found');
                    await transport.create({ artifactId: id, header: buildWorkBoardArtifactHeaderV1(next), body: JSON.stringify(next), savedBy, signal });
                    check(signal);
                    // Read back through the existing Artifact owner, including idempotent create acknowledgement.
                    const acknowledged = await readBoard(id, signal);
                    if (!acknowledged) throw new WorkBoardMutationErrorV1('invalid_board_record');
                    return { v: 1, boards: [acknowledged] };
                }
                const result = next
                    ? await transport.update({ artifactId: id, expectedRevision: artifact.revision,
                        header: { ...artifact.header, ...buildWorkBoardArtifactHeaderV1(next) }, body: JSON.stringify(next), savedBy, signal })
                    : await transport.delete(id, { expectedRevision: artifact.revision, signal });
                check(signal);
                if (result.ok) {
                    options.onBoard?.(id, next, result.revision);
                    return applied.boards;
                }
                if (result.errorCode !== 'version_mismatch') {
                    if (result.errorCode === 'not_found') throw new WorkBoardMutationErrorV1('board_not_found');
                    throw Object.assign(new Error(result.error), { code: result.errorCode });
                }
                // Re-read only this Board; unrelated Board documents never participate in its CAS.
            }
        },
    };
}
