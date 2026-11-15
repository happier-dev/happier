import * as React from 'react';

import { useWorkspaceSyncRelationships, useWorkspaceRefs, useMachineDisplayNamesById } from '@/sync/domains/state/storage';
import {
    projectWorkspaceSyncRelationships,
    projectWorkspaceSyncRelationshipSummaries,
    resolveWorkspaceSyncSetSummaries,
    type WorkspaceSyncRelationshipSummary,
} from './workspaceSyncRelationshipModel';
import {
    getWorkspaceSyncStatusSnapshot,
    refreshWorkspaceSyncStatuses,
    subscribeWorkspaceSyncStatus,
    type WorkspaceSyncStatusScope,
} from './workspaceSyncStatusStore';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import { useProjectAccountRows, useProjectAccountWorkspaceRef } from '@/sync/domains/workspaces/projectAccountRows';
import { useHostActivelyViewedEffect } from '@/utils/runtime/useHostActivelyViewed';
import { resolveWorkspaceSyncRelationshipStateLabel, type WorkspaceSyncRelationshipStateLabelKey } from './workspaceSyncPresentation';

function scopeFor(summary: WorkspaceSyncRelationshipSummary): WorkspaceSyncStatusScope {
    const controllerEndpoint = [summary.alpha, summary.beta].find(
        (endpoint) => endpoint.workspaceRef?.machineId === summary.relationship.controllerMachineId,
    );
    return {
        relationshipId: summary.relationshipId,
        controllerMachineId: summary.relationship.controllerMachineId,
        serverId: controllerEndpoint?.workspaceRef?.serverId
            ?? summary.alpha.workspaceRef?.serverId
            ?? summary.beta.workspaceRef?.serverId,
    };
}

/** Relationship definitions with their endpoints named, before any daemon status: the one projection every reader shares. */
function useWorkspaceSyncBaseSummaries(serverId?: string): readonly WorkspaceSyncRelationshipSummary[] {
    const rawRelationships = useWorkspaceSyncRelationships();
    const workspaceRefs = useWorkspaceRefs();
    const relationshipModel = React.useMemo(
        () => projectWorkspaceSyncRelationships(rawRelationships),
        [rawRelationships],
    );
    const machineIds = React.useMemo(() => {
        return relationshipModel.all.flatMap((relationship) => [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]
            .flatMap((id) => { const result = resolveWorkspaceRefById(workspaceRefs, id, serverId);
                return result.kind === 'resolved' ? [result.ref.machineId] : []; }));
    }, [relationshipModel, serverId, workspaceRefs]);
    const machineNamesById = useMachineDisplayNamesById(machineIds);
    return React.useMemo(
        () => projectWorkspaceSyncRelationshipSummaries({ relationships: relationshipModel, workspaceRefs, statuses: [], machineNamesById, serverId }),
        [machineNamesById, relationshipModel, serverId, workspaceRefs],
    );
}

/**
 * One persisted link as the app names it, without subscribing to its status: for readers that only
 * name the folders and machines (an approval for a link), never watch it.
 */
export function useWorkspaceSyncRelationshipSummary(
    relationshipId: string | null,
    serverId?: string,
): WorkspaceSyncRelationshipSummary | null {
    const relationship = useProjectAccountRows(rows => rows?.relationships.find(row => row.relationshipId === relationshipId) ?? null,
        relationshipId !== null);
    const alpha = useProjectAccountWorkspaceRef(relationship?.alphaWorkspaceRefId ?? null, serverId);
    const beta = useProjectAccountWorkspaceRef(relationship?.betaWorkspaceRefId ?? null, serverId);
    const workspaceRefs = [...(alpha ? [alpha] : []), ...(beta && beta !== alpha ? [beta] : [])];
    const machineNamesById = useMachineDisplayNamesById(workspaceRefs.map(ref => ref.machineId));
    return projectWorkspaceSyncRelationshipSummaries({
        relationships: projectWorkspaceSyncRelationships(relationship ? [relationship] : null),
        workspaceRefs, statuses: [], machineNamesById, serverId,
    })[0] ?? null;
}

export function useWorkspaceSyncRelationshipSummaries(
    workspaceRefId?: string | null,
    serverId?: string,
): readonly WorkspaceSyncRelationshipSummary[] {
    const baseSummaries = useWorkspaceSyncBaseSummaries(serverId);
    const scopedBaseSummaries = React.useMemo(
        () => workspaceRefId === undefined
            ? baseSummaries
            : workspaceRefId === null ? [] : resolveWorkspaceSyncSetSummaries(baseSummaries, workspaceRefId),
        [baseSummaries, workspaceRefId],
    );
    const [revision, incrementRevision] = React.useReducer((value: number) => value + 1, 0);
    useHostActivelyViewedEffect((activelyViewed) => {
        if (!activelyViewed) return;
        const idleScopes: WorkspaceSyncStatusScope[] = [];
        const unsubscribers = scopedBaseSummaries.map((summary) => {
            if (!summary.relationship.enabled) return () => {};
            if (!summary.alpha.workspaceRef || !summary.beta.workspaceRef) return () => {};
            const scope = scopeFor(summary);
            const unsubscribe = subscribeWorkspaceSyncStatus(scope, incrementRevision);
            if (getWorkspaceSyncStatusSnapshot(scope).phase === 'idle') {
                idleScopes.push(scope);
            }
            return unsubscribe;
        });
        if (idleScopes.length > 0) void refreshWorkspaceSyncStatuses(idleScopes).catch(() => undefined);
        return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    }, [scopedBaseSummaries]);

    return React.useMemo(() => {
        return scopedBaseSummaries.map((summary) => ({
            ...summary,
            status: summary.relationship.enabled && summary.alpha.workspaceRef && summary.beta.workspaceRef
                ? getWorkspaceSyncStatusSnapshot(scopeFor(summary)).status : null,
        }));
    }, [revision, scopedBaseSummaries]);
}

export function resolveWorkspaceSyncStatusScope(summary: WorkspaceSyncRelationshipSummary): WorkspaceSyncStatusScope {
    return scopeFor(summary);
}

/**
 * The one human state of a link, for every surface that names it (its row and its Details): the
 * summary's live status plus whether the controller's status read failed, read from the status
 * store this module subscribes for those surfaces.
 */
export function resolveWorkspaceSyncSummaryStateLabel(summary: WorkspaceSyncRelationshipSummary): WorkspaceSyncRelationshipStateLabelKey {
    return resolveWorkspaceSyncRelationshipStateLabel({
        enabled: summary.relationship.enabled,
        statusState: summary.status?.state,
        errorCode: summary.status?.errorCode,
        statusPhase: getWorkspaceSyncStatusSnapshot(scopeFor(summary)).phase,
    });
}
