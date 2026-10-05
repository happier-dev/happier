import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { readWorkBoardArtifactV1, WORK_BOARD_ARTIFACT_KIND_V1 } from '@happier-dev/protocol';
import { createWidgetDefinitionArtifactPortV1, createSessionWidgetDefinitionSourceReaderV1,
    isSameWidgetDefinitionV1, widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets';
import type { LazyActionAccountContext } from './actionAccountContext';
import { readWidgetActionCandidatesV1 } from './widgetCatalogActionDeps';
import { storage } from '@/sync/domains/state/storage';

export function createWidgetDefinitionActionDepsV1(account: LazyActionAccountContext | null | undefined,
    deps: ActionExecutorDeps): Pick<ActionExecutorDeps, 'widgetDefinitionArtifacts' | 'readSessionWidgetDefinitionSource' | 'describeWidgetDefinitionPlacements'> {
    if (!account) return {};
    const widgetDefinitionArtifacts = createWidgetDefinitionArtifactPortV1(account.workflowArtifacts, {
        accountId: account.accountId, shouldContinue: account.accountLifetime.isCurrent,
    });
    return { widgetDefinitionArtifacts,
        ...(deps.sessionBoardAction ? { readSessionWidgetDefinitionSource: createSessionWidgetDefinitionSourceReaderV1({
            sessionBoardAction: deps.sessionBoardAction,
            readInstalledDescriptor: async (definition, request) => {
                account.assertCurrent();
                const candidates = await readWidgetActionCandidatesV1({ serverId: account.serverId, accountId: account.accountId,
                    owner: { kind: 'sessionBoard', sessionId: request.session.sessionId } }, account, request.signal, request.session);
                account.assertCurrent();
                return 'ok' in candidates ? null : candidates.find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition)) ?? null;
            },
        }) } : {}),
        describeWidgetDefinitionPlacements: async (artifactId, context) => {
            // Home/WorkBoards are current Account readers; never wake machines,
            // decrypt unrelated Session items or pretend this is a global index.
            const placements = [];
            const unavailableScopes: string[] = ['sessionBoard', 'companion', 'project', 'pluginArea'];
            const accountRef = { serverId: account.serverId, accountId: account.accountId };
            if (deps.homeHubArtifacts) {
                const layout = await deps.homeHubArtifacts.read(context.signal);
                account.assertCurrent();
                for (const instance of layout.instances) if (instance.definition.kind === 'artifact' && instance.definition.artifactId === artifactId)
                    placements.push({ surface: { ...accountRef, owner: { kind: 'home' as const } }, instanceId: instance.id });
            } else unavailableScopes.push('home');
            // Already opened Board bytes are discoverable; never load other Boards
            // to build an authoritative reverse index. The scope remains partial.
            for (const artifact of Object.values(storage.getState().artifacts)) {
                if (!artifact.isDecrypted || artifact.ownerAccountId !== account.accountId
                    || artifact.rawHeader?.kind !== WORK_BOARD_ARTIFACT_KIND_V1 || artifact.rawHeader.v !== 1
                    || typeof artifact.body !== 'string') continue;
                const board = readWorkBoardArtifactV1({ artifactId: artifact.id, header: artifact.rawHeader, body: artifact.body });
                if (!board) continue;
                for (const placement of board.widgets ?? []) {
                    const reference = placement.instance.definition;
                    if (reference.kind === 'artifact' && reference.artifactId === artifactId
                        && placement.ref.surface.serverId === account.serverId && placement.ref.surface.accountId === account.accountId)
                        placements.push(placement.ref);
                }
            }
            unavailableScopes.push('workBoard');
            return { placements, unavailableScopes };
        },
    };
}
