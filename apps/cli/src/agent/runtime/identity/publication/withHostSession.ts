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

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRuntimeSessionId(runtime: RuntimeTurnOperations): string | null {
  try {
    return normalizeNonEmptyString(runtime.readSessionIdentity().sessionId);
  } catch {
    return null;
  }
}

function withRuntimeProviderSessionId(
  descriptor: RuntimeDescriptorV1 | null,
  providerSessionId: string | null,
): RuntimeDescriptorV1 | null {
  if (!descriptor || !providerSessionId) return descriptor;
  if (normalizeNonEmptyString(descriptor.agent.providerSessionId) === providerSessionId) {
    return descriptor;
  }
  return {
    ...descriptor,
    agent: {
      ...descriptor.agent,
      providerSessionId,
    },
  };
}

function resolveRuntimeIdentityPublication(params: Readonly<{
  runtime: RuntimeTurnOperations;
  identity: NormalizedRuntimeEventPublication;
}>): NormalizedRuntimeEventPublication {
  return {
    ...params.identity,
    runtimeDescriptor: withRuntimeProviderSessionId(
      params.identity.runtimeDescriptor,
      readRuntimeSessionId(params.runtime),
    ),
  };
}

function resolveOpenedRuntimeDescriptorV1(params: Readonly<{
  agentId: string;
  descriptor: unknown;
}>): RuntimeDescriptorV1 | null {
  const descriptor = readRuntimeDescriptorV1(params.descriptor);
  return descriptor?.agentId === params.agentId ? descriptor : null;
}

function wrapRuntimeTurnOperationsWithPublication(params: Readonly<{
  runtime: RuntimeTurnOperations;
  identity: NormalizedRuntimeEventPublication;
}>): RuntimeTurnOperations {
  const readRespondToPermission = () => params.runtime.permissionCapability === 'responds'
    ? params.runtime.respondToPermission
    : undefined;
  const hub = createNormalizedRuntimeEventPublicationHub<RuntimeTurnMessage>({
    identity: () => resolveRuntimeIdentityPublication({
      runtime: params.runtime,
      identity: params.identity,
    }),
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
          admittedProviderBindingHandoff,
        } = resolveHostSessionRuntimeFactoryResult(createdRuntime);
        const openedRuntimeDescriptor = resolveOpenedRuntimeDescriptorV1({
          agentId: params.plan.agentId,
          descriptor: runtimeDescriptorV1,
        });
        const identity = openedRuntimeDescriptor
          ? { ...params.identity, runtimeDescriptor: openedRuntimeDescriptor }
          : params.identity;
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
