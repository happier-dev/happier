import type { SessionActionTarget } from './sessionActionTypes';

export type SessionArchiveFamilyFailurePhase = 'stop-linked-run' | 'archive';

export type SessionArchiveFamilyResult = Readonly<{
    archived: readonly SessionActionTarget[];
    failed: readonly Readonly<{
        target: SessionActionTarget;
        phase: SessionArchiveFamilyFailurePhase;
        error: unknown;
    }>[];
}>;

export async function archiveSessionFamily(params: Readonly<{
    parent: SessionActionTarget;
    descendants: readonly SessionActionTarget[];
    beforeArchiveDescendant: (target: SessionActionTarget) => Promise<void>;
    archive: (target: SessionActionTarget) => Promise<void>;
}>): Promise<SessionArchiveFamilyResult> {
    const archived: SessionActionTarget[] = [];
    const failed: Array<SessionArchiveFamilyResult['failed'][number]> = [];

    for (const target of params.descendants) {
        try {
            await params.beforeArchiveDescendant(target);
        } catch (error) {
            failed.push({ target, phase: 'stop-linked-run', error });
            continue;
        }

        try {
            await params.archive(target);
            archived.push(target);
        } catch (error) {
            failed.push({ target, phase: 'archive', error });
        }
    }

    try {
        await params.archive(params.parent);
        archived.push(params.parent);
    } catch (error) {
        failed.push({ target: params.parent, phase: 'archive', error });
    }

    return { archived, failed };
}
