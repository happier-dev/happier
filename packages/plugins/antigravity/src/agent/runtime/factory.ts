import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { createAntigravityNativeRuntime } from './nativeRuntime.js';
import {
  createAntigravityNativeExecutionRunRuntime,
  createAntigravityNativeSessionRuntime,
} from './nativeSession.js';

export {
  antigravityExternalSessionsContribution,
} from '../cliPrint/externalSessions.js';

export const createAntigravityAgentRuntime: AgentRuntimeFactory = () =>
  createAntigravityNativeRuntime({
    openSession: createAntigravityNativeSessionRuntime,
    openExecutionRun: createAntigravityNativeExecutionRunRuntime,
  });
