import { readTeamCredentialProviderModelSelection } from '@/sync/domains/teams/teamCredentialProviderModelSelection';
import { resourceHasAvailableTeamCredentialProviderModel } from '@/components/sessions/teamCredentials/teamCredentialProviderModelCurrentness';
import { projectTeamCredentialSelectionConsequence } from '@/components/sessions/teamCredentials/useTeamCredentialSelectionCoordinator';
import { teamCredentialCatalogStatusLabel } from '@/components/settings/teams/credentials/catalogStatusPresentation';
import { teamCredentialUnavailableReason } from '@/components/sessions/modelPicker/buildTeamCredentialModelPickerSections';
import { teamsUnavailableHomeReason } from '@/components/settings/teams/teamsDirectoryViewState';
import type { HomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import { t } from '@/text';
import type { NewSessionCreateRequirement } from './newSessionCreateAdmission';
import * as React from 'react';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { SessionTeamCredentialBindingIntentListV1, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

type TeamModelDraft = Readonly<{
    modelSelection?: SessionModelSelection | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
}>;

export type NewSessionTeamModelCatalog = Pick<HomeTeamCredentialModelCatalog, 'resources' | 'resourceStatusByKey' | 'condition'>;

/** Project only the still-entitled selection. The scoped draft retains the intent for recovery. */
export function resolveNewSessionTeamModelRequirement(input: Readonly<{
    selection: TeamCredentialProviderModelSelectionV1 | null;
    catalog?: NewSessionTeamModelCatalog;
    restoredAccess?: Readonly<{ primaryTeamId: string | null; access: SessionInitialAccessDraftV1 | null }>;
}>): NewSessionCreateRequirement {
    const { selection, catalog, restoredAccess } = input;
    if (!selection || !catalog) return { ready: true, reason: null };
    const chooseTeamModel = () => t('session.startFailure.cause.team_credential_model_selection_required');
    const key = `${selection.teamId}:${selection.resourceId}`;
    const status = catalog.resourceStatusByKey.get(key);
    if (!status) return { ready: false, reason: catalog.condition ? teamsUnavailableHomeReason(catalog.condition) : chooseTeamModel() };
    if (status.kind !== 'current') return { ready: false, reason: teamCredentialCatalogStatusLabel(status) };
    const resource = catalog.resources.find(row => row.teamId === selection.teamId && row.id === selection.resourceId);
    if (!resource) return { ready: false, reason: chooseTeamModel() };
    if (!resourceHasAvailableTeamCredentialProviderModel(resource, selection)) {
        return { ready: false, reason: teamCredentialUnavailableReason(resource, selection.deliveryMode) ?? chooseTeamModel() };
    }
    if (restoredAccess) {
        const consequence = projectTeamCredentialSelectionConsequence(resource, selection.deliveryMode);
        const teamContextRequired = consequence.visibilityRequirement !== 'none' && restoredAccess.primaryTeamId !== selection.teamId;
        const teamVisibilityRequired = consequence.visibilityRequirement === 'team_visibility_required'
            && !restoredAccess.access?.grants.some(grant => grant.subject.kind === 'team' && grant.subject.teamId === selection.teamId);
        if (consequence.directDisclosure === 'required' || teamContextRequired || teamVisibilityRequired) {
            return { ready: false, reason: chooseTeamModel() };
        }
    }
    return { ready: true, reason: null };
}

/** Source-backed Team choices cannot be remembered as native model tuples. */
export function canRetainNewSessionModelSelection(
    team: TeamCredentialProviderModelSelectionV1 | null,
    selection: SessionModelSelection | null,
): boolean {
    if (selection?.v === 2) return selection.ref.source !== 'team_resource';
    return !team || (selection !== null && (selection.ref.providerConnectionId !== null
        || selection.ref.agentTargetKey !== team.agentTargetKey || selection.ref.modelId !== team.modelId));
}

/** Restore authored intent before autosave; a catalog still owns whether it can execute. */
export function useNewSessionTeamCredentialModelState(input: Readonly<{
    serverId: string | null;
    accountId: string | null;
    draftId: string;
    draft: TeamModelDraft | null;
}>) {
    const restored = React.useMemo(() => readTeamCredentialProviderModelSelection(input.draft),
        [input.draft?.modelSelection, input.draft?.teamCredentialBindings]);
    const scopeKey = JSON.stringify([input.serverId, input.accountId, input.draftId]);
    const sourceKey = JSON.stringify(restored);
    const [state, setState] = React.useState(() => ({ scopeKey, sourceKey, selection: restored, authored: false }));
    let selection = state.selection;
    if (state.scopeKey !== scopeKey || (!state.authored && state.sourceKey !== sourceKey)) {
        selection = restored;
        setState({ scopeKey, sourceKey, selection, authored: false });
    }
    const setSelection = React.useCallback((next: TeamCredentialProviderModelSelectionV1 | null) => {
        setState({ scopeKey, sourceKey, selection: next, authored: true });
    }, [scopeKey, sourceKey]);
    return [selection, setSelection] as const;
}

/** A Team model's backing tuple must not return later as a native Agent choice. */
export function useRetireNewSessionTeamCredentialModel(input: Readonly<{
    selection: TeamCredentialProviderModelSelectionV1 | null;
    agentTargetKey: string;
    setSelection: (selection: TeamCredentialProviderModelSelectionV1 | null) => void;
    setModelSelectionForBackendTarget: (agentTargetKey: string, selection: SessionModelSelection | null) => void;
}>) {
    React.useEffect(() => {
        if (!input.selection || input.selection.agentTargetKey === input.agentTargetKey) return;
        input.setModelSelectionForBackendTarget(input.selection.agentTargetKey, null);
        input.setSelection(null);
    }, [input.agentTargetKey, input.selection, input.setModelSelectionForBackendTarget, input.setSelection]);
}
