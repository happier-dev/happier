import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type {
  RuntimeTurnMessage,
  RuntimeTurnOperations,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import type { NormalizedRuntimeEventPublication } from '@/agent/runtime/events/createNormalizedRuntimeEventWriter';
import { createNormalizedRuntimeEventPublicationHub } from '@/agent/runtime/events/createNormalizedRuntimeEventPublicationHub';
import { resolveHostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { readRuntimeDescriptorV1, type RuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { Metadata } from '@/api/types';

function resolveOpenedRuntimeDescriptorV1(params: Readonly<{
  agentId: string;
  descriptor: unknown;
}>): RuntimeDescriptorV1 | null {
  const descriptor = readRuntimeDescriptorV1(params.descriptor);
  return descriptor?.agentId === params.agentId ? descriptor : null;
}

function mergeRuntimeCapabilities(hostCapabilities: unknown, agentCapabilities: unknown): unknown {
  if (
    hostCapabilities
    && typeof hostCapabilities === 'object'
    && !Array.isArray(hostCapabilities)
    && agentCapabilities
    && typeof agentCapabilities === 'object'
    && !Array.isArray(agentCapabilities)
  ) {
    return {
      ...hostCapabilities,
      ...agentCapabilities,
    };
  }
  return agentCapabilities;
}

function wrapRuntimeTurnOperationsWithPublication(params: Readonly<{
  runtime: RuntimeTurnOperations;
  identity: NormalizedRuntimeEventPublication;
}>): RuntimeTurnOperations {
  const readRespondToPermission = () => params.runtime.permissionCapability === 'responds'
    ? params.runtime.respondToPermission
    : undefined;
  const hub = createNormalizedRuntimeEventPublicationHub<RuntimeTurnMessage>({
    // `runtimeDescriptor.agent` is Agent-owned and opaque. Native Session
    // identity has its own `identity.providerSessionId` publication path; a
    // generic host wrapper must never synthesize fields inside the descriptor.
    identity: params.identity,
    subscribeUpstream: (handler) => params.runtime.subscribeRuntimeEvents(handler),
  });

  return Object.freeze({
    get permissionCapability() {
      return params.runtime.permissionCapability;
    },
    beginTurnLifecycle() {
      params.runtime.beginTurnLifecycle();
    },
    async sendTurnPrompt(prompt, meta) {
      await params.runtime.sendTurnPrompt(prompt, meta);
      hub.publishFallbackIdentity();
    },
    ...(typeof params.runtime.compactContext === 'function'
      ? {
          async compactContext(command: string) {
            await params.runtime.compactContext!(command);
          },
        }
      : {}),
    async steerInFlightTurn(message, meta) {
      await params.runtime.steerInFlightTurn(message, meta);
    },
    async waitForTurnCompletion(opts) {
      await params.runtime.waitForTurnCompletion(opts);
    },
    subscribeRuntimeEvents(handler) {
      const unsubscribe = hub.subscribe(handler);
      hub.publishFallbackIdentity();
      return unsubscribe;
    },
    get respondToPermission() {
      const respondToPermission = readRespondToPermission();
      return respondToPermission
        ? async (requestId: string, approved: boolean) => await respondToPermission(requestId, approved)
        : undefined;
    },
    async cancelTurn() {
      await params.runtime.cancelTurn();
    },
    readSessionIdentity() {
      return params.runtime.readSessionIdentity();
    },
    async updateSessionRuntimeConfig(update) {
      await params.runtime.updateSessionRuntimeConfig(update);
    },
    async resetOrDisposeRuntime(reason, nextSessionOpenIntent) {
      if (!nextSessionOpenIntent) {
        hub.dispose();
      }
      await params.runtime.resetOrDisposeRuntime(reason, nextSessionOpenIntent);
    },
  });
}

export function withHostSessionRuntimeIdentityPublication(params: Readonly<{
  plan: HostSessionRuntimePlan;
  identity: NormalizedRuntimeEventPublication;
}>): HostSessionRuntimePlan {
  const augmentSessionMetadata = params.plan.config.augmentSessionMetadata;
  const configWithInitialRuntimeIdentity = params.identity.runtimeDescriptor
    ? {
        ...params.plan.config,
        augmentSessionMetadata(metadata: Metadata): Metadata {
          const augmented = augmentSessionMetadata ? augmentSessionMetadata(metadata) : metadata;
          return applyRuntimeDescriptorSessionMetadata(
            augmented,
            params.identity.runtimeDescriptor,
          ) as Metadata;
        },
      }
    : params.plan.config;
  const createSessionRuntime = params.plan.config.createSessionRuntime;
  if (typeof createSessionRuntime !== 'function') {
    return {
      ...params.plan,
      config: configWithInitialRuntimeIdentity,
    };
  }

  return {
    ...params.plan,
    config: {
      ...configWithInitialRuntimeIdentity,
      async createSessionRuntime(runtimeParams) {
        const createdRuntime = await createSessionRuntime(runtimeParams);
        const {
          runtime,
          nativeRuntime,
          terminalRemoteModeLoop,
          configuration,
          runtimeDescriptorV1,
          runtimeCapabilities,
          admittedProviderBindingHandoff,
        } = resolveHostSessionRuntimeFactoryResult(createdRuntime);
        const openedRuntimeDescriptor = resolveOpenedRuntimeDescriptorV1({
          agentId: params.plan.agentId,
          descriptor: runtimeDescriptorV1,
        });
        const identity = {
          ...params.identity,
          ...(openedRuntimeDescriptor
            ? { runtimeDescriptor: openedRuntimeDescriptor }
            : {}),
          ...(runtimeCapabilities
            ? {
                runtimeCapabilities: mergeRuntimeCapabilities(
                  params.identity.runtimeCapabilities,
                  runtimeCapabilities,
                ),
              }
            : {}),
        };
        if (openedRuntimeDescriptor) {
          await runtimeParams.session.updateMetadata((metadata) => (
            applyRuntimeDescriptorSessionMetadata(
              metadata,
              openedRuntimeDescriptor,
            ) as Metadata
          ));
        }
        return {
          operations: wrapRuntimeTurnOperationsWithPublication({
            runtime,
            identity,
          }),
          nativeRuntime,
          terminalRemoteModeLoop,
          ...(configuration ? { configuration } : {}),
          ...(admittedProviderBindingHandoff
            ? { admittedProviderBindingHandoff }
            : {}),
        };
      },
    },
  };
}
