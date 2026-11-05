import type { SessionRunnerRespawnTerminalReason } from '../processSupervision/sessionRunnerRespawn';
import type { RestartSessionRunnerCompletion } from './restartSessionRunnerOnCurrentRuntime';

export function buildVersionRuntimeRefreshTerminalCompletion(
  reason: SessionRunnerRespawnTerminalReason,
  detail?: string,
): RestartSessionRunnerCompletion {
  // The respawn owner supplies the closed refusal code as terminal detail.
  const diagnostics = { respawnTerminalReason: reason, ...(detail ? { detail, errorCode: detail } : {}) };
  if (reason === 'not_authenticated' || reason === 'agent_signed_out') {
    return { ok: false, status: 'spawn_failed', reasonCode: 'missing_credentials', diagnostics };
  }
  if (reason === 'missing_spawn_options') {
    return { ok: false, status: 'spawn_failed', reasonCode: 'missing_spawn_options', diagnostics };
  }
  if (reason === 'already_running') {
    return { ok: false, status: 'partial_failure', reasonCode: 'restart_already_running', diagnostics };
  }
  if (reason === 'stop_requested') return { ok: false, status: 'partial_failure', diagnostics };
  return { ok: false, status: 'spawn_failed', diagnostics };
}
