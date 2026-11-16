import * as React from 'react';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import {
    buildManagedProgressStatusBadge,
    type ManagedProgressModel,
} from '@/components/machines/managed/managedComposerBadges';
import { describeManagedCreationProgress } from '@/components/settings/machines/managed/managedCreationProgressPresentation';
import { describeManagedActionFailureDiagnostic } from '@/components/settings/machines/managed/managedNativeFailurePresentation';
import { describeManagedInstallationFailure, isManagedCreationInterrupted, managedCreationStages } from '@/components/settings/machines/managed/managedCreationPresentation';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { readMachineAddDevice } from '@/components/machines/add/useMachineAddPaths';
import { ManagedPresetMark } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { t } from '@/text';
import type { NewSessionManagedMachineDraftModel } from '../newSessionScreenModelTypes';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { readManagedMachineSelectionName, readManagedMachineSelectionReceipt } from '@/sync/domains/state/newSessionManagedMachineDraft';

/** The Home a created machine joins, by the name the user knows it by. */
function managedCreationHomeName(homeId: string): string {
    return resolveHomeDisplayLabel(listServerProfiles().find(candidate => candidate.serverIdentityId === homeId), homeId);
}

const DEVICE_GLYPH = { phone: 'device-mobile', browser: 'globe', desktop: 'laptop' } as const;

/**
 * Who does the work (58d U5). A receipt with no controller is created, installed and joined by the app that
 * pressed Create: this device, which the device-local draft names. A controller's creation says nothing here.
 */
function managedCreationOrigin(receipt: ReturnType<typeof readManagedMachineSelectionReceipt>) {
    if (!receipt || receipt.controller) return null;
    const device = readMachineAddDevice();
    const label = device === 'phone' ? t('managedMachines.creation.fromThis.phone')
        : device === 'browser' ? t('managedMachines.creation.fromThis.browser') : t('managedMachines.creation.fromThis.desktop');
    return { device, label };
}

/** Create, Install and Join as the retained row records them (58B-U1), in the badge's words. */
function rowStages(machine: Parameters<typeof managedCreationStages>[0], running: boolean, home: string): ManagedProgressModel['stages'] {
    return managedCreationStages(machine, running).map(stage => ({
        id: stage.id, state: stage.state,
        label: stage.id === 'create' ? t('managedMachines.creation.create') : stage.id === 'install'
            ? t('managedMachines.creation.install') : t('managedMachines.creation.join', { home }),
        ...(stage.note ? { meta: stage.note === 'notJoined' ? t('managedMachines.creation.notJoined') : t('managedMachines.creation.notConfirmed') } : {}),
    }));
}

