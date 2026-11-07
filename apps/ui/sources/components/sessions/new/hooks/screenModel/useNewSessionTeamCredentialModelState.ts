import * as React from 'react';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import type { SessionTeamCredentialBindingIntentListV1, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

import { findAssignedProviderModelCredentialBinding } from '@/components/sessions/teamCredentials/teamCredentialProviderModelCurrentness';

type TeamModelDraft = Readonly<{
    modelSelection?: SessionModelSelectionV1 | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
}>;

/** Restore authored intent before autosave; a catalog still owns whether it can execute. */
export function useNewSessionTeamCredentialModelState(input: Readonly<{
    serverId: string | null;
    accountId: string | null;
    draftId: string;
    draft: TeamModelDraft | null;
}>) {
    const restored = React.useMemo<TeamCredentialProviderModelSelectionV1 | null>(() => {
        const binding = findAssignedProviderModelCredentialBinding(input.draft?.teamCredentialBindings);
        const legacyRef = input.draft?.modelSelection?.ref;
        const ref = legacyRef ?? binding?.providerModelSelection;
        if (!binding?.teamId || !ref || (legacyRef && legacyRef.providerConnectionId !== null)) return null;
        return {
            kind: 'team_credential_provider_model', teamId: binding.teamId, resourceId: binding.resourceId,
            expectedResourceRevision: binding.expectedResourceRevision, deliveryMode: binding.deliveryMode,
            agentTargetKey: ref.agentTargetKey, modelId: ref.modelId,
            ...(binding.nativeDelivery ? { nativeDelivery: binding.nativeDelivery } : {}),
        };
    }, [input.draft?.modelSelection, input.draft?.teamCredentialBindings]);
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
    setModelSelectionForBackendTarget: (agentTargetKey: string, selection: SessionModelSelectionV1 | null) => void;
}>) {
    React.useEffect(() => {
        if (!input.selection || input.selection.agentTargetKey === input.agentTargetKey) return;
        input.setModelSelectionForBackendTarget(input.selection.agentTargetKey, null);
        input.setSelection(null);
    }, [input.agentTargetKey, input.selection, input.setModelSelectionForBackendTarget, input.setSelection]);
}
