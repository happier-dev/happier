import {
  PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID,
  PluginSessionHookInstallInputV1Schema,
  PluginSessionHookInstallActionInputV1Schema,
  PluginSessionHookInstallResponseV1Schema,
  PluginSessionHookInstallationMutationInputV1Schema,
  PluginSessionHookInstallationMutationActionInputV1Schema,
  PluginSessionHookStatusActionInputV1Schema,
  PluginSessionHookStatusInputV1Schema,
  PluginSessionHookStatusResponseV1Schema,
  PluginSessionHookToggleResponseV1Schema,
  PluginSessionHookUninstallResponseV1Schema,
  type ActionExecuteResult,
  type FeatureDecision,
  type PluginSessionHookInstallInputV1,
  type PluginSessionHookInstallResponseV1,
  type PluginSessionHookInstallationMutationInputV1,
  type PluginSessionHookStatusInputV1,
  type PluginSessionHookStatusResponseV1,
  type PluginSessionHookToggleResponseV1,
  type PluginSessionHookUninstallResponseV1,
} from '@happier-dev/protocol';

type PluginSessionHookManagementExecutionOptions = Readonly<{
  surface?: 'rpc' | 'action';
  signal?: AbortSignal;
}>;

export type PluginSessionHookManagementActionId =
  | 'plugins.sessionHooks.status.get'
  | 'plugins.sessionHooks.install'
  | 'plugins.sessionHooks.disable'
  | 'plugins.sessionHooks.enable'
  | 'plugins.sessionHooks.uninstall';

