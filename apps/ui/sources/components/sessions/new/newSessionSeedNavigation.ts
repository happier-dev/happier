import type { SessionNewSessionSeedOutcome } from '@happier-dev/protocol/plugins/ui';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { admitProjectAuthoringOrigin } from '@/components/projects/detail/projectRouteState';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type { ComposerDraftAppendContent } from '@/components/sessions/composer/admitComposerDraftItems';

export type SessionAuthoringPresentation = Pick<Parameters<typeof import('./newSessionSeedComposer').seedAndOpenNewSession>[0], 'navigateToNewSession' | 'createDraftId'> & Readonly<{
    /** The requesting surface can retire while Action admission waits. */
    isCurrent?: () => boolean;
}>;

/** Page-host navigation adapter shared by semantic Host API and authoring Actions. */
export async function openOrdinaryNewSessionSeed(params: Readonly<{
    seed: unknown;
    configurationDraft?: NewSessionDraft;
    sourceContextHandoff?: Parameters<typeof import('./newSessionSeedComposer').seedAndOpenNewSession>[0]['sourceContextHandoff'];
    presentation?: SessionAuthoringPresentation;
    /** Host-owned prepared media; never part of the public seed. */
    media?: ComposerDraftAppendContent;
    pluginId?: string;
    scope: ServerAccountScope;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    /** The control that asked; a docked New Session seats in the pane that holds it. */
    origin?: unknown;
}>): Promise<SessionNewSessionSeedOutcome> {
    try {
        const [{ seedAndOpenNewSession }, { router }, { interceptNewSessionEntry }] = await Promise.all([
            import('./newSessionSeedComposer'),
            import('expo-router'),
            import('./navigation/newSessionEntry'),
        ]);
        const outcome = seedAndOpenNewSession({
            seed: params.seed,
            ...(params.sourceContextHandoff ? { sourceContextHandoff: params.sourceContextHandoff } : {}),
            ...(params.presentation?.createDraftId ? { createDraftId: params.presentation.createDraftId } : {}),
            ...(params.configurationDraft ? { configurationDraft: params.configurationDraft } : {}),
            ...(params.media ? { media: params.media } : {}),
            ...(params.pluginId ? { pluginId: params.pluginId } : {}),
            scope: params.scope,
            ...(params.signal ? { signal: params.signal } : {}),
            isCurrent: () => params.isCurrent() && params.presentation?.isCurrent?.() !== false,
            admitOrigin: origin => admitProjectAuthoringOrigin(origin, params.scope),
            navigateToNewSession: ({ dataId, draftId, worktree, spawnServerId, machineId, directory }) => {
                if (params.presentation) {
                    params.presentation.navigateToNewSession({ dataId, draftId, worktree, spawnServerId, machineId, directory });
                    return;
                }
                const href = {
                    pathname: '/new',
                    params: {
                        draftId,
                        draftServerId: params.scope.serverId,
                        draftAccountId: params.scope.accountId,
                        ...(dataId === null ? {} : { dataId }),
                        ...(worktree === undefined ? {} : { worktree }),
                        ...(spawnServerId === undefined ? {} : { spawnServerId }),
                        ...(machineId === undefined ? {} : { machineId }),
                        ...(directory === undefined ? {} : { directory }),
                    },
                } as const;
                if (!interceptNewSessionEntry(href, params.origin)) router.push(href);
            },
        });
        if (outcome.kind === 'opened' && params.media) {
            const [{ flushAttachmentDraftsForKey }, { newSessionAttachmentDraftKey }, { resolveNewSessionDraftAttachmentFlowId }] = await Promise.all([
                import('@/components/sessions/attachments/attachmentDraftMemoryStore'),
                import('./attachments/newSessionAttachmentDraftStore'),
                import('./attachments/newSessionDraftAttachmentFlowId'),
            ]);
            await flushAttachmentDraftsForKey(newSessionAttachmentDraftKey(resolveNewSessionDraftAttachmentFlowId(outcome.draftId), params.scope));
        }
        return outcome;
    } catch {
        return { kind: 'unavailable', reason: 'navigation_unavailable' };
    }
}
