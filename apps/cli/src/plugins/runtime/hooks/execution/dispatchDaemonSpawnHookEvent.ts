import {
  getPluginHookDefinitionV1,
  buildBackendTargetKeyV2,
  type DaemonSpawnHookEventIdV1,
  type HookEventEnvelopeV1,
} from '@happier-dev/protocol';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

import {
  dispatchPluginHookEvent,
  type DispatchPluginHookEventResultV1,
} from './dispatchPluginHookEvent';

type DispatchDaemonSpawnHookEventDeps = Readonly<{
  resolveRuntimeRegistry?: (params: Readonly<{ happyHomeDir: string }>) => Promise<ResolvedExecutablePluginRuntimeRegistry>;
  dispatchEvent?: (params: Readonly<{
    runtimeRegistry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'hookHandlersByHookId' | 'readHookEventEnvelopeV1'>;
    event: HookEventEnvelopeV1;
    context?: unknown;
  }>) => Promise<DispatchPluginHookEventResultV1>;
  nowMs?: () => number;
}>;

export type DaemonSpawnHookDispatchEvent = Readonly<{
  eventId: DaemonSpawnHookEventIdV1;
  backendId?: string;
  backendTarget?: BackendTargetRefV2;
  machineId?: string;
  workspaceId?: string;
  cwd?: string;
  timestampMs?: number;
  payload: Record<string, unknown>;
  context?: unknown;
}>;

function resolveDaemonSpawnHookCategory(eventId: DaemonSpawnHookEventIdV1): HookEventEnvelopeV1['category'] {
  if (eventId === 'spawn.augmentEnv') {
    return 'augmentation';
  }
  return 'decision';
}

function resolveDaemonSpawnHookScope(eventId: DaemonSpawnHookEventIdV1): HookEventEnvelopeV1['scope'] {
  return getPluginHookDefinitionV1(eventId)?.scope ?? 'daemon';
}

export async function dispatchDaemonSpawnHookEvent(
  params: Readonly<{
    happyHomeDir: string;
    event: DaemonSpawnHookDispatchEvent;
  }>,
  deps: DispatchDaemonSpawnHookEventDeps = {},
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
      category: resolveDaemonSpawnHookCategory(params.event.eventId),
      scope: resolveDaemonSpawnHookScope(params.event.eventId),
      ...(params.event.backendId ? { backendId: params.event.backendId } : {}),
      ...(params.event.backendTarget ? { backendTarget: buildBackendTargetKeyV2(params.event.backendTarget) } : {}),
      ...(params.event.machineId ? { machineId: params.event.machineId } : {}),
      ...(params.event.workspaceId ? { workspaceId: params.event.workspaceId } : {}),
      ...(params.event.cwd ? { cwd: params.event.cwd } : {}),
      timestampMs: typeof params.event.timestampMs === 'number' ? params.event.timestampMs : nowMs(),
      payload: params.event.payload,
    };

    return await dispatchEvent({
      runtimeRegistry: lease.registry,
      event,
      ...(params.event.context === undefined ? {} : { context: params.event.context }),
    });
  } finally {
    await lease.release();
  }
}
