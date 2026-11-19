import { router } from 'expo-router';
import { vi } from 'vitest';
import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { COMPOSER_HOST_PROJECTION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { useNewSessionComposerDocument } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { renderHook, type RenderHookResult } from './hooks/renderHook';
import { waitForTestEvent } from './hooks/waitForTestEvent';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/triage/src/manifest';

/** Load the same Machine section used by the session and new-session Composer. */
export async function readTriageComposerAttachmentCatalog(machineId: string, serverId: string) {
    const observer = await renderHook(() => useDaemonMergedProjectionInputs({ machineId, serverId,
        sections: COMPOSER_HOST_PROJECTION_SECTIONS }));
    try {
        const settled = await waitForTestEvent(observer.subscribe, observer.getCurrent,
            state => state.phase !== 'idle' && state.phase !== 'loading');
        const attachments = settled.inputs?.pluginUiProjection?.composerAttachmentsById;
        const declaration = attachments?.[`${PLUGIN_MANIFEST.id}/entry`];
        if (settled.phase !== 'ready' || !attachments || !declaration) {
            throw new Error(`Triage Composer attachment declaration unavailable (${settled.failureReason ?? settled.phase})`);
        }
        return { attachments, declaration };
    } finally {
        await observer.unmount();
    }
}

export type TriageComposeJourneyDraftProbe = Readonly<{
    seededText: string;
    pendingSeedCount: number;
    hasCheckoutCreationDraft: boolean;
    readSnapshot(): ComposerSnapshotV1 | null;
    readPendingSeedCount(): number;
    close(): Promise<void>;
}>;

export type TriageComposeJourneyProbe = Readonly<{
    clearNavigation(): void;
    readNavigation(): readonly Readonly<{ pathname: string; draftId: string; serverId: string; accountId: string }>[];
    mountDraft(draftId: string): Promise<TriageComposeJourneyDraftProbe>;
    close(): Promise<void>;
}>;

/** Observe the default Action executor's navigation and mount the resulting New Session document. */
export async function mountUiTriageComposeJourney(machineId: string): Promise<TriageComposeJourneyProbe> {
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Compose journey requires a restored Account');
    let composer: RenderHookResult<ReturnType<typeof useNewSessionComposerDocument>, void> | undefined;
    return {
        clearNavigation: () => vi.mocked(router.push).mockClear(),
        readNavigation: () => vi.mocked(router.push).mock.calls.map(([route]) => {
            if (!route || typeof route !== 'object' || !('pathname' in route) || typeof route.pathname !== 'string'
                || !('params' in route) || !route.params || typeof route.params !== 'object'
                || !('draftId' in route.params) || typeof route.params.draftId !== 'string'
                || !('draftServerId' in route.params) || typeof route.params.draftServerId !== 'string'
                || !('draftAccountId' in route.params) || typeof route.params.draftAccountId !== 'string') {
                throw new Error('New Session navigation did not carry its canonical draft address');
            }
            return { pathname: route.pathname, draftId: route.params.draftId,
                serverId: route.params.draftServerId, accountId: route.params.draftAccountId };
        }),
        async mountDraft(draftId) {
            const draft = readNewSessionDraftFromRepository({ scope, draftId });
            if (!draft) throw new Error('New Session draft missing from repository');
            const { attachments } = await readTriageComposerAttachmentCatalog(machineId, scope.serverId);
            const promptStore = createNewSessionPromptStore(draft.input);
            const mounted = await renderHook(() => useNewSessionComposerDocument({ draftId, draftScope: scope, promptStore,
                persistedAttachments: draft.composerAttachments ?? [], persistedAttachmentSeeds: draft.composerAttachmentSeeds,
                composerAttachmentEntriesById: attachments,
                scopeKey: `${scope.serverId}:${scope.accountId}:${draftId}`, canSubmitRef: { current: false }, isSubmitting: false }));
            composer = mounted;
            return {
                seededText: draft.input,
                pendingSeedCount: draft.composerAttachmentSeeds?.length ?? 0,
                hasCheckoutCreationDraft: draft.checkoutCreationDraft !== undefined,
                readSnapshot: () => mounted.getCurrent().readCurrentDocumentSnapshot(),
                readPendingSeedCount: () => readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds?.length ?? 0,
                async close() { await mounted.unmount(); composer = undefined; },
            };
        },
        async close() {
            await composer?.unmount();
            composer = undefined;
        },
    };
}
