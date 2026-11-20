import type { SessionNewSessionSeedOutcome } from '@happier-dev/protocol/plugins/ui';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { admitProjectAuthoringOrigin } from '@/components/projects/detail/projectRouteState';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type { ComposerDraftAppendContent } from '@/components/sessions/composer/admitComposerDraftItems';
import type { NewSessionTeamModelSeed } from './newSessionDraftSeed';

export type SessionAuthoringPresentation = Pick<Parameters<typeof import('./newSessionSeedComposer').seedAndOpenNewSession>[0], 'navigateToNewSession' | 'createDraftId'> & Readonly<{
    /** The requesting surface can retire while Action admission waits. */
    isCurrent?: () => boolean;
}>;

type NewSessionSeedNavigationInput = Parameters<SessionAuthoringPresentation['navigateToNewSession']>[0];

function buildNewSessionSeedRoute(input: NewSessionSeedNavigationInput, scope: ServerAccountScope) {
    const { dataId, draftId, worktree, spawnServerId, machineId, directory } = input;
    return {
        pathname: '/new',
        params: {
            draftId,
            draftServerId: scope.serverId,
            draftAccountId: scope.accountId,
            ...(dataId === null ? {} : { dataId }),
            ...(worktree === undefined ? {} : { worktree }),
            ...(spawnServerId === undefined ? {} : { spawnServerId }),
            ...(machineId === undefined ? {} : { machineId }),
            ...(directory === undefined ? {} : { directory }),
        },
    } as const;
}

/** Open an admitted seeded draft whose first screen requires the full New Session page. */
export async function navigateToNewSessionSeedPage(input: NewSessionSeedNavigationInput, scope: ServerAccountScope,
    isCurrent: () => boolean): Promise<boolean> {
    try {
        const { router } = await import('expo-router');
        if (!isCurrent()) return false;
        router.push(buildNewSessionSeedRoute(input, scope));
        return true;
    } catch {
        return false;
    }
}

/** Page-host navigation adapter shared by semantic Host API and authoring Actions. */
export async function openOrdinaryNewSessionSeed(params: Readonly<{
    seed: unknown;
    configurationDraft?: NewSessionDraft;
    teamModelSeed?: NewSessionTeamModelSeed;
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
            ...(params.teamModelSeed ? { teamModelSeed: params.teamModelSeed } : {}),
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
                const href = buildNewSessionSeedRoute({ dataId, draftId, worktree, spawnServerId, machineId, directory }, params.scope);
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
