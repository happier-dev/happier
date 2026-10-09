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

/** Adapt existing draft and operation observations; no inferred stage journal or native policy. */
export function buildNewSessionManagedProgressBadge(
    draft: NewSessionManagedMachineDraftModel | undefined,
): AgentInputStatusBadge | null {
    if (!draft?.selection || draft.progress.kind === 'idle' || draft.progress.kind === 'ready') return null;
    const { selection, progress } = draft;
    const machineName = selection.receipt.launch.name;
    const operation = progress.kind === 'acquiring' || progress.kind === 'failed' ? progress.operation : undefined;
    const observedStatus = operation ? resolveActionOperationStatus(operation,
        (progress.kind === 'acquiring' || progress.kind === 'failed' ? progress.operationObservation : undefined) ?? 'available') : null;
    const failed = progress.kind === 'failed' || operation?.state === 'failed';
    const label = observedStatus ? describeActionOperationStatusLabel(observedStatus.label)
        : progress.kind === 'approval' ? t('managedMachines.creation.approval', { name: machineName })
            : progress.kind === 'enrollment_pending' ? describeManagedLifecycleState({ kind: 'resourceReady' }).line
                : failed ? t('inbox.actionOperations.status.failed')
                    : describeManagedLifecycleState({ kind: 'creationWaiting', name: machineName }).line;
    const stages: ManagedProgressModel['stages'] = operation?.progress?.kind === 'phase'
        ? [{ id: operation.progress.phase, label: operation.progress.label,
            status: operation.state === 'failed' ? 'failed' : operation.state === 'succeeded' ? 'done'
                : observedStatus?.tone === 'active' ? 'active' : 'pending' }]
        : [];
    return buildManagedProgressStatusBadge({
        machineName, mark: React.createElement(Icon, { name: 'desktop', size: 16 }),
        recipe: selection.receipt.preset?.name ?? '', stages, failed, label,
        ...(failed ? { failureLabel: label, failureTitle: `${machineName} · ${label}` } : {}),
        tone: failed ? 'warning' : observedStatus && observedStatus.tone !== 'active' ? 'neutral' : 'active',
        message: failed ? operation?.error?.error ?? t('newSession.failedToStart')
            : t('managedMachines.creation.messageWaiting', { name: machineName }),
        archiveChoice: draft.updateArchiveEffect ? {
            value: selection.archiveEffect, onChange: draft.updateArchiveEffect,
            availability: draft.archiveChoiceAvailability ?? undefined,
            supportedEffects: draft.archiveChoiceAvailability?.supportedEffects ?? ['keep'],
        } : undefined,
        onCancel: draft.cancel,
        onRetryInstall: progress.kind === 'failed' && progress.retryInstallationAvailable === true
            ? draft.retryInstallation : undefined,
    });
}
