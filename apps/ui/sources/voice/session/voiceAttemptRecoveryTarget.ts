import { storage } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveVoiceExecutionMachinePresentationFromState } from '@/voice/credentials/useExecutionMachinePresentation';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import type { VoiceAdapterSurfaceCapabilities, VoiceAttemptRecoveryTarget } from './types';
import type { VoiceAgentSelectionObserver } from '@/voice/binding/voiceConversationBindingTypes';

/** Called at Start admission, before preparation awaits or preferences can move. */
export function captureVoiceAttemptRecoveryTarget(
  capabilities: VoiceAdapterSurfaceCapabilities | null,
  target: SessionAddress | null,
  selectedAgent?: Parameters<VoiceAgentSelectionObserver>[0],
): VoiceAttemptRecoveryTarget | null {
  const state = storage.getState();
  const serverId = selectedAgent?.serverId ?? target?.serverId ?? state.profileScope?.serverId;
  if (!serverId) return null;
  const session = target ? state.sessions[target.sessionId] : null;
  const metadata = session?.serverId === serverId && session ? readSessionOwnerMetadataView(session) : null;
  const execution = target ? null : resolveVoiceExecutionMachinePresentationFromState(state);
  const machineId = selectedAgent?.machineId ?? (target ? metadata?.machineId : execution?.selectedMachineId);
  if (typeof machineId !== 'string' || !machineId.trim()) return null;
  const agent = selectedAgent?.identity ?? capabilities?.agentRuntime;
  return Object.freeze({
    serverId, machineId,
    machineLabel: (!selectedAgent || execution?.selectedMachineId === machineId ? execution?.machineLabel : null) ?? getMachineDisplayName(
      resolveMachineForActiveServerFromState(state, machineId, { serverId }) ?? { id: machineId, absence: 'unlisted' },
    ),
    agentRuntime: agent ? Object.freeze({ pluginId: agent.pluginId, localId: agent.localId }) : null,
  });
}
