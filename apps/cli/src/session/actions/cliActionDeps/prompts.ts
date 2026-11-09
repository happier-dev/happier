import type { CliMachineActionCall } from './machineTransport';
import type { ResolvedSessionTransport } from './types';
import type { CliActionDepsParams, CurrentMachineControlIdentity } from './types';
import { artifactSavedByFromActionContextV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import type { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { createCliSessionCapabilitiesActionDeps } from './createCliSessionCapabilitiesActionDeps';
import { setSessionCapabilityV1 } from '@happier-dev/protocol/actions/executor/sessionCapabilities';
import { randomUUID } from 'node:crypto';
import type { createFoundSkillBundleReader } from '@/cli/actions/foundSkillBundleReader';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { installPromptRegistryItemInLibrary, updatePromptBundleInLibrary, updatePromptDocInLibrary, readPromptDocInLibrary, createPromptDocInLibrary, setPromptDocFavorite, listPromptLibrary, readSkillInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { createSkillActionExecuteV1, readSkillUsageCatalogV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { readSkillRulesForItemV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { resolvePromptDocCreateActionInputV1 } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { listPromptInvocationsInLibrary, resolvePromptInvocationInLibrary } from '@happier-dev/protocol/prompts/library/promptInvocationActionOperations';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import type { recordDaemonSkillUse } from '@/daemon/controlClient';
import type { resolveHappierSkillIdentity } from '@/prompts/skills/runtime/resolveHappierSkillIdentity';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl, normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import type { createCliRegistryUpdateCheck } from '@/registries/updates/createCliRegistryUpdateCheck';
import type { PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
export function createCliPromptsActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'getCurrentSessionSkillItems' | 'machineActionDirectTargetTransport' | 'savedSecretOperationContext' | 'serverHttpBaseUrl' | 'serverId' | 'sessionId'>,
  { approvalsStore, callMachineAction, callSessionActionRpc, notSupported, projectHomeId, promptLibraryStoreForContext, skillRulesForContext, readCurrentMachineControlIdentity, requireLocalPromptActionMachine, resolveServerRequestHeaders, resolveTransportForSession, readRegistryAppEnvironment }: Readonly<{
    approvalsStore: ReturnType<typeof createCliApprovalsArtifactStore> | null;
    callMachineAction: CliMachineActionCall;
    callSessionActionRpc: (transport: ResolvedSessionTransport, method: string, input: unknown, context: ActionExecutorContext) => Promise<unknown>;
    notSupported: () => never;
    projectHomeId: string;
    promptLibraryStoreForContext: (context: ActionExecutorContext | undefined, effectActionId: string) => PromptLibraryArtifactStore | null;
    skillRulesForContext: (context: ActionExecutorContext, effectActionId: string) => ReturnType<typeof createCliApprovalsArtifactStore>['skillRules'] | null;
    readRegistryAppEnvironment: (environmentId: string, context: ActionExecutorContext) =>
      Promise<import('@happier-dev/protocol/registries').RegistryAppUpdateEnvironmentV1>;
    readCurrentMachineControlIdentity: () => Promise<CurrentMachineControlIdentity>;
    requireLocalPromptActionMachine: (machineId: string) => Promise<Readonly<{
    ok: true;
  }> | Readonly<{
    ok: false;
    errorCode: 'machine_not_found';
    error: 'machine_not_found';
  }>>;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
  }>,
): Pick<ActionExecutorDeps, 'registryActionExecute' | 'promptDocGet' | 'promptDocCreate' | 'promptDocFavoriteSet' | 'promptsLibraryList' | 'promptInvocationsList' | 'promptInvocationResolve' | 'promptDocUpdate' | 'skillsRead' | 'skillActionExecute' | 'skillMachineActionExecute' | 'promptBundleUpdate' | 'promptRegistryInstall'> {
  const promptStoreForContext = (context: ActionExecutorContext | undefined, effectActionId: string) =>
    promptLibraryStoreForContext(context, effectActionId) ?? notSupported();
  const executeSkillAction = async ({ actionId, input, context }: Parameters<NonNullable<ActionExecutorDeps['skillActionExecute']>>[0]) => {
      if (!approvalsStore || !params.credentials) return notSupported();
      const readFoundSkillBundle: NonNullable<Parameters<typeof createSkillActionExecuteV1>[0]['readFoundSkillBundle']> = async (machineId, path, signal) => {
        const [{ isServerProfileHomeIdentity }, { createFoundSkillBundleReader }] = await Promise.all([import("@/server/serverProfiles"), import("@/cli/actions/foundSkillBundleReader")]);
        const localHome = await isServerProfileHomeIdentity(params.serverId ?? configuration.activeServerId, configuration.activeServerId);
        const localMachine = localHome ? await readCurrentMachineControlIdentity() : null;
        return createFoundSkillBundleReader({ machineId: localMachine?.machineId ?? null,
          machineRPC: (targetMachineId, method, request, transferSignal) => callMachineAction({ machineId: targetMachineId, method, request,
            context, authority: context.authority, effectActionId: actionId, exactMachine: true,
            ...(context.serverId ? { serverId: context.serverId } : {}),
            ...(context.rpcSessionAuthorization ? { authorization: context.rpcSessionAuthorization } : {}),
            ...(transferSignal ? { signal: transferSignal } : {}),
          }),
        })(machineId, path, signal);
      };
      const { createCliRegistryHostV1 } = await import("@/registries/createCliRegistryHost");
      const registry = createCliRegistryHostV1({ credentials: params.credentials, port: approvalsStore.promptLibraryStore.organization, signal: context.signal,
        operationContext: params.savedSecretOperationContext });
      const execute = createSkillActionExecuteV1({ store: promptStoreForContext(context, actionId), skillRules: approvalsStore.skillRules, randomId: randomUUID, readFoundSkillBundle, readPluginSkills: approvalsStore.readPluginSkills,
        savedBy: artifactSavedByFromActionContextV1(context),
        readRegistryItem: registry.readRegistryItem, readRegistrySource: registry.readRegistrySource,
        fetchRegistrySkillFiles: registry.filesForPointer, readLinkSkills: registry.readLinkSkills, fetchLinkSkillFiles: registry.fetchLinkSkillFiles,
        includeInSession: async (sessionId, skillId, signal) => {
          const port = createCliSessionCapabilitiesActionDeps({ credentials: params.credentials!,
            serverId: params.serverId ?? configuration.activeServerId, serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
            operationContext: params.savedSecretOperationContext,
            skillRulesForContext: caller => skillRulesForContext(caller, actionId) ?? notSupported(), callMachineAction,
            resolveAuthorizationHeaders: (_selectionActionId, caller, request) => resolveServerRequestHeaders(caller, actionId, request),
          }).sessionCapabilities!;
          return setSessionCapabilityV1({ port, request: { sessionId, kind: 'skill', id: skillId, state: 'on' },
            context: { ...context, ...(signal ? { signal } : {}) } });
        },
      });
      const caller = { surface: context.surface ?? null, ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}),
        invocationServices: context.invocationServices,
        ...(context.approvedActionReplay ? { approvedActionReplay: context.approvedActionReplay } : {}) };
      const operation = () => execute(actionId, input, caller, context.signal);
      return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, operation) : operation();
  };
  const readPromptInvocations = async (signal?: AbortSignal): Promise<Readonly<{ invocations: unknown; revision: number | 'absent'; assertCurrent: () => void }> | null> => {
    signal?.throwIfAborted();
    const credentials = params.credentials;
    if (!credentials) return null;
    const read = async () => {
      const { createCliPromptLibraryStore } = await import("@/settings/prompts/promptLibraryStore");
      const store = createCliPromptLibraryStore({ credentials, signal });
      const catalog = await store.readPromptLibraryCatalog();
      const absent = (catalog.status === 'ready' || catalog.status === 'partial')
        && !catalog.rows.some(row => row.record.key === 'invocations')
        && !catalog.tombstones.some(row => row.key === 'invocations')
        && !catalog.diagnostics.some(row => row.key === 'invocations');
      const source = absent ? await store.readSourceSnapshot() : null;
      const current = readPromptLibraryCatalogRecordV1({ catalog, key: 'invocations', ...(source ? { rawSettings: source.raw } : {}) });
      store.assertCurrent();
      return current.status === 'ready' && current.record.key === 'invocations'
        ? { invocations: current.record.value, revision: current.revision, assertCurrent: store.assertCurrent } : null;
    };
    try { return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read()); }
    catch { signal?.throwIfAborted(); return null; }
  };
  return {
    registryActionExecute: async ({actionId,input,context}) => {
      if(!params.credentials) throw new Error('account_credentials_unavailable');
      const [{ createCliRegistryHostV1 }, { createCliRegistryUpdateCheck }] = await Promise.all([import("@/registries/createCliRegistryHost"), import("@/registries/updates/createCliRegistryUpdateCheck")]);
      return createCliRegistryHostV1({credentials:params.credentials,
        port:approvalsStore?.promptLibraryStore.organization,signal:context.signal,operationContext:params.savedSecretOperationContext,
        updates: filter => createCliRegistryUpdateCheck({ credentials: params.credentials!, serverId: params.serverId,
          serverHttpBaseUrl: params.serverHttpBaseUrl, signal: context.signal, operationContext: params.savedSecretOperationContext,
          readEnvironment: environmentId => readRegistryAppEnvironment(environmentId, context) }).checkNow(filter),
      }).execute(actionId,input);
    },
    promptDocGet: async ({ artifactId, signal }, context) => {
      if (!approvalsStore) return notSupported();
      return await readPromptDocInLibrary({ store: promptStoreForContext(context, 'prompt_doc.get'), artifactId, ...(signal ? { signal } : {}) });
    },
    promptDocCreate: async ({ signal, ...request }, context) => {
      if (!approvalsStore) return notSupported();
      return createPromptDocInLibrary({ store: promptStoreForContext(context, 'prompt_doc.create'), request: resolvePromptDocCreateActionInputV1(request), signal });
    },
    promptDocFavoriteSet: async ({ signal, ...request }, context) => {
      if (!approvalsStore) return notSupported();
      return setPromptDocFavorite({ store: promptStoreForContext(context, 'prompt_doc.favorite.set'), request, signal });
    },
    promptsLibraryList: async ({ signal, ...request }, context) => {
      if (!approvalsStore) return notSupported();
      return listPromptLibrary({ store: promptStoreForContext(context, 'prompts.library.list'), request, signal });
    },
    promptInvocationsList: async (request) => {
      request.signal?.throwIfAborted();
      const source = await readPromptInvocations(request.signal);
      const unavailable = { items: [], coverage: 'unavailable' as const };
      if (!source) return unavailable;
      try {
        source.assertCurrent();
        const result = listPromptInvocationsInLibrary({ invocations: source.invocations, revision: source.revision, request });
        source.assertCurrent();
        return result;
      } catch { request.signal?.throwIfAborted(); return unavailable; }
    },
    promptInvocationResolve: async ({ sessionId, signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      const source = await readPromptInvocations(signal);
      const unavailable = { status: 'unavailable' as const, invocationId: request.invocationId.trim() };
      if (!source) return unavailable;
      try {
        source.assertCurrent();
        const { withCliPromptLibraryArtifactReader } = await import("@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks");
        const result = await withCliPromptLibraryArtifactReader((reader) => resolvePromptInvocationInLibrary({ invocations: source.invocations,
          store: approvalsStore.promptLibraryStore, readArtifact: async (ref) => {
            source.assertCurrent();
            const artifact = await reader.readArtifact(ref);
            source.assertCurrent();
            return artifact;
          }, request, sessionId: sessionId ?? null, signal }), { credentials: params.credentials, serverId: projectHomeId, signal });
        source.assertCurrent();
        return result;
      } catch { signal?.throwIfAborted(); return unavailable; }
    },
    promptDocUpdate: async ({ signal, ...request }, context) => {
      if (!approvalsStore) return notSupported();
      return await updatePromptDocInLibrary({
        store: promptStoreForContext(context, 'prompt_doc.update'),
        request,
        savedBy: artifactSavedByFromActionContextV1(context),
        ...(signal ? { signal } : {}),
      });
    },
    skillsRead: async ({ signal, ...request }, context) => {
      const operation = async () => {
        if (request.sessionId && !(request.sessionId === params.sessionId && params.getCurrentSessionSkillItems)) {
          const transport = await resolveTransportForSession(request.sessionId, signal, { context, actionId: 'skills.read' });
          if ('ok' in transport && transport.ok === false) return { ok: false, errorCode: transport.code, error: transport.code };
          const response = await callSessionActionRpc(transport, 'skills.read', request, context);
          if (response && typeof response === 'object' && 'ok' in response && response.ok === false) return response;
          return SkillReadResultV1Schema.parse(response);
        }
        if (!approvalsStore) return notSupported();
        const sessionItems = request.sessionId ? params.getCurrentSessionSkillItems?.() : undefined;
        const usage = await readSkillUsageCatalogV1(approvalsStore.skillRules, signal);
        let rules: Awaited<ReturnType<typeof readSkillRulesForItemV1>> | undefined;
        // Name reads are addressed by the Session's admitted identity, just like id
        // reads. An unrelated plugin source is not authority for this content.
        const { resolveHappierSkillIdentity } = await import("@/prompts/skills/runtime/resolveHappierSkillIdentity");
        const skillId = 'skillId' in request ? request.skillId : resolveHappierSkillIdentity(
          { name: request.name }, sessionItems ? { items: sessionItems } : undefined);
        const pluginSkills = await approvalsStore.readPluginSkills(signal, skillId ? [skillId] : []);
        const result = await readSkillInLibrary({ store: promptStoreForContext(context, 'skills.read'), request, sessionItems, pluginSkills,
          usage: usage?.row, signal, recordSessionUse: async selected => {
            // Join failures and retired plans must fail before the best-effort use fact is sent.
            rules = await readSkillRulesForItemV1(approvalsStore.skillRules, selected.skillId, signal);
            signal?.throwIfAborted();
            const currentItems = params.getCurrentSessionSkillItems?.();
            const { resolveHappierSkillIdentity } = await import("@/prompts/skills/runtime/resolveHappierSkillIdentity");
            const identity = resolveHappierSkillIdentity({ name: selected.name }, currentItems ? { items: currentItems } : undefined);
            const current = currentItems?.find(item => item.skillId === identity);
            if (identity !== selected.skillId || current?.digest !== selected.digest) return false;
            const accountId = params.credentials ? readAccountIdFromToken(params.credentials.token) : null;
            if (accountId) {
              const { recordDaemonSkillUse } = await import("@/daemon/controlClient");
              await recordDaemonSkillUse({ skillIds: [identity], account: { accountId,
              serverHttpBaseUrl: normalizeServerHttpBaseUrl(params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()),
            } }, { ...(signal ? { signal } : {}) }).catch(() => {});
            }
            return true;
          } });
        return 'skillId' in result ? { ...result, rules: rules ?? await readSkillRulesForItemV1(approvalsStore.skillRules, result.skillId, signal) } : result;
      };
      return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, operation) : operation();
    },
    skillActionExecute: executeSkillAction,
    skillMachineActionExecute: async ({ actionId, input, context }) => {
      const request = SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== request.machineId) return notSupported();
      const method = getActionSpec(actionId).bindings?.rpcMethod;
      if (!method) return notSupported();
      const call = () => callMachineAction({ machineId: request.machineId, method, request, context,
        effectActionId: actionId, authority: context.authority, exactMachine: true,
        ...(context.serverId ? { serverId: context.serverId } : {}),
        ...(context.rpcSessionAuthorization ? { authorization: context.rpcSessionAuthorization } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, call) : call();
    },
    promptBundleUpdate: async ({ signal, ...request }, context) => {
      if (!approvalsStore) return notSupported();
      return await updatePromptBundleInLibrary({
        store: promptStoreForContext(context, 'prompt_bundle.update'),
        request,
        ...(signal ? { signal } : {}),
      });
    },
    promptRegistryInstall: async ({ signal, ...request }, context) => {
      if (!approvalsStore || !params.credentials) return notSupported();
      const localMachine = await requireLocalPromptActionMachine(request.machineId);
      if (!localMachine.ok) return localMachine;
      const { createCliRegistryHostV1 } = await import("@/registries/createCliRegistryHost");
      const registry = createCliRegistryHostV1({ credentials: params.credentials, port: approvalsStore.promptLibraryStore.organization, signal,
        operationContext: params.savedSecretOperationContext });
      return installPromptRegistryItemInLibrary({
        fetchItem: async ({ sourceId, itemId }) => {
          const normalizedItemId = itemId.startsWith(sourceId + ':') ? itemId.slice(sourceId.length + 1) : itemId;
          return REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read',
            { kind: 'skill', sourceId, itemId: normalizedItemId })).item;
        },
        installLibrary: pointer => executeSkillAction({ actionId: 'skills.install', input: { source: { kind: 'registry', ...pointer } }, context }),
        request, signal,
      });
    },
  };
}
