import {
  createExecutionRunHostBackendFromSessionRuntime,
  type AgentExecutionRunRuntime,
  type AgentRuntime,
  type AgentRuntimeContext,
  type AgentRuntimeFactory,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeContext,
  type AgentSessionUsageLimitRecoveryControl,
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

const PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS = 600_000;

const piUsageLimitRecovery: AgentSessionUsageLimitRecoveryControl = {
  async execute(request) {
    if (request.kind !== 'checkNow') {
      return {
        status: 'unsupported',
        diagnostic: {
          code: 'pi_reset_credit_unsupported',
          severity: 'error',
        },
      };
    }
    return {
      status: 'waiting',
      retryAfterMs: PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS,
    };
  },
};

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
  context: Pick<AgentRuntimeContext, 'services' | 'signal' | 'session'>,
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
    const session = context.session as AgentSessionRuntimeContext['session'] | undefined;
    const models = session && 'services' in session ? session.services.models : null;
    const happierTools = session && 'services' in session ? session.services.happierTools : null;
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
      ...(models ? { models } : {}),
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

async function openPiExecutionRun(
  request: Parameters<NonNullable<AgentRuntime['executionRuns']>['open']>[0],
  context: AgentRuntimeContext,
): Promise<AgentExecutionRunRuntime> {
  if (request.kind !== 'create') {
    throw new Error(`Pi execution runs do not support ${request.kind}`);
  }
  return await createExecutionRunHostBackendFromSessionRuntime({
    request,
    openSession: async () => await openPiSession({
      kind: 'create',
      sessionId: request.runId,
      cwd: request.cwd,
      ...(request.launchEnvironment ? { launchEnvironment: request.launchEnvironment } : {}),
    }, context),
  });
}

export const createPiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open: openPiSession,
    usageLimitRecovery: piUsageLimitRecovery,
  },
  executionRuns: { open: openPiExecutionRun },
});
