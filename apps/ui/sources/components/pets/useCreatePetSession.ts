import * as React from 'react';
import { resolveAgentExecutionTargetForPersistedSelection } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { resolvePreferredLaunchMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { navigateToSavedNewSessionDraft } from '@/components/sessions/drafts/newSessionDraftNavigation';
import { includeSkillInNewSessionDraft } from '@/components/sessions/new/newSessionDraftSkill';
import { applyNewSessionDraftSeedV1, type NewSessionDraftIntroV1 } from '@/components/sessions/new/newSessionDraftSeed';
import { writeNewSessionAuthoringDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { openSessionAuthoringSeed } from '@/sync/ops/actions/openSessionAuthoringSeed';
import type { SessionAuthoringOpenOutcome } from '@/sync/ops/actions/sessionAuthoringActions';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

export const CREATE_PET_SESSION_INTRO_V1 = {
    title: 'Create a pet',
    body: 'Describe your pet. Codex draws it, then every pose, and checks each one. When it’s done you can add it to your pets.',
    scene: 'ideas',
    suggestions: [
        'A sleepy fox in a green scarf',
        'Our mascot, a paper boat, as a pet',
        'A tiny robot that waters plants',
    ],
} as const satisfies NewSessionDraftIntroV1;

/** Store, Settings and the face picker share the same ordinary Codex draft entry. */
export function useCreatePetSession(): () => Promise<SessionAuthoringOpenOutcome> {
    return React.useCallback(async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return { kind: 'stale' as const, reason: 'host_retired' as const };
        // Read on the person's press: these entry buttons need no live Machine/history subscription.
        const state = getStorage().getState();
        const machines = resolveVisibleMachinesForActiveServerFromState(state);
        const recentMachinePaths = state.authoringMemory.recentMachinePaths;
        const machineId = resolvePreferredLaunchMachineId({ scope: lifetime.scope, machines, recentMachinePaths,
            preferredMachineId: recentMachinePaths[0]?.machineId });
        const machine = machines.find(item => item.id === machineId);
        const directory = resolveAbsolutePath('~', machine?.metadata?.homeDir);
        const agentTarget = resolveAgentExecutionTargetForPersistedSelection({ backendTarget: null, fallbackAgentId: 'codex' });
        let navigation: Promise<boolean> | undefined;
        const outcome = await openSessionAuthoringSeed({ scope: lifetime.scope, accountLifetime: lifetime,
            isCurrent: lifetime.isCurrent,
            seed: { ...(agentTarget ? { agentTarget } : {}),
                placement: machineId ? { kind: 'exactTarget', serverId: lifetime.scope.serverId, machineId, directory }
                    : { kind: 'currentTarget', directory } },
            navigateToNewSession: ({ draftId }) => {
                const included = includeSkillInNewSessionDraft({ scope: lifetime.scope, draftId, skillId: 'happier:hatch-pet' });
                writeNewSessionAuthoringDraftToRepository({ scope: lifetime.scope, draftId,
                    draft: applyNewSessionDraftSeedV1({ seed: { intro: CREATE_PET_SESSION_INTRO_V1 },
                        existingDraft: included, updatedAt: included.updatedAt }) });
                navigation = navigateToSavedNewSessionDraft(draftId, lifetime.scope, lifetime.isCurrent);
            },
        });
        if (navigation && !await navigation) return { kind: 'unavailable' as const, reason: 'navigation_unavailable' as const };
        return outcome;
    }, []);
}
