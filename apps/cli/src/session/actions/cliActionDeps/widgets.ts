import type { CliActionDepsParams, CliActionExactHomeTarget } from './types';
import { resolveProjectAccountReferenceV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { WidgetAreaMutationErrorV1 } from '@happier-dev/protocol/widgets/widgetSurfaceArtifactV1';
import { flattenWidgetLayoutWidgetsV1 } from '@happier-dev/protocol/widgets/widgetLayoutItemV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { readProjectAccountRows, ProjectAccountRowsSelection } from '@/workspaces/projectAccountRows';
import type { readCliWidgetCatalogProjectionV1, cliWidgetCatalogEntryV1 } from '../widgetCatalogProjection';
import { describeWidgetAreaApprovalSurfaceV1, readWidgetActionAccountScopeAdmissionV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { createWidgetDefinitionArtifactPortV1 } from '@happier-dev/protocol/widgets/widgetDefinitionArtifactV1';
import { createCliWidgetInputActionDepsV1 } from '../widgetInputActionDeps';
import { createCliWidgetAreaActionDepsV1 } from '../widgetAreaActionDeps';
import { createCliWidgetDefinitionActionDepsV1 } from '../widgetDefinitionActionDeps';
import { BUILTIN_WIDGET_DESCRIPTORS_V1, countWidgetInstancesV1, isSameWidgetDefinitionV1, widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { readWidgetActionSurfacePortV1 } from '@happier-dev/protocol/widgets/executeWidgetInstanceActionV1';
import { readWidgetActionSessionTargetV1 } from '@happier-dev/protocol/widgets/actionsV1';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home/homeHubArtifactV1';
import type { HomeHubLayoutValue } from '@happier-dev/protocol/home';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE, createAcknowledgedAccountArtifactTransport, createCredentialedAccountArtifactStore, type ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { listCurrentAccountAdministrationMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { isMachineRequestReachabilityFailureV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { createSessionBoardActionDeps } from '@/session/board/sessionBoardActionDeps';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { fetchAccountProfile } from '@/api/accountProfile';
import type { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import type { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import type { CliMachineActionCall } from './machineTransport';
import type { CliProjectAdmission, CliAdmittedProjectRowsReader } from './projectAdmission';
import type { ArtifactWorkspaceCaller } from '../publishArtifactFromWorkspaceFile';
type ResolvedSessionTransport = Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, Readonly<{ ok: true }>>;
export type CliWidgetActionDeps = Pick<ActionExecutorDeps, 'widgetAccountScope' | 'widgetCatalog' | 'sessionBoardAction' | 'sessionBoardPrepareItem'> & Readonly<{
  area: ReturnType<typeof createCliWidgetAreaActionDepsV1>;
  definition: ReturnType<typeof createCliWidgetDefinitionActionDepsV1>;
  input: ReturnType<typeof createCliWidgetInputActionDepsV1>;
  readHomeWidgets: NonNullable<Parameters<typeof createHomeHubArtifactPortV1>[1]['readWidgets']>;
  readWidgetTitles(instances: readonly WidgetInstanceV1[], signal?: AbortSignal, authorizationHeaders?: ArtifactRequestAuthorizationHeaders): Promise<ReadonlyMap<string, string>>;
  isWidgetScopeCurrent(): boolean;
}>;
export function createCliWidgetActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'explicitMachineId' | 'externalActionMachineInstallationId' | 'externalActionMachineRequestPrivateKey' | 'isCredentialCurrent' | 'machineActionDirectTargetTransport' | 'resolveExactSessionEncryptionMaterial' | 'resolveServerFeaturesSnapshot' | 'savedSecretOperationContext' | 'serverHttpBaseUrl' | 'serverId' | 'serverIdentityId' | 'token'>,
  { callMachineAction, exactHome, homeAccountId, isSameActionHomeId, normalizeStringValue, readTransportSessionOwnerMetadata, requireLocalPromptActionMachine, resolveCurrentSessionValue, resolveProjectHomeIdentity, readAdmittedProjectRows, resolveServerRequestHeaders, resolveTransportForSession, resolveWorkspacePublishCaller, roleArtifactStore, sessionContentCredentials, todoHomeBaseUrl, todoHomeServerId, widgetHomeId }: Readonly<{
    callMachineAction: CliMachineActionCall;
    exactHome: CliActionExactHomeTarget;
    homeAccountId: string | null;
    isSameActionHomeId: (serverId: string) => boolean;
    normalizeStringValue: (value: unknown) => string | null;
    readTransportSessionOwnerMetadata: (transport: ResolvedSessionTransport) => ReturnType<typeof tryDecryptSessionOwnerMetadataView> | null;
    requireLocalPromptActionMachine: (machineId: string) => Promise<Readonly<{
    ok: true;
  }> | Readonly<{
    ok: false;
    errorCode: 'machine_not_found';
    error: 'machine_not_found';
  }>>;
    resolveCurrentSessionValue: (key: 'path' | 'host' | 'machineId', signal?: AbortSignal) => Promise<string | null>;
    resolveProjectHomeIdentity: CliProjectAdmission["resolveProjectHomeIdentity"];
    readAdmittedProjectRows: CliAdmittedProjectRowsReader;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
    resolveWorkspacePublishCaller: (context: ActionExecutorContext) => Promise<ArtifactWorkspaceCaller | null>;
    roleArtifactStore: ReturnType<typeof createCredentialedAccountArtifactStore> | undefined;
    sessionContentCredentials: CliActionDepsParams["credentials"];
    todoHomeBaseUrl: string;
    todoHomeServerId: string;
    widgetHomeId: string;
  }>,
  readEffectiveActionDeps: () => ActionExecutorDeps,
  readBaseActionDeps: () => ActionExecutorDeps,
): CliWidgetActionDeps {

  const resolveWidgetSessionTransport = async (sessionRef: Readonly<{ serverId: string; sessionId: string }>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!isSameActionHomeId(sessionRef.serverId)) {
      throw Object.assign(new Error('server_scope_mismatch'), { code: 'server_scope_mismatch' });
    }
    const transport = await resolveTransportForSession(sessionRef.sessionId, signal);
    if (!transport.ok || transport.sessionId !== sessionRef.sessionId) {
      throw Object.assign(new Error('widget_catalog_unavailable'), { code: 'widget_catalog_unavailable' });
    }
    // The Home's current Account projection owns Session read authority.
    // Machine metadata alone does not admit a widget's hosting or selected Session.
    if (transport.rawSession.effectiveAccess?.capabilities.readTranscript !== true) {
      throw Object.assign(new Error('widget_read_denied'), { code: 'widget_read_denied' });
    }
    return transport;
  };
  const describeWidgetProjection = async (machineId: string, signal?: AbortSignal) => {
    const result = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(await callMachineAction({
      machineId, serverId: params.serverId ?? configuration.activeServerId,
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      request: { machineId }, ...(signal ? { signal } : {}),
    }));
    signal?.throwIfAborted();
    if (!result.success) throw Object.assign(new Error('widget_catalog_unavailable'), { code: 'widget_catalog_unavailable' });
    return result.data.projection;
  };
  // Home, Project and plugin-area widgets belong to the Account, not to a Session or this process's
  // Machine. A host with neither (a standalone CLI replaying an approved Action) reads the plugin
  // projection from the Machine the CLI names with its explicit selector, otherwise from a reachable
  // Account daemon carrying the requested plugin in the availability census. Account presence also lists
  // daemons connected to other servers on a shared Account, so a
  // target-unavailable verdict moves to the next one; the Machine that answered is reused.
  const answeringAccountWidgetMachines = new Map<string, string>();
  const readAccountWidgetProjection = async (signal?: AbortSignal, requiredPluginId?: string) => {
    const key = requiredPluginId ?? '';
    const answeringAccountWidgetMachineId = answeringAccountWidgetMachines.get(key);
    if (answeringAccountWidgetMachineId) {
      try { return await describeWidgetProjection(answeringAccountWidgetMachineId, signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (!isMachineRequestReachabilityFailureV1(error)) throw error;
        answeringAccountWidgetMachines.delete(key);
      }
    }
    const { listCurrentAccountAdministrationMachines } = await import("@/api/machine/resolveCurrentAccountMachineTarget");
    const candidates = await listCurrentAccountAdministrationMachines({ token: params.token,
      ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
      ...(signal ? { signal } : {}), ...(requiredPluginId ? { requiredPluginId } : {}),
      ...(params.explicitMachineId ? { requestedMachineId: params.explicitMachineId } : {}) }).catch(error => {
        signal?.throwIfAborted();
        if (requiredPluginId) throw Object.assign(new RpcError('The plugin Machine inventory is unavailable.', 'widget_catalog_unavailable'), { cause: error });
        return [];
      });
    signal?.throwIfAborted();
    if (requiredPluginId && !candidates.length) {
      throw new RpcError(`No Machine on this Account has the plugin ${requiredPluginId} available.`, 'widget_type_unavailable');
    }
    let unavailable: unknown;
    for (const machineId of candidates) {
      try {
        const projection = await describeWidgetProjection(machineId, signal);
        answeringAccountWidgetMachines.set(key, machineId);
        return projection;
      } catch (error) {
        signal?.throwIfAborted();
        if (!isMachineRequestReachabilityFailureV1(error)) throw error;
        unavailable = error;
      }
    }
    if (unavailable) throw unavailable;
    return null;
  };
  const readWidgetProjection = async (signal?: AbortSignal, sessionRef?: Readonly<{ serverId: string; sessionId: string }>, requiredPluginId?: string) => {
    signal?.throwIfAborted();
    const transport = sessionRef ? await resolveWidgetSessionTransport(sessionRef, signal) : null;
    const machineId = transport?.ok
      ? normalizeStringValue(readTransportSessionOwnerMetadata(transport)?.machineId)
      : params.machineActionDirectTargetTransport?.machineId ?? normalizeStringValue(await resolveCurrentSessionValue('machineId'));
    if (machineId) return await describeWidgetProjection(machineId, signal);
    return transport ? null : await readAccountWidgetProjection(signal, requiredPluginId);
  };
  const readWidgetCandidates = async (signal?: AbortSignal, sessionRef?: Readonly<{ serverId: string; sessionId: string }>, requiredPluginId?: string) => {
    const projection = await readWidgetProjection(signal, sessionRef, requiredPluginId);
    const { readCliWidgetCatalogProjectionV1 } = await import("../widgetCatalogProjection");
    return projection ? readCliWidgetCatalogProjectionV1(projection)
      : BUILTIN_WIDGET_DESCRIPTORS_V1.map(candidate => ({ ...candidate, fields: candidate.inputs?.fields ?? [], connectedAccountPurposeBindings: [] }));
  };
  const readHomeWidgets = async (signal?: AbortSignal, layout?: HomeHubLayoutValue) => {
    const candidates = await readWidgetCandidates(signal);
    const referenced = new Set(layout ? flattenWidgetLayoutWidgetsV1(layout.items).flatMap(({ instance }) => instance.definition.kind === 'artifact' ? [instance.definition.artifactId] : []) : []);
    if (referenced.size === 0) return candidates;
    const definitions = await readBaseActionDeps().widgetDefinitionArtifacts?.summaries([...referenced], signal) ?? [];
    return [...candidates, ...definitions.map(summary => ({
      key: `artifact:${summary.artifactId}`, homeDefault: 'available' as const,
      definition: { kind: 'artifact' as const, artifactId: summary.artifactId }, sizeDeclaration: summary.sizeDeclaration,
    }))];
  };
  const readWidgetTitles: CliWidgetActionDeps['readWidgetTitles'] = async (instances, signal, authorizationHeaders) => {
    const { readCliWidgetInstanceTitlesV1 } = await import('../widgetCatalogProjection');
    if (!roleArtifactStore || !homeAccountId) return new Map();
    const definitions = createWidgetDefinitionArtifactPortV1({ ...roleArtifactStore,
      read: (id, options) => runWithServerHttpBaseUrl(todoHomeBaseUrl, async () => {
        try {
          return await roleArtifactStore.read(id, { ...options, authorizationHeaders,
            prepareRecipients: false, includeSharedAudience: false });
        } catch (error) {
          options?.signal?.throwIfAborted();
          // An unavailable private definition remains an unnamed placement;
          // title preparation grants no extra content authority or key repair.
          if (error instanceof Error && 'code' in error
            && (error.code === 'artifact_read_unavailable' || error.code === ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE)) return null;
          throw error;
        }
      }),
    }, { accountId: homeAccountId });
    return readCliWidgetInstanceTitlesV1({ instances, signal,
      readSummaries: definitions.summaries,
      // Captured Artifact authority does not grant ambient Machine catalog discovery.
      readCandidates: authorizationHeaders ? async () => []
        : async (signal, requiredPluginId) => {
          try { return await readWidgetCandidates(signal, undefined, requiredPluginId); }
          catch (error) {
            signal?.throwIfAborted();
            const code = readRpcErrorCode(error) ?? (error instanceof Error && 'code' in error ? error.code : undefined);
            if (code === 'widget_type_unavailable' || code === 'widget_catalog_unavailable'
              || isMachineRequestReachabilityFailureV1(error)) return [];
            throw error;
          }
        } });
  };
  const widgetBoardDeps = sessionContentCredentials ? createSessionBoardActionDeps({
    credentials: sessionContentCredentials,
    resolvePublishCaller: async (context, sessionId) => {
      // A bound Agent publishes from its own host-proved workspace, never from
      // a retargeted Session. An unbound CLI host selects the destination's
      // workspace explicitly; that selector is not fabricated caller identity.
      const caller = await resolveWorkspacePublishCaller(context);
      if (caller || context.actionCaller && context.actionCaller.kind !== 'host') return caller;
      const transport = await resolveTransportForSession(sessionId, context.signal,
        { context, actionId: 'session.board.item.upsert' });
      if (!transport.ok || transport.sessionId !== sessionId || transport.rawSession.id !== sessionId
        || transport.rawSession.effectiveAccess?.capabilities.editSessionRecords !== true) return null;
      const metadata = readTransportSessionOwnerMetadata(transport);
      if (!metadata) return null;
      const machineId = normalizeStringValue(transport.rawSession.machineId) ?? normalizeStringValue(metadata.machineId);
      const directory = normalizeStringValue(metadata.path) ?? normalizeStringValue(transport.rawSession.path);
      if (!machineId || !directory || !(await requireLocalPromptActionMachine(machineId)).ok) return null;
      return { sessionId, machineId, directory };
    },
    ...(params.resolveExactSessionEncryptionMaterial ? { resolveExactSessionEncryptionMaterial: params.resolveExactSessionEncryptionMaterial } : {}),
    ...(params.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
    ...exactHome,
    ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
    ...(params.externalActionMachineRequestPrivateKey ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey } : {}),
    ...(params.externalActionMachineInstallationId ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId } : {}),
  }) : null;
  // Captured CLI invocations keep their explicit Home; ambient invocations follow the active Home.
  const isWidgetScopeCurrent = () => !!params.serverId || configuration.activeServerId === todoHomeServerId;
  return {
area: (roleArtifactStore && homeAccountId ? createCliWidgetAreaActionDepsV1({
      transport: createAcknowledgedAccountArtifactTransport({
        read: (id, options) => runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.read(id, options)),
        create: args => runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.create(args)),
        update: args => runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.update(args)),
        list: args => runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.list(args)),
        delete: (id, options) => runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.delete(id, options)),
      }), scope: { serverId: widgetHomeId, accountId: homeAccountId },
      isCurrent: isWidgetScopeCurrent,
      readTitles: readWidgetTitles,
      readProjectReference: async (project, signal, context) => {
        const rows = await readAdmittedProjectRows({ kinds: ['workspace-ref'], serverId: await resolveProjectHomeIdentity() },
          signal, context, 'widgets.area.layout.delete');
        if (!rows) throw new WidgetAreaMutationErrorV1('project_account_rows_unavailable');
        return resolveProjectAccountReferenceV1(rows, project, id => isSameActionHomeId(id) ? widgetHomeId : id);
      },
    }) : {}),
definition: (roleArtifactStore && homeAccountId ? createCliWidgetDefinitionActionDepsV1({
      transport: roleArtifactStore, accountId: homeAccountId, serverHttpBaseUrl: params.serverHttpBaseUrl,
      getDeps: () => readEffectiveActionDeps(), readCandidates: readWidgetCandidates,
    }) : {}),
input: createCliWidgetInputActionDepsV1({
      serverId: widgetHomeId, accountId: homeAccountId,
      getDeps: () => readEffectiveActionDeps(), readCandidates: readWidgetCandidates,
      readWorkspaceRefs: async (signal, context) => (await readAdmittedProjectRows({ kinds: ['workspace-ref'], serverId: await resolveProjectHomeIdentity() },
        signal, context, 'widgets.item.inputs.validate'))?.workspaceRefs ?? null,
      readInputTypes: async (signal, session, pluginId) => (await readWidgetProjection(signal, session, pluginId))?.familiesById.inputTypes,
      readResources: async (signal, session) => {
        const projection = await readWidgetProjection(signal, session);
        return { resources: Object.values(projection?.resourcesById ?? {}),
          connectedAccountDescriptors: Object.values(projection?.familiesById.connectedAccounts?.entriesById ?? {}) };
      },
      readViewerPurposeContext: async (signal, context) => {
        if (!params.credentials || !homeAccountId) return null;
        const credentials = params.credentials;
        const operationContext = params.savedSecretOperationContext;
        const home = operationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
        const read = async () => {
          const authorizeRequest = (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
            resolveServerRequestHeaders(context, context.externalActionExecutionAuthorization?.binding.actionId ?? 'widgets.catalog.list', request);
          const catalogInput = { credentials, signal, operationContext, authorizeRequest };
          const [{ createCliConnectedAccountCatalogStore }, { readActiveConnectedAccountCatalog }, { fetchAccountProfile }] = await Promise.all([import("@/settings/connectedAccounts/connectedAccountCatalogStore"), import("@/settings/connectedAccounts/hydrateConnectedAccountCatalog"), import("@/api/accountProfile")]);
          const store = createCliConnectedAccountCatalogStore(catalogInput);
          store.assertCurrent();
          const purpose = await readActiveConnectedAccountCatalog({ ...catalogInput, key: 'purposes' });
          store.assertCurrent();
          if (purpose.status !== 'ready' || purpose.record.key !== 'purposes') return null;
          const profile = await fetchAccountProfile({ token: credentials.token, signal, authorizeRequest });
          store.assertCurrent();
          if (operationContext && !await operationContext.isCurrent()
            || params.isCredentialCurrent && !await params.isCredentialCurrent()) return null;
          store.assertCurrent();
          return profile.id === homeAccountId ? { profile, purposeBindings: purpose.record.value } : null;
        };
        return runWithServerHttpBaseUrl(home, read);
      },
      validateSession: async (session, signal) => {
        if (!isSameActionHomeId(session.serverId)) return false;
        const transport = await resolveTransportForSession(session.sessionId, signal);
        return transport.ok && transport.sessionId === session.sessionId;
      },
    }),
widgetAccountScope: () => {
      const accountId = params.credentials ? readAccountIdFromToken(params.credentials.token) : null;
      return accountId ? { serverId: widgetHomeId, accountId, isSameServerId: isSameActionHomeId } : null;
    },
widgetCatalog: { describeSurface: async (surface, _context, signal) => {
      const projection = await readWidgetProjection(signal, undefined, surface.owner.kind === 'pluginArea' ? surface.owner.pluginId : undefined);
      return describeWidgetAreaApprovalSurfaceV1(surface, Object.values(projection?.familiesById.pluginUi?.entriesById ?? {}));
    }, readInstalledDescriptor: async ({ surface, definition, context, signal, boundSession }) => {
      const admission = readWidgetActionAccountScopeAdmissionV1(readEffectiveActionDeps(), surface, context);
      if (!admission.ok) return admission;
      const isCurrent = async () => isWidgetScopeCurrent()
        && (!params.isCredentialCurrent || await params.isCredentialCurrent())
        && (!params.savedSecretOperationContext || await params.savedSecretOperationContext.isCurrent());
      if (!await isCurrent()) return { ok: false, errorCode: 'widget_scope_unavailable', error: 'widget_scope_unavailable' };
      const physicalSession = readWidgetActionSessionTargetV1(surface);
      const candidates = await readWidgetCandidates(signal, readWidgetActionSessionTargetV1(surface, boundSession),
        definition.surface.pluginId);
      if (physicalSession && boundSession && physicalSession.sessionId !== boundSession.sessionId) {
        await resolveWidgetSessionTransport(physicalSession, signal);
      }
      signal?.throwIfAborted();
      if (!await isCurrent()) return { ok: false, errorCode: 'widget_scope_unavailable', error: 'widget_scope_unavailable' };
      const candidate = candidates.find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition));
      return candidate ?? null;
    }, list: async (surface, _context, signal, boundSession) => {
      const port = readWidgetActionSurfacePortV1(readBaseActionDeps(), surface);
      if (!port) return { ok: false, errorCode: 'unsupported_widget_surface', error: 'unsupported_widget_surface' };
      const sessionRef = readWidgetActionSessionTargetV1(surface, boundSession);
      const candidates = await readWidgetCandidates(signal, sessionRef);
      const read = await port.read(surface, _context, signal);
      if ('ok' in read) return read;
      const instances = read.instances.map(entry => entry.instance);
      const { cliWidgetCatalogEntryV1 } = await import("../widgetCatalogProjection");
      const entries = candidates.map(candidate => cliWidgetCatalogEntryV1(candidate, countWidgetInstancesV1(instances, widgetCandidateDefinitionV1(candidate))));
      for (const summary of await readBaseActionDeps().widgetDefinitionArtifacts?.list(signal) ?? []) {
        const reference = { kind: 'artifact' as const, artifactId: summary.artifactId };
        entries.push({ definition: reference, title: summary.name, fields: [...summary.inputs.fields], inputSchema: summary.inputSchema,
          sizeDeclaration: summary.sizeDeclaration,
          ...(summary.publicPresentation ? { publicPresentation: summary.publicPresentation } : {}),
          availability: summary.bodyKind === 'declarative' || summary.bodyKind === 'html' || summary.bodyKind === 'builtin' || summary.sourceDefinition && candidates.some(candidate => candidate.availability === 'available'
            && isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), summary.sourceDefinition!)) ? 'available' : 'unavailable',
          instanceCount: countWidgetInstancesV1(instances, reference) });
      }
      return entries;
    } },
sessionBoardAction: widgetBoardDeps?.sessionBoardAction
      ?? (async () => ({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' })),
sessionBoardPrepareItem: widgetBoardDeps?.sessionBoardPrepareItem,
readHomeWidgets, readWidgetTitles, isWidgetScopeCurrent
  };
}
