import {
  ExternalSessionsAgentIdSchema,
  ExternalSessionTakeoverTargetDirectoryV1Schema,
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  type ExternalSessionsSource,
  type PluginAgentExternalLinkedTakeoverWriterSafetyV1,
} from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import { fetchAccountProfile } from '@/api/accountProfile';
import { ensureExternalSessionLink } from '@/api/session/external/linking/ensureExternalSessionLink';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
  indexAgentRoutingIdsByContributionIdentity,
  readAgentRoutingIdForContributionIdentity,
} from '@/plugins/projection/registry/agentRoutingIdentity';
import type { StoredCredentials } from '@/persistence';
import { createExternalSessionSourceKeyOwnerFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import {
  getActiveAccountSettingsSnapshot,
  resolveActiveAccountConfiguredExternalSessionSourceRevision,
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ExternalSessionPluginTakeoverStart } from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';

import {
  configuredExternalSessionSourcesUseConnectedProfiles,
  createLiveConfiguredPluginExternalSessionsAdapter,
  readAuthorCancellationOptions,
  type ConfiguredExternalSessionSourceAgentContribution,
  type LiveConfiguredPluginExternalSessionsAdapter,
} from './configuredSourceMaterializer';
import {
  createContextualExternalSessionTakeoverAdapter,
  type ContextualExternalSessionTakeoverAdapter,
  type ContextualExternalSessionTakeoverDependencies,
} from './contextualTakeoverAdmission';
import {
  createExternalSessionsUnavailableCapabilities,
  type HostExternalSessionsAuthorService,
} from './privateContract';
import type { ExternalSessionHostOperationOwner } from './hostOperationOwner';
import type { ExternalSessionExecutionSurface } from './providerOps';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from './agentExternalSessionsInvocation';

export {
  createCurrentGlobalExternalSessionsRouter,
  type CurrentGlobalExternalSessionsPublicAccess,
  type CurrentGlobalExternalSessionsRouter,
} from './currentGlobalRouting';
import {
  unrestrictedCurrentGlobalExternalSessionsPublicAccess,
} from './currentGlobalRouting';
import type { CurrentGlobalExternalSessionsPublicAccess } from './currentGlobalRouting';

type CurrentAgentRuntime = Readonly<{
  generationId: string;
  /**
   * Immutable identity of the Agent plugin artifact behind this lease, as opposed
   * to `generationId`, which names one activation. Persisted host state that must
   * survive a daemon restart but not a plugin upgrade — the candidate index — is
   * qualified by this, so the same installed Agent keeps its index across
   * restarts and a replaced one never inherits it.
   */
  immutableGenerationId: string | null;
  retirementSignal: AbortSignal;
  isCurrent(): boolean;
  surface: ExternalSessionExecutionSurface;
}>;

export type CurrentGlobalExternalSessionsAuthorServiceParams = Readonly<{
  contributionGenerationId: string;
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  activeServerDir?: string;
  activeServerId?: string;
  readCredentials(): Promise<StoredCredentials | null>;
  resolveMachineId(): string | null;
  resolveAgentRuntime(agentId: string): CurrentAgentRuntime | null;
  onSourceRefusalsChanged?(
    refusals: LiveConfiguredPluginExternalSessionsAdapter['sourceRefusals'],
  ): void;
  externalSessionHostOperationOwner?: ExternalSessionHostOperationOwner;
  isCurrent(): boolean;
}>;

/**
 * The source-dependent half of contextual takeover admission. It only exists
 * while a configured-source owner exists; the durable replay/conflict preflight
 * that precedes it does not depend on any of it.
 */
export type CurrentGlobalExternalSessionsTakeoverSourceOps = Pick<
  ContextualExternalSessionTakeoverDependencies,
  | 'resolveCurrentSource'
  | 'ensureLink'
  | 'resolveAgentRoutingId'
  | 'deriveTakeoverStartRequest'
>;

export type PersistedTakeoverSourceAdmission = Readonly<{
  source: ExternalSessionsSource;
  externalLinkedTakeoverWriterSafety:
    PluginAgentExternalLinkedTakeoverWriterSafetyV1;
}>;

export type CurrentGlobalExternalSessionsAuthorService =
  LiveConfiguredPluginExternalSessionsAdapter & Readonly<{
    takeoverSourceOps: CurrentGlobalExternalSessionsTakeoverSourceOps;
    admitPersistedTakeoverSource(input: Readonly<{
      agentId: string;
      machineId: string;
      sourceId: string;
      source: ExternalSessionsSource;
    }>): PersistedTakeoverSourceAdmission | null;
    bindCallerAuthorService(input: Readonly<{
      pluginId: string;
      contextualTakeover?: ContextualExternalSessionTakeoverAdapter;
    }>): HostExternalSessionsAuthorService;
  }>;

/**
 * Builds the one contextual takeover adapter a caller ever uses.
 *
 * It is created here, above the configured-source owner, because durable
 * replay and idempotency-conflict admission are facts of the caller's durable
 * operation record, not of any current source. A successful Start whose
 * response was lost must stay replayable after the last configured source is
 * removed; only a true miss needs current source authority, and that is what
 * `resolveSourceOps` refuses when no owner exists.
 */
export function createCurrentGlobalExternalSessionsTakeoverAdapter(params: Readonly<{
  activeServerDir: string;
  pluginId: string;
  startDurableTakeover: ExternalSessionPluginTakeoverStart;
  resolveSourceOps(): CurrentGlobalExternalSessionsTakeoverSourceOps | null;
}>): ContextualExternalSessionTakeoverAdapter {
  const requireSourceOps = (): CurrentGlobalExternalSessionsTakeoverSourceOps => {
    const ops = params.resolveSourceOps();
    if (!ops) throw failure('plugin_external_sources_unavailable');
    return ops;
  };
  return createContextualExternalSessionTakeoverAdapter({
    activeServerDir: params.activeServerDir,
    pluginId: params.pluginId,
    resolveCurrentSource: async (ref, options) =>
      await requireSourceOps().resolveCurrentSource(ref, options),
    ensureLink: async (input) => await requireSourceOps().ensureLink(input),
    resolveAgentRoutingId: async (agent) =>
      await requireSourceOps().resolveAgentRoutingId(agent),
    deriveTakeoverStartRequest: async (input) =>
      await requireSourceOps().deriveTakeoverStartRequest(input),
    startDurableTakeover: params.startDurableTakeover,
  });
}

export function createCurrentGlobalExternalSessionsAuthorBinding(params: Readonly<{
  pluginId: string;
  signal: AbortSignal;
  isGenerationCurrent(): boolean;
  activeServerDir?: string;
  takeoverStart?: ExternalSessionPluginTakeoverStart;
  resolveCurrent(): CurrentGlobalExternalSessionsAuthorService | null;
  activateConfiguredSources(agentId?: string): Promise<void>;
  /**
   * The daemon-lifetime router re-evaluates current-public HostAccess on every
   * call, preserving the resolved Session scopes that the ratified operation
   * mapping consumes. Omitted only by owner-local tests that do not model that
   * router.
   */
  readCurrentPublicAccess?(): CurrentGlobalExternalSessionsPublicAccess;
}>): HostExternalSessionsAuthorService {
  const contextualTakeover = params.activeServerDir && params.takeoverStart
    ? createCurrentGlobalExternalSessionsTakeoverAdapter({
        activeServerDir: params.activeServerDir,
        pluginId: params.pluginId,
        startDurableTakeover: params.takeoverStart,
        resolveSourceOps: () => params.resolveCurrent()?.takeoverSourceOps ?? null,
      })
    : undefined;
  let boundOwner: CurrentGlobalExternalSessionsAuthorService | null = null;
  let boundService: HostExternalSessionsAuthorService | null = null;
  const readCurrent = (): HostExternalSessionsAuthorService | null => {
    const owner = params.resolveCurrent();
    if (!owner) {
      boundOwner = null;
      boundService = null;
      return null;
    }
    if (owner !== boundOwner || !boundService) {
      boundOwner = owner;
      boundService = owner.bindCallerAuthorService({
        pluginId: params.pluginId,
        ...(contextualTakeover ? { contextualTakeover } : {}),
      });
    }
    return boundService;
  };
  const readCallerFailureCode = (operationSignal?: AbortSignal): string | null => {
    let generationCurrent = false;
    try {
      generationCurrent = params.isGenerationCurrent() === true;
    } catch {
      generationCurrent = false;
    }
    if (!generationCurrent) return 'plugin_generation_retired';
    if (params.signal.aborted || operationSignal?.aborted) {
      return 'plugin_operation_aborted';
    }
    return null;
  };
  const assertCallerCurrent = (operationSignal?: AbortSignal): void => {
    const code = readCallerFailureCode(operationSignal);
    if (code) throw failure(code);
  };
  const readInvocationFailureCode = (
    operationSignal: AbortSignal | undefined,
    deadlineSignal: AbortSignal,
  ): string | null => (
    readCallerFailureCode(operationSignal)
    ?? (deadlineSignal.aborted ? 'plugin_operation_deadline_exceeded' : null)
  );
  const assertInvocationCurrent = (
    operationSignal: AbortSignal | undefined,
    deadlineSignal: AbortSignal,
  ): void => {
    const code = readInvocationFailureCode(operationSignal, deadlineSignal);
    if (code) throw failure(code);
  };
  /**
   * Ratified public mapping: `capabilities`, `list`, `readTranscript`, and
   * `followTranscript` require Session `read`; `attach` and `takeover` require
   * Session `control`.
   */
  const assertCurrentPublicAccess = (requiredAccess: 'read' | 'control'): void => {
    const access = params.readCurrentPublicAccess?.()
      ?? unrestrictedCurrentGlobalExternalSessionsPublicAccess;
    if (access.status === 'denied') {
      throw failure('plugin_service_unavailable');
    }
    if (access.status === 'unavailable') {
      throw failure('plugin_services_current_global_unavailable');
    }
    if (!access.scopes.some((scope) => scope.access.includes(requiredAccess))) {
      throw failure('plugin_session_scope_unavailable');
    }
  };
  const assertCurrentPublicInvocation = (
    operationSignal: AbortSignal | undefined,
    deadlineSignal: AbortSignal,
    requiredAccess: 'read' | 'control',
  ): void => {
    assertInvocationCurrent(operationSignal, deadlineSignal);
    assertCurrentPublicAccess(requiredAccess);
  };
  const resolveCurrentForInvocation = async (
    agentId: string | undefined,
    operationSignal: AbortSignal | undefined,
    deadlineSignal: AbortSignal,
    requiredAccess: 'read' | 'control',
  ): Promise<HostExternalSessionsAuthorService | null> => {
    assertCurrentPublicInvocation(operationSignal, deadlineSignal, requiredAccess);
    await params.activateConfiguredSources(agentId);
    assertCurrentPublicInvocation(operationSignal, deadlineSignal, requiredAccess);
    return readCurrent();
  };
  const unavailable = (code: string) => Object.freeze({
    status: 'unavailable' as const,
    code,
  });
  const invoke = async <T>(input: Readonly<{
    agentId?: string;
    operationSignal?: AbortSignal;
    /** Ratified Session scope level this public operation requires. */
    requiredAccess: 'read' | 'control';
    /**
     * Takeover alone survives an absent configured-source owner, because its
     * durable replay/conflict admission precedes every source read. Every other
     * operation still fails closed with `plugin_external_sources_unavailable`.
     */
    withoutCurrentSourceOwner?(signal: AbortSignal): Promise<T>;
    operation(
      service: HostExternalSessionsAuthorService,
      signal: AbortSignal,
    ): Promise<T>;
  }>): Promise<T> => {
    const deadline = new AbortController();
    const timeout = setTimeout(
      () => deadline.abort(),
      EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs,
    );
    const invocationSignal = AbortSignal.any([
      params.signal,
      deadline.signal,
      ...(input.operationSignal ? [input.operationSignal] : []),
    ]);
    try {
      assertCurrentPublicInvocation(input.operationSignal, deadline.signal, input.requiredAccess);
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          const code = readInvocationFailureCode(
            input.operationSignal,
            deadline.signal,
          );
          reject(failure(code ?? 'plugin_operation_aborted'));
        };
        if (invocationSignal.aborted) {
          onAbort();
          return;
        }
        invocationSignal.addEventListener('abort', onAbort, { once: true });
        void (async () => {
          const service = await resolveCurrentForInvocation(
            input.agentId,
            input.operationSignal,
            deadline.signal,
            input.requiredAccess,
          );
          if (!service && !input.withoutCurrentSourceOwner) {
            throw failure('plugin_external_sources_unavailable');
          }
          const result = service
            ? await input.operation(service, invocationSignal)
            : await input.withoutCurrentSourceOwner!(invocationSignal);
          assertCurrentPublicInvocation(
            input.operationSignal,
            deadline.signal,
            input.requiredAccess,
          );
          return result;
        })().then(resolve, reject).finally(() => {
          invocationSignal.removeEventListener('abort', onAbort);
        });
      });
    } catch (error) {
      assertInvocationCurrent(input.operationSignal, deadline.signal);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  return Object.freeze<HostExternalSessionsAuthorService>({
    async capabilities(options) {
      try {
        const parsedOptions = readAuthorCancellationOptions(options);
        return await invoke({
          requiredAccess: 'read',
          ...(parsedOptions?.signal ? { operationSignal: parsedOptions.signal } : {}),
          operation: async (service, signal) => await service.capabilities({ signal }),
        });
      } catch (error) {
        if (
          isPluginError(error)
          && (
            error.code === 'plugin_external_sources_unavailable'
            || error.code === 'plugin_service_unavailable'
            || error.code === 'plugin_services_current_global_unavailable'
            || error.code === 'plugin_session_scope_unavailable'
            || error.code === 'plugin_generation_retired'
            || error.code === 'plugin_operation_aborted'
            || error.code === 'plugin_operation_deadline_exceeded'
          )
        ) {
          return createExternalSessionsUnavailableCapabilities(error.code);
        }
        throw error;
      }
    },
    async list(query, options) {
      const parsedOptions = readAuthorCancellationOptions(options);
      return await invoke({
        ...(query?.agentId ? { agentId: query.agentId } : {}),
        requiredAccess: 'read',
        ...(parsedOptions?.signal ? { operationSignal: parsedOptions.signal } : {}),
        operation: async (service, signal) => await service.list(query, { signal }),
      });
    },
    async attach(ref, options) {
      const parsedOptions = readAuthorCancellationOptions(options);
      return await invoke({
        agentId: ref.agentId,
        requiredAccess: 'control',
        ...(parsedOptions?.signal ? { operationSignal: parsedOptions.signal } : {}),
        operation: async (service, signal) => await service.attach(ref, { signal }),
      });
    },
    async readTranscript(ref, query, options) {
      const parsedOptions = readAuthorCancellationOptions(options);
      return await invoke({
        agentId: ref.agentId,
        requiredAccess: 'read',
        ...(parsedOptions?.signal ? { operationSignal: parsedOptions.signal } : {}),
        operation: async (service, signal) => await service.readTranscript(
          ref,
          query,
          { signal },
        ),
      });
    },
    async followTranscript(ref, options, listener) {
      try {
        return await invoke({
          agentId: ref.agentId,
          requiredAccess: 'read',
          ...(options.signal ? { operationSignal: options.signal } : {}),
          operation: async (service, signal) => await service.followTranscript(
            ref,
            { ...options, signal },
            listener,
          ),
        });
      } catch (error) {
        if (
          isPluginError(error)
          && (
            error.code === 'plugin_external_sources_unavailable'
            || error.code === 'plugin_service_unavailable'
            || error.code === 'plugin_services_current_global_unavailable'
            || error.code === 'plugin_session_scope_unavailable'
            || error.code === 'plugin_generation_retired'
            || error.code === 'plugin_operation_aborted'
            || error.code === 'plugin_operation_deadline_exceeded'
          )
        ) {
          return unavailable(error.code);
        }
        throw error;
      }
    },
    async takeover(ref, request, options) {
      const parsedOptions = readAuthorCancellationOptions(options);
      return await invoke({
        agentId: ref.agentId,
        requiredAccess: 'control',
        ...(parsedOptions?.signal ? { operationSignal: parsedOptions.signal } : {}),
        // Same adapter instance the bound owner uses, so there is exactly one
        // durable admission owner whether or not a source owner is current.
        ...(contextualTakeover
          ? {
              withoutCurrentSourceOwner: async (signal) =>
                await contextualTakeover.takeover(
                  ref as Parameters<
                    ContextualExternalSessionTakeoverAdapter['takeover']
                  >[0],
                  request as Parameters<
                    ContextualExternalSessionTakeoverAdapter['takeover']
                  >[1],
                  Object.freeze({
                    signal,
                    isCurrent: () => readCallerFailureCode() === null,
                  }),
                ),
            }
          : {}),
        operation: async (service, signal) => await service.takeover(
          ref,
          request,
          { signal },
        ),
      });
    },
  });
}

