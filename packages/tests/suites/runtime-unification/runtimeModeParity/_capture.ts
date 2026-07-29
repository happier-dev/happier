import { RuntimeEventV1Schema, type RuntimeEventV1 } from '@happier-dev/protocol/runtime';

export type RuntimeMode = 'terminal' | 'remote';
export type RuntimeModeSwitchReason =
  | 'user_request'
  | 'incoming_ui_message'
  | 'terminal_unavailable'
  | 'remote_takeover'
  | 'host_recovery';

export function createRuntimeModeChangeEvent(params: Readonly<{
  sessionId: string;
  emittedAtMs: number;
  from: RuntimeMode;
  to: RuntimeMode;
  reason: RuntimeModeSwitchReason;
  providerSessionId: string;
}>): RuntimeEventV1 {
  return RuntimeEventV1Schema.parse({
    kind: 'runtime-status-change',
    sessionId: params.sessionId,
    emittedAtMs: params.emittedAtMs,
    status: 'runtime_mode_changed',
    detail: {
      kind: 'runtime-mode-change',
      from: params.from,
      to: params.to,
      reason: params.reason,
      resumeId: params.providerSessionId,
    },
  });
}
