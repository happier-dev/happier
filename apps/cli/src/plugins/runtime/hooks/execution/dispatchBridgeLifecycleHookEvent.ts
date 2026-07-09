import type {
  BridgeLifecycleHookEventIdV1,
  HookEventEnvelopeV1,
  HookScopeV1,
} from '@happier-dev/protocol';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

import {
  dispatchPluginHookEvent,
  type DispatchPluginHookEventResultV1,
} from './dispatchPluginHookEvent';

type DispatchBridgeLifecycleHookEventDeps = Readonly<{
  resolveRuntimeRegistry?: (params: Readonly<{ happyHomeDir: string }>) => Promise<ResolvedExecutablePluginRuntimeRegistry>;
  dispatchEvent?: (params: Readonly<{
    runtimeRegistry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'hookHandlersByHookId' | 'readHookEventEnvelopeV1'>;
    event: HookEventEnvelopeV1;
  }>) => Promise<DispatchPluginHookEventResultV1>;
  nowMs?: () => number;
}>;

export type BridgeLifecycleHookDispatchEvent = Readonly<{
  eventId: BridgeLifecycleHookEventIdV1;
  scope?: HookScopeV1;
  happySessionId?: string;
  providerSessionId?: string;
  agentId?: string;
  providerId?: string;
  backendId?: string;
  backendTarget?: string;
  machineId?: string;
  workspaceId?: string;
  cwd?: string;
  turnId?: string;
  toolCallId?: string;
  timestampMs?: number;
  payload: Record<string, unknown>;
}>;

export async function dispatchBridgeLifecycleHookEvent(
  params: Readonly<{
    happyHomeDir: string;
    event: BridgeLifecycleHookDispatchEvent;
  }>,
  deps: DispatchBridgeLifecycleHookEventDeps = {},
): Promise<DispatchPluginHookEventResultV1> {
  const resolveRuntimeRegistry = deps.resolveRuntimeRegistry
    ?? (async ({ happyHomeDir }: Readonly<{ happyHomeDir: string }>) => {
      const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
      return await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
    });
  const dispatchEvent = deps.dispatchEvent ?? dispatchPluginHookEvent;
  const nowMs = deps.nowMs ?? (() => Date.now());

  const lease = deps.resolveRuntimeRegistry
    ? await (async () => {
      const registry = await resolveRuntimeRegistry({ happyHomeDir: params.happyHomeDir });
      return {
        registry,
        release: async () => {
          await registry.dispose();
        },
      };
    })()
    : await acquireAuthoritativePluginRuntimeRegistryLease({
      happyHomeDir: params.happyHomeDir,
      resolveRuntimeRegistry: async () => await resolveRuntimeRegistry({ happyHomeDir: params.happyHomeDir }),
    });
  try {
    const event: HookEventEnvelopeV1 = {
      hookVersion: 1,
      eventId: params.event.eventId,
      category: 'lifecycle',
      scope: params.event.scope ?? 'session',
      ...(params.event.happySessionId ? { happySessionId: params.event.happySessionId } : {}),
      ...(params.event.providerSessionId ? { providerSessionId: params.event.providerSessionId } : {}),
      ...(params.event.agentId ? { agentId: params.event.agentId } : {}),
      ...(params.event.backendTarget ? { backendTarget: params.event.backendTarget } : {}),
      ...(params.event.machineId ? { machineId: params.event.machineId } : {}),
      ...(params.event.workspaceId ? { workspaceId: params.event.workspaceId } : {}),
      ...(params.event.cwd ? { cwd: params.event.cwd } : {}),
      ...(params.event.turnId ? { turnId: params.event.turnId } : {}),
      ...(params.event.toolCallId ? { toolCallId: params.event.toolCallId } : {}),
      timestampMs: typeof params.event.timestampMs === 'number' ? params.event.timestampMs : nowMs(),
      payload: params.event.payload,
    };

    return await dispatchEvent({
      runtimeRegistry: lease.registry,
      event,
    });
  } finally {
    await lease.release();
  }
}
