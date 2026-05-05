import type {
  AgentId,
  TerminalLifecycleObservation,
} from '@/agent/runtime/terminal/_types';
import { mapRuntimeMessageToTerminalLifecycleObservation } from '@/agent/runtime/terminal/runtimeMessageObservationAdapter';

export function mapCodexRuntimeMessageToTerminalLifecycleObservation(params: Readonly<{
  agentId: AgentId;
  message: unknown;
}>): TerminalLifecycleObservation | null {
  return mapRuntimeMessageToTerminalLifecycleObservation(params);
}
