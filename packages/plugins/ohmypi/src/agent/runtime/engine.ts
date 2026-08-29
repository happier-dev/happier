import type {
  AgentAcpRuntimeDefinition,
  AgentRuntimeContext,
  AgentRuntimeFactory,
  AgentSessionDisposeReason,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import {
  CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1,
  CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
} from '@happier-dev/plugin-sdk/first-party/connected-accounts';

import { OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES } from '../auth/services/accountPurposes.js';
import { OH_MY_PI_SYSTEM_TOOL_ID } from '../systemTool.js';
import { AGENT_DEFINITION } from '../definition.js';

export {
  ohMyPiExternalSessionsContribution,
} from '../surfaces/sessions/external/contribution.js';

const OH_MY_PI_ACP_RUNTIME_DEFINITION = Object.freeze({
  acceptsVerifiedImageInput: true,
  modelConfigOptionId: 'model',
  mcp: { policy: 'pass_through' as const },
}) satisfies AgentAcpRuntimeDefinition;

type PreparedOhMyPiConnectedAccounts = Readonly<{
  request: AgentSessionOpenRequest;
  isInvalidated(): boolean;
  bind(session: AgentSessionRuntime): AgentSessionRuntime;
  cleanup(): void;
}>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Oh My Pi qualified Connected Account preparation was aborted.');
}

async function waitForInitialPurposeObservations(
  observations: Iterable<Promise<void>>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([Promise.all(observations), aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function isExpectedService(
  actual: Readonly<{ pluginId: string; localId: string }>,
  expected: Readonly<{ pluginId: string; localId: string }>,
): boolean {
  return actual.pluginId === expected.pluginId && actual.localId === expected.localId;
}

async function prepareOhMyPiQualifiedAccounts(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
): Promise<PreparedOhMyPiConnectedAccounts> {
  const subscriptions: Array<Readonly<{ dispose(): void }>> = [];
  const initialObservations: Promise<void>[] = [];
  let invalidated = false;
  let invalidationHandler: (() => Promise<void>) | null = null;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const subscription of subscriptions) subscription.dispose();
  };
  const invalidate = async (): Promise<void> => {
    invalidated = true;
    await invalidationHandler?.();
  };

  try {
    for (const declaration of OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES) {
      let resolveInitial!: () => void;
      initialObservations.push(new Promise<void>((resolve) => {
        resolveInitial = resolve;
      }));
      let initial = true;
      subscriptions.push(context.services.connectedAccounts.watch(
        declaration.purpose,
        () => {
          if (initial) {
            initial = false;
            resolveInitial();
            return;
          }
          return invalidate();
        },
      ));
    }
    await waitForInitialPurposeObservations(initialObservations, context.signal);

    const bindings = await Promise.all(OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.map(async (declaration) => ({
      declaration,
      binding: await context.services.connectedAccounts.getBinding(
        declaration.purpose,
        { signal: context.signal },
      ),
    })));
    const bound = bindings.flatMap((entry) => entry.binding === null
      ? []
      : [{ declaration: entry.declaration, binding: entry.binding }]);
    for (const entry of bound) {
      if (!isExpectedService(entry.binding.service, entry.declaration.service)) {
        throw new Error(
          `Oh My Pi Connected Account purpose ${entry.declaration.purpose} resolved an unexpected service.`,
        );
      }
    }

    const materializedEnvironment = await Promise.all(bound.map(async ({ declaration, binding }) => {
      let materialized: Awaited<ReturnType<
        AgentRuntimeContext['services']['connectedAccounts']['materialize']
      >>;
      try {
        materialized = await context.services.connectedAccounts.materialize(
          declaration.purpose,
          declaration.purpose === 'claude-subscription'
            ? CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1
            : { kind: 'environment', keys: [declaration.materializationKey] },
          { signal: context.signal, expectedAccount: binding.account },
        );
      } catch (error) {
        if (
          declaration.purpose === 'claude-subscription'
          && isPluginError(error)
          && error.code
            === CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth
              .requestAuthRequiredErrorCode
        ) {
          throw new PluginError({
            code: 'plugin_ohmypi_claude_subscription_oauth_unsupported',
            message: 'Oh My Pi does not support Claude OAuth Connected Accounts because it has no request-auth consumer.',
          });
        }
        throw error;
      }
      if (materialized.kind !== 'environment') {
        throw new Error(
          `Oh My Pi Connected Account purpose ${declaration.purpose} returned an invalid environment materialization.`,
        );
      }
      const value = materialized.env[declaration.materializationKey];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(
          `Oh My Pi Connected Account purpose ${declaration.purpose} did not materialize ${declaration.materializationKey}.`,
        );
      }
      return {
        key: declaration.launchEnvironmentKey,
        value,
      };
    }));

    let preparedRequest = request;
    if (materializedEnvironment.length > 0) {
      const values = { ...(request.launchEnvironment?.values ?? {}) };
      const unset = new Set(request.launchEnvironment?.unset ?? []);
      for (const entry of materializedEnvironment) {
        values[entry.key] = entry.value;
        unset.delete(entry.key);
      }
      preparedRequest = {
        ...request,
        launchEnvironment: {
          values,
          unset: [...unset],
        },
      } satisfies AgentSessionOpenRequest;
    }

    return {
      request: preparedRequest,
      isInvalidated: () => invalidated,
      bind(session) {
        let disposed = false;
        const dispose = async (reason?: AgentSessionDisposeReason): Promise<void> => {
          if (disposed) return;
          disposed = true;
          cleanup();
          await session.dispose(reason);
        };
        invalidationHandler = async () => await dispose('runtime_recovery');
        if (invalidated) void invalidationHandler();
        return {
          ...session,
          runtimeCapabilities: {
            sessionCapabilities: {
              ...AGENT_DEFINITION.core.sessionCapabilities,
            },
          },
          dispose,
        };
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function openOhMyPiSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
): Promise<AgentSessionRuntime> {
  const prepared = await prepareOhMyPiQualifiedAccounts(request, context);
  try {
    if (prepared.isInvalidated()) {
      throw new Error('Oh My Pi qualified Connected Account launch was invalidated before opening the runtime.');
    }
    const session = await context.protocols.acp.open(prepared.request, {
      transport: {
        kind: 'stdio',
        executable: {
          kind: 'systemTool',
          id: OH_MY_PI_SYSTEM_TOOL_ID,
        },
        args: ['--mode', 'acp'],
      },
      definition: OH_MY_PI_ACP_RUNTIME_DEFINITION,
    });
    return prepared.bind(session);
  } catch (error) {
    prepared.cleanup();
    throw error;
  }
}

export const createOhMyPiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: { open: openOhMyPiSession },
});
