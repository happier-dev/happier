import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    flushSessionDraft as flushRepositorySessionDraft,
    writeNewSessionDraft as writeRepositoryNewSessionDraft,
    type SessionDraftFlushResult,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { projectSyncedSessionAuthoringFields } from '@/sync/domains/input/drafts/sessionAuthoringDraftProjection';

export type AppendTranscriptSelectionToNewSessionDraftInput = Readonly<{
    promptText: string;
    sourceServerId: string | null | undefined;
    scope?: ServerAccountScope | null;
    createDraftId?: () => string;
    writeNewSessionDraft?: typeof writeRepositoryNewSessionDraft;
    flushSessionDraft?: (params: Readonly<{
        scope: ServerAccountScope;
        address: Readonly<{ kind: 'newSession'; draftId: string }>;
    }>) => Promise<SessionDraftFlushResult>;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function appendTranscriptSelectionToNewSessionDraft(
    input: AppendTranscriptSelectionToNewSessionDraftInput,
): string | null {
    const promptText = typeof input.promptText === 'string' ? input.promptText : '';
    const scope = input.scope ?? null;
    if (!promptText.trim() || !scope) return null;

    const draftId = resolveNewSessionDraftRouteIdentity({
        routeDraftId: undefined,
        createDraftId: input.createDraftId,
    }).draftId;
    const sourceServerId = normalizeNonEmptyString(input.sourceServerId);
    (input.writeNewSessionDraft ?? writeRepositoryNewSessionDraft)({
        scope,
        draftId,
        patch: {
            text: promptText,
            authoring: projectSyncedSessionAuthoringFields({
                targetType: 'new_session',
                ...(sourceServerId ? { serverId: sourceServerId } : {}),
            }),
        },
        materializationIntent: 'seeded',
    });
    fireAndForget(
        (input.flushSessionDraft ?? flushRepositorySessionDraft)({
            scope,
            address: { kind: 'newSession', draftId },
        }),
        { tag: 'appendTranscriptSelectionToNewSessionDraft.flush' },
    );
    return draftId;
}
