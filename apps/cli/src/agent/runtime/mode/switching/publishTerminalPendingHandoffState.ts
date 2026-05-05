import type { AgentState } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { TerminalPendingHandoffStateV1 } from '@/agent/runtime/terminal/_types';

export function publishTerminalPendingHandoffState(params: Readonly<{
  session: Readonly<{ updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void }>;
  status: TerminalPendingHandoffStateV1;
}>): void {
  updateAgentStateBestEffort(
    params.session,
    (current) => ({
      ...current,
      terminalControl: {
        ...(current.terminalControl ?? {}),
        pendingHandoffV1: params.status,
      },
    }),
    '[runtime/mode/switching]',
    'publish_terminal_pending_handoff',
  );
}
