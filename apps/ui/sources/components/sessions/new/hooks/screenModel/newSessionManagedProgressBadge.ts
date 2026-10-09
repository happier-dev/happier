import * as React from 'react';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import {
    buildManagedProgressStatusBadge,
    type ManagedProgressModel,
} from '@/components/machines/managed/managedComposerBadges';
import {
    describeActionOperationStatusLabel,
    resolveActionOperationStatus,
} from '@/components/inbox/actionOperations/actionOperationPresentation';
import { describeManagedLifecycleState } from '@/components/settings/machines/managed/managedLifecyclePresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import type { NewSessionManagedMachineDraftModel } from '../newSessionScreenModelTypes';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';

/** The Home a created machine joins, by the name the user knows it by. */
function managedCreationHomeName(homeId: string): string {
    return resolveHomeDisplayLabel(listServerProfiles().find(candidate => candidate.serverIdentityId === homeId), homeId);
}

/** Adapt existing draft and operation observations; no inferred stage journal or native policy. */
export function buildNewSessionManagedProgressBadge(
    draft: NewSessionManagedMachineDraftModel | undefined,
): AgentInputStatusBadge | null {
    if (!draft?.selection || draft.progress.kind === 'idle' || draft.progress.kind === 'ready') return null;
    const { selection, progress } = draft;
    const machineName = selection.receipt.launch.name;
    const setup = progress.kind === 'setup_pending' || progress.kind === 'failed' ? progress.environmentSetup : undefined;
    const operation = progress.kind === 'acquiring' || progress.kind === 'failed' ? progress.operation
        : progress.kind === 'setup_pending' && progress.operation?.scope.machineId === progress.machineId ? progress.operation : undefined;
    const observedStatus = operation ? resolveActionOperationStatus(operation,
        (progress.kind === 'acquiring' || progress.kind === 'failed' ? progress.operationObservation : undefined) ?? 'available') : null;
    const failed = progress.kind === 'failed' || operation?.state === 'failed';
    const label = setup ? progress.kind === 'failed'
        ? `${t('managedMachines.creation.setup')} · ${t('inbox.actionOperations.status.failed')}`
        : observedStatus ? describeActionOperationStatusLabel(observedStatus.label) : t('managedMachines.creation.setup')
        : observedStatus ? describeActionOperationStatusLabel(observedStatus.label)
        : progress.kind === 'approval' ? t('managedMachines.creation.approval', { name: machineName })
            : progress.kind === 'enrollment_pending' ? describeManagedLifecycleState({ kind: 'resourceReady' }).line
                : failed ? t('inbox.actionOperations.status.failed')
                    : describeManagedLifecycleState({ kind: 'creationWaiting', name: machineName }).line;
    // A setup row exists only on a joined machine, so Create, Install and Join are observed facts by then.
    const joinedStages: ManagedProgressModel['stages'] = [
        { id: 'create', label: t('managedMachines.creation.create'), status: 'done' },
        { id: 'install', label: t('managedMachines.creation.install'), status: 'done' },
        { id: 'join', label: t('managedMachines.creation.join', { home: managedCreationHomeName(selection.selection.homeId) }), status: 'done' },
    ];
    const stages: ManagedProgressModel['stages'] = setup ? [...joinedStages, { id: 'setup', label: t('managedMachines.creation.setup'),
        status: setup.state === 'failed' ? 'failed' : setup.state === 'succeeded' || setup.state === 'skipped' ? 'done'
            : setup.state === 'running' && (!observedStatus || observedStatus.tone === 'active') ? 'active' : 'pending' }]
        : operation?.progress?.kind === 'phase'
        ? [{ id: operation.progress.phase, label: operation.progress.label,
            status: operation.state === 'failed' ? 'failed' : operation.state === 'succeeded' ? 'done'
                : observedStatus?.tone === 'active' ? 'active' : 'pending' }]
        : [];
    return buildManagedProgressStatusBadge({
        machineName, mark: React.createElement(Icon, { name: 'desktop', size: 16 }),
        recipe: selection.receipt.preset?.name ?? '', stages, failed, label,
        ...(failed ? { failureLabel: label, failureTitle: setup ? t('managedMachines.creation.setupFailedTitle', { name: machineName }) : `${machineName} · ${label}` } : {}),
        tone: failed ? 'warning' : setup?.state === 'pending' || observedStatus && observedStatus.tone !== 'active' ? 'neutral' : 'active',
        message: setup ? progress.kind === 'failed' ? t('managedMachines.creation.setupFailedHelp')
            : t('managedMachines.creation.setupWaiting', { name: machineName }) : failed ? operation?.error?.error ?? t('newSession.failedToStart')
            : t('managedMachines.creation.messageWaiting', { name: machineName }),
        archiveChoice: draft.updateArchiveEffect ? {
            value: selection.archiveEffect, onChange: draft.updateArchiveEffect,
            availability: draft.archiveChoiceAvailability ?? undefined,
            supportedEffects: draft.archiveChoiceAvailability?.supportedEffects ?? ['keep'],
        } : undefined,
        onCancel: draft.cancel,
        onRetryInstall: progress.kind === 'failed' && progress.retryInstallationAvailable === true
            ? draft.retryInstallation : undefined,
        onRetrySetup: progress.kind === 'failed' && progress.retrySetupAvailable === true ? draft.retrySetup : undefined,
        onContinueWithoutSetup: progress.kind === 'failed' && progress.retrySetupAvailable === true ? draft.continueWithoutSetup : undefined,
        onDeleteMachine: progress.kind === 'failed' && progress.retrySetupAvailable === true ? draft.deleteMachine : undefined,
    });
}
