import { readPrivateBearerFile } from '@/daemon/privateBearerFile';
import { readHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { AgentRuntimeRunnerBootstrapV1Schema } from './agentRuntimeRunnerProtocol';

/**
 * One protected, strict reader for runner launch intent and runtime construction. A Session in the
 * session host already holds what its daemon admitted for this exact file, so nothing is re-read.
 */
export async function readRunnerAgentSessionBootstrap(
  path: string,
): Promise<ReturnType<typeof AgentRuntimeRunnerBootstrapV1Schema.parse>> {
  const admitted = readHostedSessionScope()?.runnerBootstrap;
  if (admitted && admitted.path === path) return admitted.bootstrap;
  return AgentRuntimeRunnerBootstrapV1Schema.parse(
    JSON.parse(await readPrivateBearerFile(path)),
  );
}
