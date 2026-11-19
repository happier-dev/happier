import { presentAgentInstallJobFailure } from '@/agents/machineAgents/installJobs/presentAgentInstallJobFailure';
import { t } from '@/text';
import type { MachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import type { MachineAgentRowAction, MachineAgentStatus } from './machineAgentPresentation';

/** Read-only wording for the execution prerequisite already decided by the inventory owner. */
export function formatMachineAgentExecutionState(state: MachineAgentExecutionStateV1): string {
    switch (state) {
        case 'ready': return t('machineAgents.signedInHere');
        case 'needsSignIn': return t('machineAgents.needsSignIn');
        case 'notInstalled': return t('machineAgents.notInstalled');
        case 'unsupported': return t('machineAgents.unsupported');
        case 'checking': return t('machineAgents.checking');
        case 'unknown': return t('machineAgents.unknown');
    }
}

/** The words of a status line; one message per state (the presentation resolver picked the state). */
export function formatMachineAgentStatus(status: MachineAgentStatus): string {
    switch (status.kind) {
        case 'ready': {
            const base = status.label
                ? (status.via === 'connected' ? t('machineAgents.signedInWith', { label: status.label }) : t('machineAgents.signedInAs', { label: status.label }))
                : formatMachineAgentExecutionState(status.kind);
            return status.updateTo ? `${base} · ${t('machineAgents.updateTo', { version: status.updateTo })}` : base;
        }
        case 'needsSignIn': return formatMachineAgentExecutionState(status.kind);
        case 'waitingForSignIn': return t('machineAgents.waitingForSignIn');
        case 'notInstalled':
            if (status.manual) return t('machineAgents.installYourself');
            return status.sizeBytes
                ? `${formatMachineAgentExecutionState(status.kind)} · ${t('machineAgents.downloadSize', { size: formatHappierDataBytes(status.sizeBytes, { kind: 'storage' }) })}`
                : formatMachineAgentExecutionState(status.kind);
        case 'unsupported': return formatMachineAgentExecutionState(status.kind);
        case 'installing': {
            const step = status.stepLabel ?? t('machineAgents.installing');
            if (status.bytesDone !== null && status.bytesTotal) {
                return `${step} · ${t('machineAgents.progress', { done: formatHappierDataBytes(status.bytesDone, { kind: 'storage' }), total: formatHappierDataBytes(status.bytesTotal, { kind: 'storage' }) })}`;
            }
            return step;
        }
        case 'failed': return presentAgentInstallJobFailure(status.failure).title;
        case 'checking': return formatMachineAgentExecutionState(status.kind);
        case 'offline':
            switch (status.lastKnown) {
                case 'signedIn': return t('machineAgents.offlineSignedIn');
                case 'signedOut': return t('machineAgents.offlineSignedOut');
                case 'notInstalled': return t('machineAgents.offlineNotInstalled');
                case 'unknown': return t('machineAgents.offlineUnknown');
            }
            return t('machineAgents.offlineUnknown');
        // The classified reason stays on the typed status for diagnostics. It is not product copy.
        case 'unavailable': return t('machineAgents.unknown');
        case 'signInUnknown': return t('machineAgents.signInUnknown');
        case 'unknown': return formatMachineAgentExecutionState(status.kind);
    }
}

/**
 * An offline machine's last-known fact alone ("Last seen signed in"), for a list that already says once which
 * machines are offline; null when nothing was known. Elsewhere `formatMachineAgentStatus` keeps "machine offline".
 */
export function formatMachineAgentLastKnown(status: Extract<MachineAgentStatus, { kind: 'offline' }>): string | null {
    switch (status.lastKnown) {
        case 'signedIn': return t('machineAgents.lastSeenSignedIn');
        case 'signedOut': return t('machineAgents.lastSeenSignedOut');
        case 'notInstalled': return t('machineAgents.lastSeenNotInstalled');
        case 'unknown': return null;
    }
}


export function formatMachineAgentAction(action: MachineAgentRowAction): string {
    switch (action.kind) {
        case 'install': return t('machineAgents.actionInstall');
        case 'update': return t('machineAgents.actionUpdate');
        case 'signIn': return t('machineAgents.actionSignIn');
        case 'retry': return t('machineAgents.actionRetry');
        case 'cancel': return t('machineAgents.actionCancel');
        case 'showTerminal': return t('machineAgents.actionShowTerminal');
        case 'guide': return t('machineAgents.actionGuide');
        case 'remove': return t('machineAgents.actionRemove');
    }
}