export type PluginSessionHookManagementHost = Readonly<{
  status(
    input: PluginSessionHookStatusInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginSessionHookStatusResponseV1>;
  install(
    input: PluginSessionHookInstallInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginSessionHookInstallResponseV1>;
  disable(
    input: PluginSessionHookInstallationMutationInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginSessionHookToggleResponseV1>;
  enable(
    input: PluginSessionHookInstallationMutationInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginSessionHookToggleResponseV1>;
  uninstall(
    input: PluginSessionHookInstallationMutationInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginSessionHookUninstallResponseV1>;
}>;

export type PluginSessionHookManagementActionExecutor = Readonly<{
  execute(
    actionId: PluginSessionHookManagementActionId,
    input: unknown,
    options?: PluginSessionHookManagementExecutionOptions,
  ): Promise<ActionExecuteResult>;
}>;

type ManagementFailure = Readonly<{
  ok: false;
  diagnostic: Readonly<{
    code:
      | 'feature_disabled'
      | 'installation_unsupported'
      | 'permission_denied'
      | 'concurrent_edit'
      | 'installation_replaced'
      | 'operation_failed'
      | 'version_unsupported';
    retryable: boolean;
  }>;
}>;

function failure(
  code: ManagementFailure['diagnostic']['code'],
  retryable: boolean,
): ManagementFailure {
  return {
    ok: false,
    diagnostic: { code, retryable },
  };
}

function result(value: unknown): ActionExecuteResult {
  return { ok: true, result: value };
}

function invalidRequest(): ActionExecuteResult {
  return {
    ok: false,
    errorCode: 'invalid_request',
    error: 'invalid_request',
  };
}

function canceled(): ActionExecuteResult {
  return {
    ok: false,
    errorCode: 'action_canceled',
    error: 'action_canceled',
  };
}

function isEnabledFeatureDecisionForMachine(
  decision: FeatureDecision,
  machineId: string,
): boolean {
  return decision.featureId === PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID
    && decision.state === 'enabled'
    && (
      decision.scope.machineId === undefined
      || decision.scope.machineId === machineId
    );
}

export function createPluginSessionHookManagementActionExecutor(input: Readonly<{
  machineId: string;
  readFeatureDecision(): FeatureDecision;
  host: PluginSessionHookManagementHost;
}>): PluginSessionHookManagementActionExecutor {
  const readStatus = async (
    target: PluginSessionHookStatusInputV1,
    signal?: AbortSignal,
  ): Promise<PluginSessionHookStatusResponseV1> => {
    if (signal?.aborted) throw signal.reason ?? new Error('action_canceled');
    return PluginSessionHookStatusResponseV1Schema.parse(
      await (signal
        ? input.host.status(target, { signal })
        : input.host.status(target)),
    );
  };

  return {
    async execute(actionId, rawInput, options = {}) {
      if (options.signal?.aborted) return canceled();
      let featureEnabled = false;
      try {
        featureEnabled = isEnabledFeatureDecisionForMachine(
          input.readFeatureDecision(),
          input.machineId,
        );
      } catch {
        // A decision-reader failure must not make a gated management action available.
      }
      if (!featureEnabled) {
        return result(failure('feature_disabled', false));
      }

      if (actionId === 'plugins.sessionHooks.status.get') {
        const parsedInput = options.surface === 'action'
          ? PluginSessionHookStatusActionInputV1Schema.safeParse(rawInput)
          : PluginSessionHookStatusInputV1Schema.safeParse(rawInput);
        if (!parsedInput.success) {
          return invalidRequest();
        }
        if ('machineId' in parsedInput.data && parsedInput.data.machineId !== input.machineId) {
          return result(failure('permission_denied', false));
        }
        try {
          const current = await readStatus({
            ...parsedInput.data,
            machineId: input.machineId,
          }, options.signal);
          if (options.signal?.aborted) return canceled();
          return result(current);
        } catch {
          if (options.signal?.aborted) return canceled();
          return result(failure('operation_failed', true));
        }
      }

      if (actionId === 'plugins.sessionHooks.install') {
        const parsedInput = options.surface === 'action'
          ? PluginSessionHookInstallActionInputV1Schema.safeParse(rawInput)
          : PluginSessionHookInstallInputV1Schema.safeParse(rawInput);
        if (!parsedInput.success) {
          return invalidRequest();
        }
        if ('machineId' in parsedInput.data && parsedInput.data.machineId !== input.machineId) {
          return result(failure('permission_denied', false));
        }
        try {
          const target = { ...parsedInput.data, machineId: input.machineId };
          return result(PluginSessionHookInstallResponseV1Schema.parse(
            await (options.signal
              ? input.host.install(target, { signal: options.signal })
              : input.host.install(target)),
          ));
        } catch {
          if (options.signal?.aborted) return canceled();
          return result(failure('operation_failed', true));
        }
      }

      const parsedInput = options.surface === 'action'
        ? PluginSessionHookInstallationMutationActionInputV1Schema.safeParse(rawInput)
        : PluginSessionHookInstallationMutationInputV1Schema.safeParse(rawInput);
      if (!parsedInput.success) {
        return invalidRequest();
      }
      if ('machineId' in parsedInput.data && parsedInput.data.machineId !== input.machineId) {
        return result(failure('permission_denied', false));
      }

      try {
        const mutationInput = { ...parsedInput.data, machineId: input.machineId };
        if (actionId === 'plugins.sessionHooks.enable') {
          return result(PluginSessionHookToggleResponseV1Schema.parse(
            await (options.signal
              ? input.host.enable(mutationInput, { signal: options.signal })
              : input.host.enable(mutationInput)),
          ));
        }
        /**
         * Disable, enable and uninstall all settle at the host, which holds the
         * per-installation mutation lock and resolves the durable custody record
         * under it. Re-reading the passive inventory here would be a second,
         * unlocked decision-maker for the same fact: it could only disagree with
         * the authority that is about to run, and its page-level diagnostics —
         * which describe OTHER unreadable records — vetoed mutations the host
         * could safely complete, precisely when something was already wrong.
         * Inventory diagnostics inform what the row LOOKS like, not what the user
         * is allowed to do about it.
         */
        if (actionId === 'plugins.sessionHooks.disable') {
          return result(PluginSessionHookToggleResponseV1Schema.parse(
            await (options.signal
              ? input.host.disable(mutationInput, { signal: options.signal })
              : input.host.disable(mutationInput)),
          ));
        }

        return result(PluginSessionHookUninstallResponseV1Schema.parse(
          await (options.signal
            ? input.host.uninstall(mutationInput, { signal: options.signal })
            : input.host.uninstall(mutationInput)),
        ));
      } catch {
        if (options.signal?.aborted) return canceled();
        return result(failure('operation_failed', true));
      }
    },
  };
}
