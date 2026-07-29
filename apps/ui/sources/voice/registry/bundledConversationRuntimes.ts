import type { VoiceAdapterController } from '@/voice/session/types';
import type {
  BundledVoiceRuntimeContribution,
} from '@happier-dev/bundled-voice-runtime-contract';
import type {
  PluginVoiceAccountOperationService,
} from '@happier-dev/plugin-sdk/runtime';

import {
  createAccountVoiceOperationService,
} from '@/voice/credentials/accountVoiceOperationService';
import {
  createDaemonActionVoiceOperationService,
} from '@/voice/credentials/daemonActionVoiceOperationService';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';

import {
  createBundledHostedConversationService,
  getCurrentBundledConversationRuntimeHost,
  type BundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';
import {
  createExternalVoiceProviderActivationScope,
} from './externalVoiceProviderActivation';
import {
  getExternalVoiceProviderRegistration,
} from './externalVoiceProviderRegistrations';
import type { BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';

export type { BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';

export class BundledConversationRuntimeCompositionError extends Error {
  readonly cleanup: Promise<void>;
  override readonly cause: unknown;

  constructor(cause: unknown, cleanup: Promise<void>) {
    super('bundled_conversation_runtime_composition_failed');
    this.name = 'BundledConversationRuntimeCompositionError';
    this.cause = cause;
    this.cleanup = cleanup;
  }
}

export function isBundledHostedConversationEntryAuthorized(
  entry: BundledConversationRuntimeEntry,
  authorizedEntries: readonly BundledConversationRuntimeEntry[],
): boolean {
  return authorizedEntries.includes(entry);
}

export type BundledVoiceAccountOperationRoute =
  | Readonly<{ kind: 'savedSecret' }>
  | Readonly<{ kind: 'daemonAction'; actionLocalId: string }>;

function routeKey(route: BundledVoiceAccountOperationRoute): string {
  return route.kind === 'savedSecret'
    ? 'savedSecret'
    : `daemonAction:${route.actionLocalId}`;
}

function accountOperationCancelled(): Error {
  return Object.assign(new Error('voice_account_operation_cancelled'), {
    code: 'voice_account_operation_cancelled',
  });
}

async function runBundledVoiceAccountOperationWithRouteFence<T>(
  input: Readonly<{
    isCurrent(): boolean;
    readRoute(): BundledVoiceAccountOperationRoute;
    run(
      route: BundledVoiceAccountOperationRoute,
    ): Promise<T>;
  }>,
): Promise<T> {
  const route = input.readRoute();
  if (!input.isCurrent()) throw accountOperationCancelled();
  const expectedRouteKey = routeKey(route);
  let response: T;
  try {
    response = await input.run(route);
  } catch (error) {
    if (!input.isCurrent()) throw accountOperationCancelled();
    let currentRoute: BundledVoiceAccountOperationRoute;
    try {
      currentRoute = input.readRoute();
    } catch {
      throw accountOperationCancelled();
    }
    if (routeKey(currentRoute) !== expectedRouteKey) {
      throw accountOperationCancelled();
    }
    throw error;
  }
  if (!input.isCurrent()) throw accountOperationCancelled();
  let currentRoute: BundledVoiceAccountOperationRoute;
  try {
    currentRoute = input.readRoute();
  } catch {
    throw accountOperationCancelled();
  }
  if (routeKey(currentRoute) !== expectedRouteKey) {
    throw accountOperationCancelled();
  }
  return response;
}

export async function requestBundledVoiceAccountOperationWithRouteFence(
  input: Readonly<{
    isCurrent(): boolean;
    readRoute(): BundledVoiceAccountOperationRoute;
    request(
      route: BundledVoiceAccountOperationRoute,
    ): ReturnType<PluginVoiceAccountOperationService['request']>;
  }>,
): ReturnType<PluginVoiceAccountOperationService['request']> {
  return await runBundledVoiceAccountOperationWithRouteFence({
    isCurrent: input.isCurrent,
    readRoute: input.readRoute,
    run: input.request,
  });
}

function isAdapter(value: VoiceAdapterController | null, providerId: string): value is VoiceAdapterController {
  return value !== null
    && value.id === providerId
    && value.engineKind === 'realtime'
    && typeof value.start === 'function'
    && typeof value.stop === 'function';
}

/** Compose generated first-party modules through the installed/public activation owner. */
export function createBundledConversationRuntimes(input: Readonly<{
  bundledEntries: readonly BundledConversationRuntimeEntry[];
  hostedConversationEntries?: readonly BundledConversationRuntimeEntry[];
  host: BundledConversationRuntimeHost;
}>): readonly BundledVoiceRuntimeContribution[] {
  const runtimes: BundledVoiceRuntimeContribution[] = [];
  const seen = new Set<string>();
  try {
    for (const entry of input.bundledEntries) {
      const { uiEntry } = entry;
      if (seen.has(uiEntry.providerId)) {
        throw new Error(`duplicate_bundled_conversation_runtime:${uiEntry.providerId}`);
      }
      if (getCurrentBundledConversationRuntimeHost() !== input.host) {
        throw new Error('voice_runtime_host_unavailable');
      }
      const recipientContract = createBundledVoiceRecipientContract({
        pluginId: uiEntry.pluginId,
        declaration: uiEntry.declaration,
      });
      const createInvocationAccountOperations = recipientContract
        ? (
            signal: AbortSignal,
            conversationSessionId: string | null,
            isCurrent: () => boolean,
          ) => {
            const savedSecret = createAccountVoiceOperationService({
              providerId: uiEntry.providerId,
              recipientContract,
              signal,
              isCurrent,
            });
            const readRoute = (): BundledVoiceAccountOperationRoute => {
              const projection = input.host.projectVoiceSettings(
                input.host.getSettings(),
                uiEntry.providerId,
              );
              return uiEntry.internal.resolveAccountOperationTarget?.(
                projection?.providerConfig,
              ) ?? Object.freeze({ kind: 'savedSecret' as const });
            };
            const createDaemonAction = (
              route: Extract<
                BundledVoiceAccountOperationRoute,
                Readonly<{ kind: 'daemonAction' }>
              >,
            ) => createDaemonActionVoiceOperationService({
              pluginId: uiEntry.pluginId,
              actionLocalId: route.actionLocalId,
              conversationSessionId,
              signal,
              isCurrent,
            });
            return Object.freeze({
              async inspectAvailability() {
                await runBundledVoiceAccountOperationWithRouteFence({
                  isCurrent,
                  readRoute,
                  async run(route) {
                    if (route.kind === 'savedSecret') {
                      await savedSecret.inspectAvailability();
                      return;
                    }
                    await createDaemonAction(route).inspectAvailability();
                  },
                });
              },
              async request(
                request: Parameters<PluginVoiceAccountOperationService['request']>[0],
              ) {
                return await requestBundledVoiceAccountOperationWithRouteFence({
                  isCurrent,
                  readRoute,
                  async request(route) {
                    if (route.kind === 'savedSecret') return await savedSecret.request(request);
                    if (!conversationSessionId) {
                      throw new Error('voice_account_operation_session_required');
                    }
                    return await createDaemonAction(route).request(request);
                  },
                });
              },
            });
          }
        : null;
      const scope = createExternalVoiceProviderActivationScope({
        pluginId: uiEntry.pluginId,
        declarations: [uiEntry.declaration],
        hostPlatform: input.host.getPlatform(),
        hostBindingsByLocalId: Object.freeze({
          [uiEntry.declaration.id]: Object.freeze({
            providerId: uiEntry.providerId,
            recipientContract,
            descriptor: 'bundled' as const,
            ...(uiEntry.internal.resolveSurfaceCapabilities
              ? {
                  resolveSurfaceCapabilities: (settings: unknown) => {
                    const projection = input.host.projectVoiceSettings(settings, uiEntry.providerId);
                    return projection?.providerId === uiEntry.providerId
                      ? uiEntry.internal.resolveSurfaceCapabilities!(projection.providerConfig)
                      : null;
                  },
                }
              : {}),
            ...(createInvocationAccountOperations
              ? {
                  createInvocationAccountOperations,
                }
              : {}),
            ...(createInvocationAccountOperations
              && uiEntry.internal.resolveAccountOperationTarget
              ? {
                  async inspectInvocationAccountOperations(
                    signal: AbortSignal,
                    isCurrent: () => boolean,
                  ) {
                    await createInvocationAccountOperations(
                      signal,
                      null,
                      isCurrent,
                    ).inspectAvailability();
                  },
                }
              : {}),
            ...(input.hostedConversationEntries
              && isBundledHostedConversationEntryAuthorized(
                entry,
                input.hostedConversationEntries,
              )
              ? {
                  createInvocationHostedConversation(
                    signal: AbortSignal,
                    isCurrent: () => boolean,
                  ) {
                    return createBundledHostedConversationService({ signal, isCurrent });
                  },
                }
              : {}),
          }),
        }),
      });
      entry.activate(scope.api as Parameters<typeof entry.activate>[0]);
      const commit = scope.commit();
      if (commit) {
        void commit.catch(() => undefined);
      }
      const registration = getExternalVoiceProviderRegistration(uiEntry.providerId);
      if (!registration || !isAdapter(registration.adapter, uiEntry.providerId)) {
        throw new Error(`invalid_bundled_conversation_runtime:${uiEntry.providerId}`);
      }
      seen.add(uiEntry.providerId);
      runtimes.push(Object.freeze({
        adapter: registration.adapter,
        async dispose() {
          await scope.unwind();
        },
      }));
    }
    return Object.freeze(runtimes);
  } catch (error) {
    const cleanup = Promise.allSettled(runtimes.map(async (runtime) => await runtime.dispose()))
      .then(() => undefined);
    throw new BundledConversationRuntimeCompositionError(error, cleanup);
  }
}
