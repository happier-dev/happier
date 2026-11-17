import { readTeamCredentialProviderModelSelection } from '@/sync/domains/teams/teamCredentialProviderModelSelection';
import * as React from 'react';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { SessionTeamCredentialBindingIntentListV1, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

type TeamModelDraft = Readonly<{
    modelSelection?: SessionModelSelection | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
}>;

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
