import type {
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntimeContext,
  AgentSessionDisposeReason,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES } from './accountPurposes.js';
import { AGENT_DEFINITION } from '../../definition.js';

type OhMyPiOpenRequest = AgentSessionOpenRequest | AgentExecutionRunOpenRequest;

type PreparedOhMyPiConnectedAccounts<Request extends Pick<OhMyPiOpenRequest, 'launchEnvironment'>> = Readonly<{
  request: Request;
  isInvalidated(): boolean;
  bind(session: AgentSessionRuntime): AgentSessionRuntime;
  bindExecutionRun(run: AgentExecutionRunRuntime): AgentExecutionRunRuntime;
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

export async function prepareOhMyPiQualifiedAccounts<Request extends Pick<OhMyPiOpenRequest, 'launchEnvironment'>>(
  request: Request,
  context: Readonly<{ signal: AbortSignal; services: Readonly<{
    connectedAccounts: Pick<AgentRuntimeContext['services']['connectedAccounts'], 'getBinding' | 'materialize' | 'watch'>;
  }> }>,
): Promise<PreparedOhMyPiConnectedAccounts<Request>> {
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
        (event) => {
          if (initial) {
            initial = false;
            resolveInitial();
            return;
          }
          if (!event.authorityChanged) return;
          return invalidate();
        },
      ));
    }
    await waitForInitialPurposeObservations(initialObservations, context.signal);

    const bindings = await Promise.all(OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.map(async (declaration) => ({
      declaration,
      binding: await context.services.connectedAccounts.getBinding(
        declaration.purpose,
        { signal: context.signal, observation: true },
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
      const materialized = await context.services.connectedAccounts.materialize(
        declaration.purpose,
        { kind: 'environment', keys: [declaration.materializationKey] },
        { signal: context.signal, expectedAccount: binding.account },
      );
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
      preparedRequest = Object.assign({}, request, {
        launchEnvironment: {
          values,
          unset: [...unset],
        },
      });
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
      bindExecutionRun(run) {
        // A finite run owns its admitted credential snapshot until explicit disposal.
        cleanup();
        let disposed = false;
        const dispose = async (): Promise<void> => {
          if (disposed) return;
          disposed = true;
          cleanup();
          await run.dispose();
        };
        return { ...run, dispose };
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

