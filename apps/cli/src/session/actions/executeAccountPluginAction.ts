import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionId } from '@happier-dev/protocol';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { CurrentProcessPluginActionExecutionAttempt } from './createDaemonPluginActionExecutor';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker,
  createCommittedContributedActionSchemaReader, createRegistryInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCredentialedTargetActionCurrentIntent } from './approvals/credentialedTargetActionCurrentIntent';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';
import type { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import axios from 'axios';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';

/** Selects Account custody for the incumbent runtime and invocation owners. */
export async function executeAccountPluginAction(params: Readonly<{
  host: Parameters<typeof createCliActionExecutorHarness>[0];
  deps: ActionExecutorDeps;
  actionId: string;
  input: unknown;
  context?: ActionExecutorContext;
}>): Promise<CurrentProcessPluginActionExecutionAttempt> {
  const credentials = params.host.credentials;
  if (!credentials || !params.host.serverHttpBaseUrl) return { matched: false };
  const input = typeof params.input === 'object' && params.input !== null ? params.input : null;
  const ref = input && 'action' in input && typeof input.action === 'object' && input.action !== null
    ? input.action : null;
  const metadataId = input && (params.actionId === 'action.spec.get' && 'id' in input ? input.id
    : params.actionId === 'action.options.resolve' && 'actionId' in input ? input.actionId : null);
  const identity = parseQualifiedPluginActionId(typeof metadataId === 'string' ? metadataId : params.actionId);
  const pluginId = ref && 'pluginId' in ref && typeof ref.pluginId === 'string' ? ref.pluginId
    : identity?.pluginId;
  const localId = ref && 'localId' in ref && typeof ref.localId === 'string' ? ref.localId
    : identity?.localId;
  // Discovery and invocation use the incumbent catalog; Account custody never
  // permits evaluating a Machine handler from these bytes.
  const search = params.actionId === 'action.spec.search';
  if (!pluginId && !search) return { matched: false };
  if (params.host.isCredentialCurrent && !await params.host.isCredentialCurrent()) return { matched: true,
    result: { ok: false, errorCode: 'plugin_action_generation_retired', error: 'plugin_action_generation_retired' } };
  const unavailableSource = (error: unknown): null => {
    params.context?.signal?.throwIfAborted();
    // Source transport failure grants nothing. The existing dispatcher must
    // independently prove current Machine placement before it can proceed.
    if (axios.isAxiosError(error) && (!error.response || error.response.status === 404 || error.response.status === 501)) return null;
    throw error;
  };
  return await runWithServerHttpBaseUrl(params.host.serverHttpBaseUrl, async () => {
    // A first policy read establishes Account identity before the invocation
    // captures it. Nested host Actions then share that same current lifetime.
    await ensureCliActionPolicySettings(credentials, params.host.serverHttpBaseUrl);
    params.context?.signal?.throwIfAborted();
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const isCurrent = () => lifetime === getActiveAccountSettingsSnapshotLifetimeToken()
      && !params.context?.signal?.aborted;
    if (!search && pluginId) {
      // Most daemon callbacks address Machine Actions. Read their current
      // Account override before constructing an executable Account runtime;
      // unrelated bundled declarations cannot affect this placement decision.
      const selection = await readCurrentAccountPluginExecutionSelection({ pluginId, credentials,
        serverUrl: params.host.serverHttpBaseUrl!, ...(params.context?.signal ? { signal: params.context.signal } : {}) })
        .catch(unavailableSource);
      if (!isCurrent()) return { matched: true, result: { ok: false,
        errorCode: 'plugin_action_generation_retired', error: 'plugin_action_generation_retired' } };
      if (!selection) return { matched: false, accountSelectionUnavailable: true };
      if (selection.kind === 'unavailable' && selection.code !== 'plugin_account_execution_unavailable') return {
        matched: true, result: { ok: false, errorCode: selection.code, error: selection.code } };
      const execution = selection.kind === 'available'
        ? selection.manifest.contributes.actions.find(action => action.id === localId)?.execution
        : getResolvedContributionRegistry().actions.find(action => action.identity?.pluginId === pluginId
          && action.identity?.localId === localId)?.definition.execution;
      if (typeof execution !== 'object' || execution === null || !('target' in execution)
        || execution.target !== 'account') return { matched: false, accountSelectionUnavailable: true };
    }
    const registry = await resolveExecutablePluginRuntimeRegistry({
      ...(params.host.happyHomeDir ? { happyHomeDir: params.host.happyHomeDir } : {}),
      ...(params.context?.signal ? { signal: params.context.signal } : {}),
      accountExecution: { credentials, serverUrl: params.host.serverHttpBaseUrl!, isCurrent,
        ...(params.host.isCredentialCurrent ? { isCredentialCurrent: params.host.isCredentialCurrent } : {}),
        ...(params.host.serverId ? { serverId: params.host.serverId } : {}),
        ...(params.context?.serverIdentityId ? { serverIdentityId: params.context.serverIdentityId } : {}),
        ...(params.context?.executionRunTargetMachineId ? { machineId: params.context.executionRunTargetMachineId } : {}) },
    }).catch(unavailableSource);
    // A non-search call reaches runtime construction only after its exact
    // current declaration selected Account execution. Losing that source does
    // not turn the invocation into an independently admitted Machine Action.
    const accountHandlerUnavailable = { matched: true as const, result: { ok: false as const,
      errorCode: 'plugin_action_handler_missing', error: 'plugin_action_handler_missing' } };
    if (!registry) return search ? { matched: false } : accountHandlerUnavailable;
    try {
      const selection = pluginId ? registry.readAccountExecutionSelection?.(pluginId) : null;
      if (selection?.kind === 'unavailable' && selection.code !== 'plugin_account_execution_unavailable') return { matched: true,
        result: { ok: false, errorCode: selection.code, error: selection.code } };
      if (!search && !registry.contributes.actions.some(action => action.identity?.pluginId === pluginId
        && action.identity?.localId === localId && typeof action.definition.execution === 'object'
        && action.definition.execution !== null && 'target' in action.definition.execution
        && action.definition.execution.target === 'account')) return accountHandlerUnavailable;
      // Borrow the same finite runtime for nested schema/invocation reads; the
      // owning invocation disposes it once, after approval and settlement.
      const lease = { registry, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
      const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
      const executor = createActionExecutor({ ...params.deps,
        ...createRegistryInputTypeDeps(registry),
        listContributedActionDefinitions: list,
        readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
        invokeContributedAction: createCommittedContributedActionInvoker({
          acquireRuntimeRegistryLease: async () => lease,
          requestCurrentIntent: createCredentialedTargetActionCurrentIntent(credentials),
        }),
      });
      return { matched: true, result: await executor.execute(params.actionId as ActionId, params.input, params.context) };
    } finally { await registry.dispose(); }
  });
}
