import {
  type AgentRuntimeFactory,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { join } from 'node:path';

import { createPiRuntimeOperations } from './rpc/operations.js';
import { preparePiQualifiedConnectedAccounts } from './qualifiedConnectedAccounts.js';
import {
  preparePiHappierToolsExtension,
  type PreparedPiHappierToolsExtension,
} from '../tools/assets.js';
import { readStrictCanonicalPiAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';

export {
  piExternalSessionsContribution,
} from '../externalSessions/contribution.js';

function readPermissionMode(request: AgentSessionOpenRequest): string | undefined {
  return request.configuration?.permissionIntent.value ?? undefined;
}

function readEnvironment(request: AgentSessionOpenRequest): Readonly<{
  values: Readonly<Record<string, string>>;
  unset: readonly string[];
}> {
  return request.launchEnvironment ?? { values: {}, unset: [] };
}

function resolvePiResumeSessionId(request: AgentSessionOpenRequest): string | null {
  if (request.kind !== 'resume') return null;
  const descriptor = readStrictCanonicalPiAgentRuntimeDescriptorV1(
    request.runtimeDescriptorV1,
  );
  if (
    descriptor?.resumeStrategy === 'sessionFileAbsolutePreferred'
    && descriptor.providerSessionId === request.providerSessionId
    && descriptor.sessionFile
  ) {
    return descriptor.sessionFile;
  }
  return request.providerSessionId;
}

async function openPiSession(
  request: AgentSessionOpenRequest,
  context: AgentSessionRuntimeContext,
): Promise<AgentSessionRuntime> {
  if (request.kind === 'fork') {
    throw new Error('Pi does not support native session fork');
  }
  const prepared = await preparePiQualifiedConnectedAccounts({
    launchEnvironment: readEnvironment(request),
    context,
  });
  let preparedTools: PreparedPiHappierToolsExtension | null = null;
  let runtime: AgentSessionRuntime;
  try {
    const { models, happierTools } = context.session.services;
    if (happierTools) {
      const config = await happierTools.resolveNativeBridge({
        systemPrompt: request.startupInstructions?.instructions,
      }, { signal: context.signal });
      const launchEnv = prepared.launchEnvironment.values;
      const agentDir = launchEnv.PI_CODING_AGENT_DIR?.trim()
        || join(resolveHomeDirFromEnvironment(launchEnv), '.pi', 'agent');
      preparedTools = await preparePiHappierToolsExtension({ agentDir, config });
    }
    if (prepared.isInvalidated()) {
      throw new Error('Pi qualified Connected Account launch was invalidated before opening the runtime.');
    }
    runtime = prepared.bind(await createPiRuntimeOperations({
      services: context.services,
      models,
      logger: context.services.logger,
      cwd: request.cwd,
      env: prepared.launchEnvironment.values,
      unsetEnvKeys: prepared.launchEnvironment.unset,
      permissionMode: readPermissionMode(request),
      resumeSessionId: resolvePiResumeSessionId(request),
      sessionId: request.sessionId,
      ...(preparedTools ? { happierToolsExtension: preparedTools } : {}),
    }));
    if (preparedTools) {
      const inner = runtime;
      const tools = preparedTools;
      runtime = {
        ...inner,
        async dispose(reason) {
          try {
            await inner.dispose(reason);
          } finally {
            await tools.dispose();
          }
        },
      };
    }
  } catch (error) {
    try {
      await Promise.all([prepared.dispose(), preparedTools?.dispose()]);
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'Pi session preparation failed');
    }
    throw error;
  }
  if (request.configuration === undefined) {
    return runtime;
  }
  const result = await runtime.updateConfiguration!(request.configuration);
  if (result.status === 'applied') {
    return runtime;
  }
  const failureCode = 'diagnostic' in result
    ? result.diagnostic.code
    : result.status;
  const failure = new Error(
    `Pi rejected its initial session configuration (${failureCode})`,
  );
  try {
    await runtime.dispose();
  } catch (disposeError) {
    throw new AggregateError([failure, disposeError], failure.message);
  }
  throw failure;
}

export const createPiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open: openPiSession,
  },
});
