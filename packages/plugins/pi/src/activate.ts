import type { PluginApi } from '@happier-dev/plugin-sdk';

import { piExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { piExternalSessionObservationContribution } from './agent/externalSessions/observation.js';
import { createPiAgentRuntime } from './agent/runtime/engine.js';

export function activate(api: PluginApi): void {
  api.agents.register('pi', createPiAgentRuntime);
  api.agents.registerExternalSessions('pi', piExternalSessionsContribution);
  api.agents.registerExternalSessionObservation(
    'pi',
    piExternalSessionObservationContribution,
  );
}
