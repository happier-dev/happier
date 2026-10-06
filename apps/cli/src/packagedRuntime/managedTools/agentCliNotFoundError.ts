import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';

export const AGENT_CLI_MISSING_PREVIEW =
  'Agent CLI is unavailable. Install the CLI or fix its configured path, then restart the daemon.';

/** Resolution failed before an Agent process or Session could be created. */
export class AgentCliNotFoundError extends ReferenceError {
  readonly code = SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING;
  readonly errorCode = SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING;

  constructor(readonly agentId: string, message: string) {
    super(message);
    this.name = 'AgentCliNotFoundError';
  }
}
