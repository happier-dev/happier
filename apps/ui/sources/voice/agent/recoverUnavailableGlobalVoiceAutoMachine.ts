import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { resolveMachineForActiveServerFromState, resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { t } from '@/text';
import { listPreferredMachineIds } from '@/components/settings/pickers/resolvePreferredMachineId';
import { promptDaemonUnavailableRetry } from '@/utils/errors/daemonUnavailableAlert';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { findVoiceConversationSessionId } from '@/voice/sessionBinding/voiceConversationSession';
import { persistVoiceAutoTargetMachineId, readVoiceAutoTargetMachineId } from '@/voice/sessionBinding/voiceAutoTargetMachineSettings';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { VOICE_AGENT_GLOBAL_SESSION_ID } from './voiceAgentGlobalSessionId';

type RecoveryDecision =
    | Readonly<{ kind: 'not_applicable' | 'cancel' | 'retry' }>
    | Readonly<{
          kind: 'switch';
          nextMachineId: string;
          replayConversation: boolean;
          replaySourceConversationSessionId: string | null;
      }>;

function readVoiceAgentSettings(state: any): any | null {
    return state?.settings?.voice?.adapters?.local_conversation?.agent ?? null;
}

function resolveBoundConversationSessionId(): string | null {
    return normalizeNonEmptyString(
        resolveVoiceSessionBindingByControlSessionId({
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            adapterId: 'local_conversation',
        })?.conversationSessionId,
    );
}

function resolveReplaySourceConversationSessionId(state: any): string | null {
    return (
        resolveBoundConversationSessionId()
        ?? findVoiceConversationSessionId(state)
        ?? null
    );
}

function resolveMachineName(machineId: string | null): string {
    if (!machineId) return t('status.unknown');
    const machine = resolveMachineForActiveServerFromState(storage.getState(), machineId);
    return getMachineDisplayName(machine) ?? machineId;
}

function resolveAlternateOnlineMachineId(state: any, stickyMachineId: string | null): string | null {
    const ordered = listPreferredMachineIds({
        machines: resolveVisibleMachinesForActiveServerFromState(state),
        recentMachinePaths: Array.isArray(state?.settings?.recentMachinePaths) ? state.settings.recentMachinePaths : [],
        preferredMachineId: stickyMachineId,
        onlineOnly: true,
    });

    for (const candidateMachineId of ordered) {
        if (candidateMachineId === stickyMachineId) continue;
        return candidateMachineId;
    }

    return null;
}

export async function recoverUnavailableGlobalVoiceAutoMachine(): Promise<RecoveryDecision> {
    let state: any = storage.getState();
    const agentSettings = readVoiceAgentSettings(state);
    if (!agentSettings) return { kind: 'not_applicable' };
    if ((agentSettings.backend ?? 'daemon') !== 'daemon') return { kind: 'not_applicable' };
    if ((agentSettings.machineTargetMode ?? 'auto') !== 'auto') return { kind: 'not_applicable' };

    const stickyMachineId = readVoiceAutoTargetMachineId(state);
    if (!stickyMachineId) return { kind: 'not_applicable' };

    let alternateMachineId = resolveAlternateOnlineMachineId(state, stickyMachineId);
    if (!alternateMachineId) {
        await sync.refreshMachinesThrottled({ force: true }).catch(() => {});
        state = storage.getState();
        alternateMachineId = resolveAlternateOnlineMachineId(state, stickyMachineId);
    }
    if (!alternateMachineId) {
        const resolution = await promptDaemonUnavailableRetry({
            titleKey: 'errors.daemonUnavailableTitle',
            bodyKey: 'errors.daemonUnavailableBody',
            machine: resolveMachineForActiveServerFromState(state, stickyMachineId),
        });
        return resolution === 'retry' ? { kind: 'retry' } : { kind: 'cancel' };
    }

    const switchConfirmed = await Modal.confirm(
        t('settingsVoice.local.conversation.machineRecovery.switchTitle'),
        t('settingsVoice.local.conversation.machineRecovery.switchBody', {
            currentMachine: resolveMachineName(stickyMachineId),
            nextMachine: resolveMachineName(alternateMachineId),
        }),
        {
            confirmText: t('settingsVoice.local.conversation.machineRecovery.switchAction'),
            cancelText: t('common.cancel'),
        },
    );
    if (!switchConfirmed) {
        return { kind: 'cancel' };
    }

    const replaySourceConversationSessionId = resolveReplaySourceConversationSessionId(state);
    let replayConversation = false;
    if (replaySourceConversationSessionId) {
        replayConversation = await Modal.confirm(
            t('settingsVoice.local.conversation.machineRecovery.replayTitle'),
            t('settingsVoice.local.conversation.machineRecovery.replayBody', {
                nextMachine: resolveMachineName(alternateMachineId),
            }),
            {
                confirmText: t('settingsVoice.local.conversation.machineRecovery.replayAction'),
                cancelText: t('settingsVoice.local.conversation.machineRecovery.startFreshAction'),
            },
        );
    }

    persistVoiceAutoTargetMachineId(alternateMachineId);

    return {
        kind: 'switch',
        nextMachineId: alternateMachineId,
        replayConversation,
        replaySourceConversationSessionId: replayConversation ? replaySourceConversationSessionId : null,
    };
}
