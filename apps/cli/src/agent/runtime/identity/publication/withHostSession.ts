import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { NormalizedRuntimeEventPublication } from '@/agent/runtime/events/createNormalizedRuntimeEventWriter';
import { createNormalizedRuntimeEventPublicationHub } from '@/agent/runtime/events/createNormalizedRuntimeEventPublicationHub';
import { resolveHostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import type { RuntimeEventV1 } from '@happier-dev/protocol';

function isRuntimeEvent(message: unknown): message is RuntimeEventV1 {
  return Boolean(message)
    && typeof message === 'object'
    && typeof (message as Readonly<Record<string, unknown>>).kind === 'string';
}

function wrapRuntimeTurnOperationsWithPublication(params: Readonly<{
  runtime: RuntimeTurnOperations;
  identity: NormalizedRuntimeEventPublication;
}>): RuntimeTurnOperations {
  const hub = createNormalizedRuntimeEventPublicationHub<RuntimeEventV1>({
    identity: params.identity,
    subscribeUpstream: (handler) => params.runtime.subscribeRuntimeEvents((message) => {
      if (isRuntimeEvent(message)) {
        handler(message);
      }
    }),
  });

  return Object.freeze({
    beginTurnLifecycle() {
      params.runtime.beginTurnLifecycle();
    },
    async startOrLoadSession(opts) {
      await params.runtime.startOrLoadSession(opts);
      hub.publishFallbackIdentity();
    },
    async sendTurnPrompt(prompt) {
      await params.runtime.sendTurnPrompt(prompt);
    },
    ...(typeof params.runtime.compactContext === 'function'
      ? {
          async compactContext(command: string) {
            await params.runtime.compactContext!(command);
          },
        }
      : {}),
    async steerInFlightTurn(message) {
      await params.runtime.steerInFlightTurn(message);
    },
    async waitForTurnCompletion(opts) {
      await params.runtime.waitForTurnCompletion(opts);
    },
    subscribeRuntimeEvents(handler) {
      return hub.subscribe(handler);
    },
    async respondToPermission(requestId, approved) {
      await params.runtime.respondToPermission(requestId, approved);
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
    async resetOrDisposeRuntime() {
      hub.dispose();
      await params.runtime.resetOrDisposeRuntime();
    },
  });
}

export function withHostSessionRuntimeIdentityPublication(params: Readonly<{
  plan: HostSessionRuntimePlan;
  identity: NormalizedRuntimeEventPublication;
}>): HostSessionRuntimePlan {
  const createSessionRuntime = params.plan.config.createSessionRuntime;
  if (typeof createSessionRuntime !== 'function') {
    return params.plan;
  }

  return {
    ...params.plan,
    config: {
      ...params.plan.config,
      async createSessionRuntime(runtimeParams) {
        const createdRuntime = await createSessionRuntime(runtimeParams);
        const { runtime, nativeRuntime } = resolveHostSessionRuntimeFactoryResult(createdRuntime);
        return {
          operations: wrapRuntimeTurnOperationsWithPublication({
            runtime,
            identity: params.identity,
          }),
          nativeRuntime,
        };
      },
    },
  };
}