function failure(code: string, cause?: unknown): PluginError {
  return new PluginError(
    { code, message: code },
    cause instanceof Error ? { cause } : undefined,
  );
}

function requireMachineId(params: CurrentGlobalExternalSessionsAuthorServiceParams): string {
  const machineId = params.resolveMachineId()?.trim() ?? '';
  if (!machineId) throw failure('plugin_external_machine_unavailable');
  return machineId;
}

async function requireCredentials(
  params: CurrentGlobalExternalSessionsAuthorServiceParams,
): Promise<StoredCredentials> {
  const credentials = await params.readCredentials();
  if (!credentials) throw failure('plugin_external_credentials_unavailable');
  return credentials;
}

function readProviderOps(runtime: CurrentAgentRuntime | null) {
  const surface = runtime?.surface;
  if (
    !surface
    || typeof surface.validateSource !== 'function'
    || typeof surface.listCandidates !== 'function'
    || typeof surface.pageTranscript !== 'function'
    || typeof surface.readAfterTranscript !== 'function'
  ) {
    return null;
  }
  return Object.freeze({
    validateSource: surface.validateSource,
    listCandidates: surface.listCandidates,
    pageTranscript: surface.pageTranscript,
    readAfterTranscript: surface.readAfterTranscript,
    ...(surface.resolveLinkIdentity
      ? { resolveLinkIdentity: surface.resolveLinkIdentity }
      : {}),
    ...(surface.externalLinkedTakeoverWriterSafety
      ? {
          externalLinkedTakeoverWriterSafety:
            surface.externalLinkedTakeoverWriterSafety,
        }
      : {}),
    ...(surface.externalSessionTakeoverAdmitted
      ? {
          externalSessionTakeoverAdmitted:
            surface.externalSessionTakeoverAdmitted,
        }
      : {}),
  });
}

