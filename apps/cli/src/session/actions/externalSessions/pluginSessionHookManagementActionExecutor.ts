import {
  PLUGIN_SESSION_HOOK_MANAGEMENT_FEATURE_ID,
  PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT,
  PluginSessionHookInstallInputV1Schema,
  PluginSessionHookInstallResponseV1Schema,
  PluginSessionHookInstallationMutationInputV1Schema,
  PluginSessionHookStatusInputV1Schema,
  PluginSessionHookStatusResponseV1Schema,
  PluginSessionHookToggleResponseV1Schema,
  PluginSessionHookUninstallResponseV1Schema,
  type ActionExecuteResult,
  type FeatureDecision,
  type PluginSessionHookInstallInputV1,
  type PluginSessionHookInstallResponseV1,
  type PluginSessionHookInstallationMutationInputV1,
  type PluginSessionHookInstallationStatusV1,
  type PluginSessionHookStatusInputV1,
  type PluginSessionHookStatusInventoryRowV1,
  type PluginSessionHookStatusResponseV1,
  type PluginSessionHookToggleResponseV1,
  type PluginSessionHookUninstallResponseV1,
} from '@happier-dev/protocol';

export type PluginSessionHookManagementActionId =
  | 'plugins.sessionHooks.status.get'
  | 'plugins.sessionHooks.install'
  | 'plugins.sessionHooks.disable'
  | 'plugins.sessionHooks.enable'
  | 'plugins.sessionHooks.uninstall';

export type PluginSessionHookManagementHost = Readonly<{
  status(
    input: PluginSessionHookStatusInputV1,
  ): Promise<PluginSessionHookStatusResponseV1>;
  install(
    input: PluginSessionHookInstallInputV1,
  ): Promise<PluginSessionHookInstallResponseV1>;
  disable(
    input: PluginSessionHookInstallationMutationInputV1,
  ): Promise<PluginSessionHookToggleResponseV1>;
  enable(
    input: PluginSessionHookInstallationMutationInputV1,
  ): Promise<PluginSessionHookToggleResponseV1>;
  uninstall(
    input: PluginSessionHookInstallationMutationInputV1,
  ): Promise<PluginSessionHookUninstallResponseV1>;
}>;

export type PluginSessionHookManagementActionExecutor = Readonly<{
  execute(
    actionId: PluginSessionHookManagementActionId,
    input: unknown,
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

const MAX_EXACT_AGENT_STATUS_PAGES = 50;

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

function hasInstallationId(
  status: PluginSessionHookInstallationStatusV1,
): status is PluginSessionHookInstallationStatusV1 & Readonly<{ installationId: string }> {
  return 'installationId' in status && typeof status.installationId === 'string';
}

function isSameAgent(
  left: PluginSessionHookInstallInputV1['agent'],
  right: PluginSessionHookInstallInputV1['agent'],
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function validateExactAgentInventoryPage(
  response: Extract<PluginSessionHookStatusResponseV1, { ok: true }>,
  agent: PluginSessionHookInstallInputV1['agent'],
): ManagementFailure | null {
  if (response.diagnostics.length > 0) {
    return failure(
      'operation_failed',
      response.diagnostics.some((diagnostic) => diagnostic.retryable),
    );
  }
  if (response.rows.some((row) => !isSameAgent(row.agent, agent))) {
    return failure('operation_failed', false);
  }
  return null;
}

export function createPluginSessionHookManagementActionExecutor(input: Readonly<{
  machineId: string;
  readFeatureDecision(): FeatureDecision;
  host: PluginSessionHookManagementHost;
}>): PluginSessionHookManagementActionExecutor {
  const readStatus = async (
    target: PluginSessionHookStatusInputV1,
  ): Promise<PluginSessionHookStatusResponseV1> => {
    return PluginSessionHookStatusResponseV1Schema.parse(
      await input.host.status(target),
    );
  };

  const readCompleteExactAgentInventory = async (
    target: Pick<
      PluginSessionHookInstallInputV1,
      'machineId' | 'agent'
    >,
  ): Promise<
    | Readonly<{ ok: true; rows: readonly PluginSessionHookStatusInventoryRowV1[] }>
    | Readonly<{ ok: false; response: PluginSessionHookStatusResponseV1 }>
  > => {
    const rows: PluginSessionHookStatusInventoryRowV1[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_EXACT_AGENT_STATUS_PAGES; page += 1) {
      const response = await readStatus({
        machineId: target.machineId,
        intent: 'passive_inventory',
        agent: target.agent,
        limit: PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!response.ok) {
        return { ok: false, response };
      }

      const pageFailure = validateExactAgentInventoryPage(response, target.agent);
      if (pageFailure) {
        return { ok: false, response: pageFailure };
      }
      rows.push(...response.rows);

      if (response.nextCursor === null) {
        return { ok: true, rows };
      }
      if (seenCursors.has(response.nextCursor)) {
        return {
          ok: false,
          response: failure('operation_failed', false),
        };
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }

    return {
      ok: false,
      response: failure('operation_failed', false),
    };
  };

  return {
    async execute(actionId, rawInput) {
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
        const parsedInput = PluginSessionHookStatusInputV1Schema.safeParse(rawInput);
        if (!parsedInput.success) {
          return invalidRequest();
        }
        if (parsedInput.data.machineId !== input.machineId) {
          return result(failure('permission_denied', false));
        }
        try {
          const current = await readStatus(parsedInput.data);
          return result(current);
        } catch {
          return result(failure('operation_failed', true));
        }
      }

      if (actionId === 'plugins.sessionHooks.install') {
        const parsedInput = PluginSessionHookInstallInputV1Schema.safeParse(rawInput);
        if (!parsedInput.success) {
          return invalidRequest();
        }
        if (parsedInput.data.machineId !== input.machineId) {
          return result(failure('permission_denied', false));
        }
        try {
          return result(PluginSessionHookInstallResponseV1Schema.parse(
            await input.host.install(parsedInput.data),
          ));
        } catch {
          return result(failure('operation_failed', true));
        }
      }

      const parsedInput = PluginSessionHookInstallationMutationInputV1Schema.safeParse(rawInput);
      if (!parsedInput.success) {
        return invalidRequest();
      }
      if (parsedInput.data.machineId !== input.machineId) {
        return result(failure('permission_denied', false));
      }

      try {
        const mutationInput = parsedInput.data;
        if (actionId === 'plugins.sessionHooks.enable') {
          return result(PluginSessionHookToggleResponseV1Schema.parse(
            await input.host.enable(mutationInput),
          ));
        }
        const current = await readCompleteExactAgentInventory({
          machineId: mutationInput.machineId,
          agent: mutationInput.agent,
        });
        if (!current.ok) {
          return result(current.response);
        }

        const matches = current.rows.filter(
          (row) => hasInstallationId(row.status)
            && row.status.installationId === mutationInput.installationId,
        );
        if (matches.length !== 1) {
          if (
            matches.length === 0
            && current.rows.some((row) => hasInstallationId(row.status))
          ) {
            return result(failure('installation_replaced', false));
          }
          return result(failure('operation_failed', false));
        }
        const currentStatus = matches[0]!.status;

        if (actionId === 'plugins.sessionHooks.disable') {
          if (currentStatus.state !== 'installed_enabled') {
            return result(failure('operation_failed', false));
          }
          return result(PluginSessionHookToggleResponseV1Schema.parse(
            await input.host.disable(mutationInput),
          ));
        }

        return result(PluginSessionHookUninstallResponseV1Schema.parse(
          await input.host.uninstall(mutationInput),
        ));
      } catch {
        return result(failure('operation_failed', true));
      }
    },
  };
}
