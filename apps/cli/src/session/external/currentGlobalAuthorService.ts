import {
  ExternalSessionsAgentIdSchema,
  ExternalSessionTakeoverTargetDirectoryV1Schema,
  readLinkedExternalSessionV1FromMetadata,
  type ExternalSessionsSource,
} from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import { fetchAccountProfile } from '@/api/accountProfile';
import { ensureExternalSessionLink } from '@/api/session/external/linking/ensureExternalSessionLink';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { StoredCredentials } from '@/persistence';
import { createExternalSessionSourceKeyOwnerFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import {
  getActiveAccountSettingsSnapshot,
  resolveActiveAccountSettingsSnapshotRevision,
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
import { createContextualExternalSessionTakeoverAdapter } from './contextualTakeoverAdmission';
import {
  createExternalSessionsUnavailableCapabilities,
  type HostExternalSessionsAuthorService,
} from './privateContract';
import type { ExternalSessionHostOperationOwner } from './hostOperationOwner';
import type { ExternalSessionExecutionSurface } from './providerOps';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from './agentExternalSessionsInvocation';

type CurrentAgentRuntime = Readonly<{
  generationId: string;
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
  externalSessionHostOperationOwner?: ExternalSessionHostOperationOwner;
  isCurrent(): boolean;
}>;

export type CurrentGlobalExternalSessionsAuthorService =
  LiveConfiguredPluginExternalSessionsAdapter & Readonly<{
    bindCallerAuthorService(input: Readonly<{
      pluginId: string;
      takeoverStart?: ExternalSessionPluginTakeoverStart;
    }>): HostExternalSessionsAuthorService;
  }>;

export function createCurrentGlobalExternalSessionsAuthorBinding(params: Readonly<{
  pluginId: string;
  signal: AbortSignal;
  isGenerationCurrent(): boolean;
  takeoverStart?: ExternalSessionPluginTakeoverStart;
  resolveCurrent(): CurrentGlobalExternalSessionsAuthorService | null;
  activateConfiguredSources(agentId?: string): Promise<void>;
}>): HostExternalSessionsAuthorService {
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
        ...(params.takeoverStart ? { takeoverStart: params.takeoverStart } : {}),
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
  const requireCurrent = async (
    agentId: string | undefined,
    operationSignal: AbortSignal | undefined,
    deadlineSignal: AbortSignal,
  ): Promise<HostExternalSessionsAuthorService> => {
    assertInvocationCurrent(operationSignal, deadlineSignal);
    await params.activateConfiguredSources(agentId);
    assertInvocationCurrent(operationSignal, deadlineSignal);
    return readCurrent() ?? (() => {
      throw failure('plugin_external_sources_unavailable');
    })();
  };
  const unavailable = (code: string) => Object.freeze({
    status: 'unavailable' as const,
    code,
  });
  const invoke = async <T>(input: Readonly<{
    agentId?: string;
    operationSignal?: AbortSignal;
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
      assertInvocationCurrent(input.operationSignal, deadline.signal);
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
          const service = await requireCurrent(
            input.agentId,
            input.operationSignal,
            deadline.signal,
          );
          const result = await input.operation(service, invocationSignal);
          assertInvocationCurrent(input.operationSignal, deadline.signal);
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
          ...(parsedOptions?.signal ? { operationSignal: parsedOptions.signal } : {}),
          operation: async (service, signal) => await service.capabilities({ signal }),
        });
      } catch (error) {
        if (
          isPluginError(error)
          && (
            error.code === 'plugin_external_sources_unavailable'
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
        ...(parsedOptions?.signal ? { operationSignal: parsedOptions.signal } : {}),
        operation: async (service, signal) => await service.list(query, { signal }),
      });
    },
    async attach(ref, options) {
      const parsedOptions = readAuthorCancellationOptions(options);
      return await invoke({
        agentId: ref.agentId,
        ...(parsedOptions?.signal ? { operationSignal: parsedOptions.signal } : {}),
        operation: async (service, signal) => await service.attach(ref, { signal }),
      });
    },
    async readTranscript(ref, query, options) {
      const parsedOptions = readAuthorCancellationOptions(options);
      return await invoke({
        agentId: ref.agentId,
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
        ...(parsedOptions?.signal ? { operationSignal: parsedOptions.signal } : {}),
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

  const createContextualTakeover = (
    pluginId: string,
    takeoverStart: ExternalSessionPluginTakeoverStart | undefined,
  ) => params.activeServerDir && takeoverStart
    ? createContextualExternalSessionTakeoverAdapter({
        activeServerDir: params.activeServerDir,
        pluginId,
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
          const linked = readLinkedExternalSessionV1FromMetadata(
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
        startDurableTakeover: takeoverStart,
      })
    : undefined;

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
    readAccountRevision: () => resolveActiveAccountSettingsSnapshotRevision(
      getActiveAccountSettingsSnapshot(),
    ),
    subscribeAccountRevision: (listener) => subscribeActiveAccountSettingsSnapshot(
      (_previous, next) => listener(resolveActiveAccountSettingsSnapshotRevision(next)),
    ),
    isCurrent: params.isCurrent,
    resolveProviderOps: async (agentId) =>
      readProviderOps(params.resolveAgentRuntime(agentId)),
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
                resolveActiveAccountSettingsSnapshotRevision(
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
            return Object.freeze({
              ...result,
              subscription: Object.freeze({
                async dispose() {
                  await Promise.allSettled([
                    result.subscription.dispose(),
                  ]);
                  await Promise.allSettled([
                    port.retire(),
                  ]);
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
  });
  const owner = lifecycle;
  return Object.freeze<CurrentGlobalExternalSessionsAuthorService>({
    ...owner,
    // The owner republishes its refusals on every Account-revision rebuild, so
    // this must stay a live read; the spread above would freeze the first build.
    get sourceRefusals() {
      return owner.sourceRefusals;
    },
    bindCallerAuthorService({ pluginId, takeoverStart }) {
      return owner.bindAuthorService(
        createContextualTakeover(pluginId, takeoverStart),
        () => (params.resolveMachineId()?.trim() ?? '').length > 0,
      );
    },
  });
}
