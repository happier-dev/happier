import { stripInheritedConnectedServiceEnvironment } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import type { BackendIsolationBundle, BackendIsolationRequest } from './types';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

function readDefinedProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sessionProcessEnvironment())) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

export function resolveBackendIsolationBundle(_request: BackendIsolationRequest): BackendIsolationBundle {
  return {
    env: stripInheritedConnectedServiceEnvironment(readDefinedProcessEnv()),
  };
}
