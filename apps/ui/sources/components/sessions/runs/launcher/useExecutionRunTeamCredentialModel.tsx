import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { TeamCredentialProviderModelSelectionV1Schema, type TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import * as React from 'react';

import { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';
import { resourceHasAvailableTeamCredentialProviderModel } from '@/components/sessions/teamCredentials/teamCredentialProviderModelCurrentness';
import { useTeamCredentialSelectionCoordinator } from '@/components/sessions/teamCredentials/useTeamCredentialSelectionCoordinator';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';

export type ExecutionRunTeamCredentialModel = Readonly<{
    /** The Team credential model this start will run on, when one is chosen. */
    selected: TeamCredentialProviderModelSelectionV1 | null;
    /** False while a chosen model is no longer offered by its Team; the start must wait. */
    available: boolean;
    /** The picker, only when a Team offers models for the chosen Agent (or one is chosen). */
    picker: React.ReactNode;
}>;

/**
 * A Team credential model for a start: the Home's catalog of Team-provided models for the chosen
 * Agent, the consent a team-visible binding needs, and the currentness checks before and after the
 * person confirms. The action input is the one store of the choice (`teamCredentialModel`,
 * `teamCredentialSessionBindingConsent`, `modelId`); this hook only reads and writes it.
 */
export function useExecutionRunTeamCredentialModel(params: Readonly<{
    sessionId: string | null;
    serverId: string | null;
    selectedBackendChoice: ExecutionRunLauncherBackendChoice | null;
    hasBackendChoices: boolean;
    actionInput: Record<string, unknown>;
    setActionInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
    onSelectionChange?: () => void;
}>): ExecutionRunTeamCredentialModel {
    const { sessionId, serverId, setActionInput, onSelectionChange } = params;
    const credentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId,
    });
    const selected = React.useMemo(() => {
        const parsed = TeamCredentialProviderModelSelectionV1Schema.safeParse(params.actionInput.teamCredentialModel);
        return parsed.success ? parsed.data : null;
    }, [params.actionInput.teamCredentialModel]);
    const selectedAgentTargetKey = params.selectedBackendChoice
        ? buildBackendTargetKeyV2(params.selectedBackendChoice.backendTarget)
        : null;
    const catalog = useHomeTeamCredentialModelCatalog({
        serverId,
        enabled: credentialResourcesEnabled && Boolean(serverId && selectedAgentTargetKey),
    });
    const catalogRef = React.useRef(catalog);
    catalogRef.current = catalog;
    const coordinate = useTeamCredentialSelectionCoordinator(serverId);

    const available = React.useMemo(() => {
        if (!selected) return true;
        if (!catalog.current) return false;
        if (!catalog.currentResourceKeys.has(`${selected.teamId}:${selected.resourceId}`)) return false;
        const resource = catalog.resources.find((candidate) => (
            candidate.id === selected.resourceId && candidate.teamId === selected.teamId
        ));
        return resource ? resourceHasAvailableTeamCredentialProviderModel(resource, selected) : false;
    }, [catalog.current, catalog.currentResourceKeys, catalog.resources, selected]);

    // A model belongs to the Agent it was chosen for; choosing another Agent drops it.
    React.useEffect(() => {
        if (!selected || !params.hasBackendChoices) return;
        if (selectedAgentTargetKey === selected.agentTargetKey) return;
        setActionInput((previous) => {
            const next = { ...previous };
            delete next.teamCredentialModel;
            delete next.teamCredentialSessionBindingConsent;
            if (next.modelId === selected.modelId) delete next.modelId;
            return next;
        });
    }, [params.hasBackendChoices, selected, selectedAgentTargetKey, setActionInput]);

    const onSelectTeamCredentialModel = React.useCallback(async (selection: TeamCredentialProviderModelSelectionV1) => {
        const resourceKey = `${selection.teamId}:${selection.resourceId}`;
        const isStillOffered = () => catalogRef.current.current
            && catalogRef.current.currentResourceKeys.has(resourceKey)
            && catalogRef.current.resources.some((resource) => (
                resource.teamId === selection.teamId
                && resource.id === selection.resourceId
                && resourceHasAvailableTeamCredentialProviderModel(resource, selection)
            ));
        const selectedResource = catalog.resources.find((resource) => (
            resource.teamId === selection.teamId
            && resource.id === selection.resourceId
            && resource.resourceRevision === selection.expectedResourceRevision
        ));
        if (!selectedResource
            || !catalog.current
            || !catalog.currentResourceKeys.has(resourceKey)
            || !resourceHasAvailableTeamCredentialProviderModel(selectedResource, selection)) return;
        const outcome = await coordinate({
            resource: selectedResource,
            deliveryMode: selection.deliveryMode,
            selection,
            isCurrent: isStillOffered,
        });
        if (outcome.kind !== 'continue') return;
        const teamVisible = outcome.consequence.visibilityRequirement === 'team_visibility_required';
        if (teamVisible) {
            const confirmed = await Modal.confirm(
                t('teams.credentials.usePolicy.label'),
                t('teams.credentials.usePolicy.visibilityNote'),
                { confirmText: t('common.continue'), cancelText: t('common.cancel') },
            );
            if (!confirmed) return;
        }
        if (!isStillOffered()) return;
        onSelectionChange?.();
        setActionInput((previous) => {
            const next: Record<string, unknown> = {
                ...previous,
                teamCredentialModel: outcome.selection,
                modelId: outcome.selection.modelId,
                ...(teamVisible && sessionId
                    ? {
                        teamCredentialSessionBindingConsent: {
                            v: 1,
                            sessionId,
                            teamId: outcome.selection.teamId,
                            resourceId: outcome.selection.resourceId,
                            expectedResourceRevision: outcome.selection.expectedResourceRevision,
                        },
                    }
                    : {}),
            };
            if (!teamVisible || !sessionId) delete next.teamCredentialSessionBindingConsent;
            delete next.modelSelection;
            return next;
        });
    }, [catalog.current, catalog.currentResourceKeys, catalog.resources, coordinate, onSelectionChange, sessionId, setActionInput]);

    const onSelectNonTeamModel = React.useCallback((selection: unknown) => {
        if (selection !== null) return;
        onSelectionChange?.();
        setActionInput((previous) => {
            const next = { ...previous };
            delete next.teamCredentialModel;
            delete next.teamCredentialSessionBindingConsent;
            delete next.modelId;
            return next;
        });
    }, [onSelectionChange, setActionInput]);

    const picker = selectedAgentTargetKey && (catalog.resources.length > 0 || selected) ? (
        <SessionModelPicker
            agentTargetKey={selectedAgentTargetKey}
            nativeModels={[{ value: 'default', label: t('settingsAgents.defaultModelTitle') }]}
            providerGroups={[]}
            teamCredentialResources={catalog.resources}
            teamNameById={catalog.teamNameById}
            homeNameByTeamId={catalog.homeNameByTeamId}
            currentTeamCredentialResourceKeys={catalog.currentResourceKeys}
            selectedTeamCredentialModel={selected}
            providerProjectionAuthoritative
            selected={null}
            effectiveLabel=""
            showTitle={false}
            onSelect={onSelectNonTeamModel}
            onSelectTeamCredentialModel={onSelectTeamCredentialModel}
        />
    ) : null;

    return { selected, available, picker };
}