/**
 * Materializes the ordinary-plugin, current-global External Sessions author
 * service. The configured source materializer remains the sole source-aware
 * owner; this function only supplies current registry, link, follow, and
 * caller-principal admission boundaries.
 */
export async function createCurrentGlobalExternalSessionsAuthorService(
  params: CurrentGlobalExternalSessionsAuthorServiceParams,
): Promise<CurrentGlobalExternalSessionsAuthorService> {
  let lifecycle: LiveConfiguredPluginExternalSessionsAdapter | null = null;
  const resolveCurrentExternalSessionProviderOps = async (
    agentId: string,
  ): Promise<ExternalSessionExecutionSurface | null> =>
    params.resolveAgentRuntime(agentId)?.surface ?? null;
  const resolveCurrentExternalSessionSourceKeyOwner = async (
    agentId: string,
    source: ExternalSessionsSource,
  ) => params.resolveAgentRuntime(agentId)
    ? createExternalSessionSourceKeyOwnerFromAgentProjection(
        { agents: params.agents },
        agentId,
        source,
      )
    : null;

  const ensureLink = async (input: Readonly<{
    ref: Readonly<{ agentId: string; remoteSessionId: string }>;
    source: ExternalSessionsSource;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ sessionId: string }>> => {
    const credentials = await requireCredentials(params);
    const machineId = requireMachineId(params);
    const agentId = ExternalSessionsAgentIdSchema.parse(input.ref.agentId);
    const linked = await ensureExternalSessionLink({
      credentials,
      machineId,
      agentId,
      remoteSessionId: input.ref.remoteSessionId,
      source: input.source,
      ...(input.signal ? { signal: input.signal } : {}),
    }, {
      resolveExternalSessionProviderOps:
        resolveCurrentExternalSessionProviderOps,
      resolveCurrentAgent: async (candidateAgentId) => {
        const agent = params.agents.find((candidate) => candidate.id === candidateAgentId);
        return agent?.identity
          ? Object.freeze({
              identity: agent.identity,
              sourceKinds:
                agent.richDefinition?.definition.surfaces?.externalSession.sources.map(
                  (source) => source.sourceKind,
                ) ?? [],
            })
          : null;
      },
      resolveSourceKeyOwner: resolveCurrentExternalSessionSourceKeyOwner,
    });
    return Object.freeze({ sessionId: linked.sessionId });
  };

  /**
   * This service's own Agent projection already carries the routing ids the
   * registry assigned, so the durable identity in a derived takeover request is
   * mapped here rather than through a second, independently advancing current
   * registry read.
   */
  const agentRoutingIdsByContributionIdentity =
    indexAgentRoutingIdsByContributionIdentity(params.agents);
  const takeoverSourceOps: CurrentGlobalExternalSessionsTakeoverSourceOps =
    Object.freeze({
      resolveAgentRoutingId: async (agent) =>
        readAgentRoutingIdForContributionIdentity(
          agentRoutingIdsByContributionIdentity,
          agent,
        ),
      resolveCurrentSource: async (ref, options) => {
      const current = lifecycle;
      if (!current) throw failure('plugin_external_sources_unavailable');
      return await current.resolveAuthorSource(
        ref,
        options?.signal ? { signal: options.signal } : undefined,
      );
    },
    ensureLink: async ({ ref, source, signal }) => await ensureLink({
      ref,
      source,
      ...(signal ? { signal } : {}),
    }),
    deriveTakeoverStartRequest: async ({
      ref,
      source,
      sessionId,
      targetStorageMode,
      durableIdempotencyKey,
      signal,
    }) => {
      const credentials = await requireCredentials(params);
      const machineId = requireMachineId(params);
      const loaded = await loadLinkedExternalSession({
        credentials,
        sessionId,
        machineId,
        expectedIdentity: {
          agentId: ExternalSessionsAgentIdSchema.parse(ref.agentId),
          machineId,
          remoteSessionId: ref.remoteSessionId,
          source,
        },
        ...(signal ? { signal } : {}),
      }, {
        resolveExternalSessionProviderOps:
          resolveCurrentExternalSessionProviderOps,
        resolveExternalSessionSourceKeyOwner:
          resolveCurrentExternalSessionSourceKeyOwner,
      });
      if (!loaded.ok) {
        throw failure('plugin_external_takeover_link_unavailable');
      }
      const linked = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(
        loaded.session.metadata,
      );
      if (!linked?.qualifiedIdentity) {
        throw failure('plugin_external_takeover_link_invalid');
      }
      const targetDirectory = ExternalSessionTakeoverTargetDirectoryV1Schema.safeParse(
        loaded.session.sessionPath,
      );
      if (!targetDirectory.success) {
        throw failure('plugin_external_takeover_target_directory_unavailable');
      }
      return Object.freeze({
        v: 1 as const,
        idempotencyKey: durableIdempotencyKey,
        sessionId,
        source: Object.freeze({
          machineId: loaded.session.machineId,
          remoteSessionId: loaded.session.remoteSessionId,
          qualifiedIdentity: linked.qualifiedIdentity,
          linkGeneration: loaded.session.linkGeneration,
        }),
        plan: 'takeover' as const,
        targetStorageMode,
        targetDirectory: targetDirectory.data,
        targetRuntimeMode: 'terminal' as const,
      });
    },
  });

  const readsConnectedProfiles =
    configuredExternalSessionSourcesUseConnectedProfiles(params.agents);
  lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
    agents: params.agents,
    contributionGenerationId: params.contributionGenerationId,
    ...(params.activeServerDir ? { activeServerDir: params.activeServerDir } : {}),
    readAccount: async () => readsConnectedProfiles
      ? await fetchAccountProfile({ token: (await requireCredentials(params)).token })
      : Object.freeze({ connectedServicesV2: [] }),
    readAgentSettings: () => getActiveAccountSettingsSnapshot()?.settings,
    ...(params.activeServerId ? { activeServerId: params.activeServerId } : {}),
    readAccountRevision: () => resolveActiveAccountConfiguredExternalSessionSourceRevision(
      getActiveAccountSettingsSnapshot(),
    ),
    subscribeAccountRevision: (listener) => subscribeActiveAccountSettingsSnapshot(
      (_previous, next) => listener(resolveActiveAccountConfiguredExternalSessionSourceRevision(next)),
    ),
    isCurrent: params.isCurrent,
    resolveProviderOps: async (agentId) =>
      readProviderOps(params.resolveAgentRuntime(agentId)),
    resolveAgentRuntimeGeneration: (agentId) =>
      params.resolveAgentRuntime(agentId)?.immutableGenerationId ?? null,
    attach: async (ref, source, options) => await ensureLink({
      ref,
      source,
      ...(options?.signal ? { signal: options.signal } : {}),
    }),
    ...(params.externalSessionHostOperationOwner
      ? {
          followTranscript: async ({ ref, source, options, listener }) => {
            const runtime = params.resolveAgentRuntime(ref.agentId);
            const agent = params.agents.find((candidate) => candidate.id === ref.agentId);
            if (!runtime || !agent?.identity) {
              return Object.freeze({
                status: 'unavailable' as const,
                code: 'plugin_external_source_unavailable',
              });
            }
            const linked = await ensureLink({
              ref,
              source,
              ...(options.signal ? { signal: options.signal } : {}),
            });
            const port = params.externalSessionHostOperationOwner!.bind({
              pluginId: agent.identity.pluginId,
              agentId: ref.agentId,
              generationId: runtime.generationId,
              sessionId: linked.sessionId,
              machineId: requireMachineId(params),
              readAccountRevision: () =>
                resolveActiveAccountConfiguredExternalSessionSourceRevision(
                  getActiveAccountSettingsSnapshot(),
                ),
              generationRetirementSignal: runtime.retirementSignal,
              isGenerationCurrent: () => params.isCurrent() && runtime.isCurrent(),
              agentContribution: agent,
            });
            const result = await port.executeFollow({
              ref,
              source,
              options,
              listener,
            });
            if (result.status === 'unavailable') {
              await port.retire();
              return result;
            }
            let cleanup: Promise<void> | null = null;
            return Object.freeze({
              ...result,
              subscription: Object.freeze({
                async dispose() {
                  if (cleanup) return await cleanup;
                  const attempt = (async () => {
                    const physicalOutcomes = await Promise.allSettled([
                      result.subscription.dispose(),
                    ]);
                    const retirementOutcomes = await Promise.allSettled([
                      port.retire(),
                    ]);
                    const failures = [
                      ...physicalOutcomes,
                      ...retirementOutcomes,
                    ].flatMap((outcome) =>
                      outcome.status === 'rejected' ? [outcome.reason] : []
                    );
                    if (failures.length === 1) throw failures[0];
                    if (failures.length > 1) {
                      throw new AggregateError(
                        failures,
                        'External Sessions follow cleanup failed',
                      );
                    }
                  })();
                  cleanup = attempt;
                  try {
                    await attempt;
                  } catch (error) {
                    if (cleanup === attempt) cleanup = null;
                    throw error;
                  }
                },
              }),
            });
          },
          // Read live from the owner. The presence of `followTranscript` above only
          // proves the owner object exists; it does not prove a generation was ever
          // installed into it, which is what follow actually requires.
          canFollowNow: () =>
            params.externalSessionHostOperationOwner!.canFollowNow(),
        }
      : {}),
    ...(params.onSourceRefusalsChanged
      ? { onSourceRefusalsChanged: params.onSourceRefusalsChanged }
      : {}),
  });
  const owner = lifecycle;
  return Object.freeze<CurrentGlobalExternalSessionsAuthorService>({
    ...owner,
    // The owner republishes its refusals on every Account-revision rebuild, so
    // this must stay a live read; the spread above would freeze the first build.
    get sourceRefusals() {
      return owner.sourceRefusals;
    },
    takeoverSourceOps,
    admitPersistedTakeoverSource(
      input: Parameters<CurrentGlobalExternalSessionsAuthorService['admitPersistedTakeoverSource']>[0],
    ) {
      const machineId = params.resolveMachineId()?.trim() ?? '';
      if (!machineId || input.machineId !== machineId) return null;
      return owner.admitPersistedTakeoverSource(input);
    },
    bindCallerAuthorService({ contextualTakeover }) {
      return owner.bindAuthorService(
        contextualTakeover,
        () => (params.resolveMachineId()?.trim() ?? '').length > 0,
      );
    },
  });
}