/** Adapt existing draft and operation observations; no inferred stage journal or native policy. */
export function buildNewSessionManagedProgressBadge(
    draft: NewSessionManagedMachineDraftModel | undefined,
): AgentInputStatusBadge | null {
    if (!draft?.selection) return null;
    if (draft.progress.kind === 'idle') return buildInterruptedBadge(draft, draft.selection);
    if (draft.progress.kind === 'ready') return null;
    const { selection, progress } = draft;
    const receipt = readManagedMachineSelectionReceipt(selection);
    const machineName = readManagedMachineSelectionName(selection) ?? t('common.machine');
    const origin = managedCreationOrigin(receipt);
    const { setup, operation, observedStatus, failed, label, tone } = describeManagedCreationProgress(machineName, progress);
    const failureDiagnostic = failed ? progress.kind === 'failed' && progress.diagnosticDetail
        ? progress.diagnosticDetail : operation?.error
            ? describeManagedActionFailureDiagnostic(operation.error.errorCode, operation.error.details, operation.requestId, operation.error.failureCause) : undefined : undefined;
    const localRecipe = Boolean(origin) && progress.kind === 'acquiring' && !operation && !failed;
    // A setup row exists only on a joined machine, so Create, Install and Join are observed facts by then.
    const joinedStages: ManagedProgressModel['stages'] = [
        { id: 'create', label: t('managedMachines.creation.create'), state: 'done' },
        { id: 'install', label: t('managedMachines.creation.install'), state: 'done' },
        { id: 'join', label: t('managedMachines.creation.join', { home: managedCreationHomeName(selection.selection.homeId) }), state: 'done' },
    ];
    const stages: ManagedProgressModel['stages'] = setup ? [...joinedStages, { id: 'setup', label: t('managedMachines.creation.setup'),
        state: setup.state === 'failed' ? 'failed' : setup.state === 'succeeded' || setup.state === 'skipped' ? 'done'
            : setup.state === 'running' && (!observedStatus || observedStatus.tone === 'active') ? 'running' : 'upcoming' }]
        : operation?.progress?.kind === 'phase'
        ? [{ id: operation.progress.phase, label: operation.progress.label,
            state: operation.state === 'failed' ? 'failed' : operation.state === 'succeeded' ? 'done'
                : observedStatus?.tone === 'active' ? 'running' : 'upcoming' }]
        // This device runs the Account recipe and reports no operation: its row's facts are the stages.
        : localRecipe ? rowStages(draft.retainedMachine?.machine, true, managedCreationHomeName(selection.selection.homeId))
        : [];
    const current = localRecipe ? stages.find(stage => stage.state === 'running')?.id : undefined;
    return buildManagedProgressStatusBadge({
        // The provider's own mark, as the picker row that started it drew it (lab m-pick Aprogd).
        machineName, mark: React.createElement(ManagedPresetMark, { serverId: selection.selection.homeId,
            preset: { controller: receipt?.controller, launch: receipt?.launch }, size: 16 }),
        launch: receipt?.preset?.name ?? selection.presetOrigin?.name ?? '', stages, failed,
        // Without an operation to report, "waiting to create" is a controller's wait: this device is doing the current step.
        label: !localRecipe ? label : current === 'join' ? t('managedMachines.creation.joining', { name: machineName })
            : current === 'install' ? t('managedMachines.creation.installing', { name: machineName })
            : t('managedMachines.creation.creating', { name: machineName }),
        ...(origin ? { origin: origin.label } : {}),
        // This device runs the whole Account recipe while it acquires; once the resource is up it joins on its own.
        ...(origin && localRecipe ? { hold: {
            text: t('managedMachines.creation.keepOpen', { name: machineName }), icon: DEVICE_GLYPH[origin.device] } } : {}),
        ...(failed ? { failureLabel: label, failureTitle: setup ? t('managedMachines.creation.setupFailedTitle', { name: machineName }) : `${machineName} · ${label}` } : {}),
        tone,
        message: [setup ? progress.kind === 'failed' ? t('managedMachines.creation.setupFailedHelp')
            : t('managedMachines.creation.setupWaiting', { name: machineName }) : failed ?
                (operation?.error ? describeManagedInstallationFailure(operation.error, operation.progress)
                    : progress.kind === 'failed' ? resolveSystemTaskFailureMessage({ code: progress.code, message: null }) ?? null : null) ?? t('newSession.failedToStart')
            : t('managedMachines.creation.messageWaiting', { name: machineName }), failureDiagnostic].filter(Boolean).join('\n'),
        archiveChoice: draft.updateArchiveEffect ? {
            scope: draft.creationScope ?? 'session',
            value: selection.archiveEffect, onChange: draft.updateArchiveEffect,
            availability: draft.archiveChoiceAvailability ?? undefined,
            supportedEffects: draft.archiveChoiceAvailability?.supportedEffects ?? ['keep'],
        } : undefined,
        onCancel: draft.cancel,
        onRetryInstall: progress.kind === 'failed' && progress.retryInstallationAvailable === true
            ? draft.retryInstallation : undefined,
        onRetrySetup: progress.kind === 'failed' && progress.retrySetupAvailable === true ? draft.retrySetup : undefined,
        onContinueWithoutSetup: progress.kind === 'failed' && progress.retrySetupAvailable === true ? draft.continueWithoutSetup : undefined,
        onDeleteMachine: progress.kind === 'failed' && (progress.retrySetupAvailable === true
            || progress.retryInstallationAvailable === true) ? draft.deleteMachine : undefined,
    });
}

/**
 * A creation this draft retains with nothing running for it (the app that did the work was closed): the
 * resource's recorded facts say what exists and what is missing, never a pause (58b L4, lab af-create Ip).
 */
function buildInterruptedBadge(
    draft: NewSessionManagedMachineDraftModel,
    selection: NonNullable<NewSessionManagedMachineDraftModel['selection']>,
): AgentInputStatusBadge | null {
    const retained = draft.retainedMachine;
    if (!retained || !isManagedCreationInterrupted(retained.machine)) return null;
    const receipt = readManagedMachineSelectionReceipt(selection);
    const machineName = readManagedMachineSelectionName(selection) ?? t('common.machine');
    const home = managedCreationHomeName(selection.selection.homeId);
    const origin = managedCreationOrigin(receipt);
    const mayBill = receipt?.billing.location !== 'local';
    return buildManagedProgressStatusBadge({
        machineName, mark: React.createElement(ManagedPresetMark, { serverId: selection.selection.homeId,
            preset: { controller: receipt?.controller, launch: receipt?.launch }, size: 16 }),
        launch: receipt?.preset?.name ?? selection.presetOrigin?.name ?? '', ...(origin ? { origin: origin.label } : {}),
        stages: rowStages(retained.machine, false, home),
        failed: false, label: t('managedMachines.creation.interruptedTitle'),
        message: mayBill ? t('managedMachines.creation.interruptedMayBill') : t('managedMachines.creation.interruptedWaiting'),
        recovery: {
            title: t('managedMachines.creation.interruptedTitle'),
            lead: t('managedMachines.creation.interruptedLead', { name: machineName, home }),
            onContinue: draft.retryInstallation, onInspect: retained.inspect,
        },
    });
}
