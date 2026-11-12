import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntimeContext,
  AgentSessionDisposeReason,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES, ohMyPiPurposeEnvironmentKeys, ohMyPiPurposeOwnedEnvironmentKeys } from './accountPurposes.js';
import { writeOhMyPiNativeAccountOverrides } from '../../providerBinding.js';
import { AGENT_DEFINITION } from '../../definition.js';

type OhMyPiOpenRequest = AgentSessionOpenRequest | AgentExecutionRunOpenRequest;
type OhMyPiAccountPreparationRequest = Pick<OhMyPiOpenRequest, 'launchEnvironment'>
  & Partial<Pick<OhMyPiOpenRequest, 'kind' | 'configuration' | 'providerBinding'>>;

type PreparedOhMyPiConnectedAccounts<Request extends OhMyPiAccountPreparationRequest> = Readonly<{
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

export async function prepareOhMyPiQualifiedAccounts<Request extends OhMyPiAccountPreparationRequest>(
  request: Request,
  context: Readonly<{ signal: AbortSignal; services: Readonly<{
    connectedAccounts: Pick<AgentRuntimeContext['services']['connectedAccounts'], 'getBinding' | 'materialize' | 'watch'>;
  }> }>,
): Promise<PreparedOhMyPiConnectedAccounts<Request>> {
  const subscriptions: Array<Readonly<{ dispose(): void }>> = [];
  const initialObservations: Promise<void>[] = [];
  let invalidated = false;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const subscription of subscriptions) subscription.dispose();
  };
  const invalidate = (): void => {
    invalidated = true;
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

    const selectedModel = request.configuration?.model.value?.trim();
    // A retained native default does not establish this selected account's model.
    if (bound.length > 0 && request.kind === 'create' && !request.providerBinding?.model
      && (!selectedModel || selectedModel === 'default')) {
      throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
        message: 'Choose an explicit model for the selected Oh My Pi Connected Account.',
        details: { failureCause: { code: 'agent_startup_model_reconciliation_failed',
          phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
    }

    const materializedEnvironment = await Promise.all(bound.map(async ({ declaration, binding }) => {
      const materialized = await context.services.connectedAccounts.materialize(
        declaration.purpose,
        { kind: 'environment', keys: ohMyPiPurposeEnvironmentKeys(declaration) },
        { signal: context.signal, expectedAccount: binding.account },
      );
      if (materialized.kind !== 'environment') {
        throw new Error(
          `Oh My Pi Connected Account purpose ${declaration.purpose} returned an invalid environment materialization.`,
        );
      }
      const route = declaration.nativeRoutes.find(route => materialized.env[route.materializationKey]?.trim());
      const value = route ? materialized.env[route.materializationKey] : undefined;
      const hasKey = typeof value === 'string' && value.trim().length > 0;
      const hasFileCredential = !hasKey && declaration.fileCredential
        && Boolean(request.launchEnvironment?.values[declaration.fileCredential.environmentKey])
        && declaration.additionalEnvironmentKeys?.every(key => Boolean(materialized.env[key]));
      if ((!hasKey && !hasFileCredential)
        || (route?.nativeBaseEnvironmentKey && !materialized.env[route.nativeBaseEnvironmentKey]?.trim())) {
        throw new Error(
          `Oh My Pi Connected Account purpose ${declaration.purpose} did not materialize a supported native credential.`,
        );
      }
      return {
        route,
        value: hasKey ? value : undefined,
        declaration,
        additionalEnvironment: Object.fromEntries([
          ...(route?.nativeBaseEnvironmentKey ? [route.nativeBaseEnvironmentKey] : []),
          ...(declaration.additionalEnvironmentKeys ?? []),
        ].flatMap(key => {
          const value = materialized.env[key];
          return typeof value === 'string' && value.length > 0 ? [[key, value]] : [];
        })),
      };
    }));

    let preparedRequest = request;
    if (materializedEnvironment.length > 0) {
      const values = { ...(request.launchEnvironment?.values ?? {}) };
      const unset = new Set([...(request.launchEnvironment?.unset ?? []), 'OMP_PROFILE', 'PI_PROFILE']);
      delete values.OMP_PROFILE;
      delete values.PI_PROFILE;
      for (const entry of materializedEnvironment) {
        for (const key of ohMyPiPurposeOwnedEnvironmentKeys(entry.declaration)) {
          if (entry.declaration.fileCredential && entry.value === undefined
            && key === entry.declaration.fileCredential.environmentKey) {
            unset.delete(key);
            continue;
          }
          delete values[key];
          unset.add(key);
        }
        if (entry.value !== undefined && entry.route) {
          values[entry.route.launchEnvironmentKey] = entry.value;
          unset.delete(entry.route.launchEnvironmentKey);
        }
        Object.assign(values, entry.additionalEnvironment);
        for (const key of Object.keys(entry.additionalEnvironment)) unset.delete(key);
      }
      const nativeHome = values.PI_CODING_AGENT_DIR;
      if (!nativeHome) throw new Error('Oh My Pi selected accounts require the host-prepared native home.');
      const providers: Record<string, { apiKey: string; baseUrl?: string }> = {};
      for (const entry of materializedEnvironment) {
        if (entry.value === undefined || !entry.route) continue;
        providers[entry.route.nativeProvider] ??= { apiKey: entry.route.launchEnvironmentKey,
          ...(entry.route.nativeBaseEnvironmentKey && entry.additionalEnvironment[entry.route.nativeBaseEnvironmentKey]
            ? { baseUrl: entry.additionalEnvironment[entry.route.nativeBaseEnvironmentKey] } : {}) };
      }
      await writeOhMyPiNativeAccountOverrides(nativeHome, providers);
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
        // The host owns account-change recovery at the Session turn boundary.
        let disposed = false;
        const dispose = async (reason?: AgentSessionDisposeReason): Promise<void> => {
          if (disposed) return;
          disposed = true;
          cleanup();
          await session.dispose(reason);
        };
        // Startup already passed admission; account changes govern the next open.
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

