import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import type {
  PeerTcpTunnelVoiceBinaryAppendConsumer, PeerTcpTunnelVoiceBinaryTerminalConsumer,
} from '@/daemon/peer/mediation/tunnel/voiceBinaryAppend';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { MachineMetadataFieldReadV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { logger } from '@/ui/logger';
import { resolveActiveMachineRolesV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';

import { MACHINE_ROLE_RPC_NAMESPACES, SPLIT_MACHINE_ROLE_IDS, type SplitMachineRoleId } from './machineRoleRpcNamespaces';
import type { MachineRolesRuntime } from './machineRolesRuntime';
import type { MemoryRoleActivation, MemoryRoleContext } from './memory/entry';
import type { BrokerRoleActivation, BrokerRoleContext } from './broker/entry';
import type { DevicesRoleActivation, DevicesRoleContext } from './devices/entry';
import type { SessionsRoleActivation, SessionsRoleContext } from './sessions/entry';
import type { MachineRoleRpcRegistrar, MachineRoleStopReason } from './types';
import type { VoiceRoleActivation, VoiceRoleContext } from './voice/entry';

type MachineRoleActivations = {
  memory: MemoryRoleActivation; voice: VoiceRoleActivation; devices: DevicesRoleActivation; broker: BrokerRoleActivation;
  sessions: SessionsRoleActivation;
};
/** Each split role's activation inputs, supplied by the owner of that role's lifetime. */
export type MachineRoleContexts = {
  memory: MemoryRoleContext; voice: VoiceRoleContext; devices: DevicesRoleContext; broker: BrokerRoleContext;
  sessions: SessionsRoleContext;
};

type MachineRoleActivate<K extends SplitMachineRoleId> =
  (ctx: MachineRoleContexts[K], registerRpc: MachineRoleRpcRegistrar) => Promise<MachineRoleActivations[K] | null>;

/**
 * Each split role's entry, loaded by `import()` only when the role is activated (a rare path:
 * once per daemon start or per role toggle). Everything inside a role stays eager.
 */
const MACHINE_ROLE_ENTRY_LOADERS: { readonly [K in SplitMachineRoleId]: () => Promise<MachineRoleActivate<K>> } = {
  memory: async () => (await import('./memory/entry')).activateMemoryRole,
  voice: async () => (await import('./voice/entry')).activateVoiceRole,
  devices: async () => (await import('./devices/entry')).activateDevicesRole,
  broker: async () => (await import('./broker/entry')).activateBrokerRole,
  sessions: async () => (await import('./sessions/entry')).activateSessionsRole,
};

export type MachineRoleActivationRuntime = Readonly<{
  /**
   * Activates the split roles in the Machine's current role set, then follows the set:
   * newly active roles load their entry and register their RPC families, removed ones stop
   * and unregister, and an inactive role's RPC namespaces answer `machine_role_inactive`.
   */
  start: (bootMetadata?: MachineMetadataFieldReadV1) => Promise<void>;
  get: <K extends SplitMachineRoleId>(roleId: K) => MachineRoleActivations[K] | null;
  /**
   * Supplies (or replaces) a role's context that is only known later in its owner's lifetime
   * (sessions: the Machine client's RPC composition). The role then activates if it is in the
   * active set; a running activation is replaced with the new context.
   */
  provide: <K extends SplitMachineRoleId>(roleId: K, ctx: MachineRoleContexts[K]) => Promise<void>;
  stop: () => Promise<void>;
  /**
   * Stable feed bound once by its consumer (external-Session observation): it reaches
   * whichever memory worker the role runs, across live toggles.
   */
  memoryExternalObservation: Required<Pick<MemoryWorkerHandle, 'attachExternalObservation'>>;
  /** Stable peer-tunnel voice media consumers: they reach the running voice role, or refuse typed. */
  voiceBinaryConsumers: Readonly<{
    append: PeerTcpTunnelVoiceBinaryAppendConsumer;
    terminal: PeerTcpTunnelVoiceBinaryTerminalConsumer;
  }>;
}>;

export function createMachineRoleActivationRuntime(params: Readonly<{
  /**
   * The Machine transport's dispatcher. With it, this runtime also owns the one refusal: every
   * split role outside the active set answers `machine_role_inactive`. Roles whose RPC goes
   * through their own publication (devices) need none.
   */
  rpcHandlerManager?: RpcHandlerManager;
  /**
   * The roles this runtime activates: one context per role. Roles bound to the Machine transport
   * (memory, voice) run per machine connection; daemon-lifetime roles (devices) run with the
   * session control runtime. Each role has exactly one activation owner.
   */
  contexts: Partial<MachineRoleContexts>;
  /** The one owner of the Machine's role set (P03-ROLES-POLICY). Missing = the missing-field default (every core role). */
  roles?: Pick<MachineRolesRuntime, 'activeRoles' | 'subscribe'> & Partial<Pick<MachineRolesRuntime, 'observe'>>;
}>): MachineRoleActivationRuntime {
  const running = new Map<SplitMachineRoleId, MachineRoleActivations[SplitMachineRoleId]>();
  const ownerId = (roleId: SplitMachineRoleId) => `machine-role:${roleId}`;
  const registrarFor = (roleId: SplitMachineRoleId): MachineRoleRpcRegistrar => register => {
    const rpcHandlerManager = params.rpcHandlerManager;
    if (!rpcHandlerManager) throw new Error(`Machine role ${roleId} registers RPC without a dispatcher`);
    return rpcHandlerManager.replaceOwnedHandlers(ownerId(roleId), () => register(rpcHandlerManager));
  };
  const contexts: Partial<MachineRoleContexts> = { ...params.contexts };
  const ownedRoleIds = () => SPLIT_MACHINE_ROLE_IDS.filter(roleId => contexts[roleId]);
  const deactivate = async (roleId: SplitMachineRoleId, reason: MachineRoleStopReason) => {
    const activation = running.get(roleId);
    running.delete(roleId);
    if (roleId === 'memory') attachObservations(null);
    params.rpcHandlerManager?.replaceOwnedHandlers(ownerId(roleId), () => undefined);
    await activation?.stop(reason);
  };
  // External-Session observations stay attached to whichever memory worker is running.
  const externalObservations = new Map<Parameters<NonNullable<MemoryWorkerHandle['attachExternalObservation']>>[0], (() => void) | null>();
  const attachObservations = (worker: MemoryWorkerHandle | null) => {
    for (const observation of externalObservations.keys()) {
      externalObservations.get(observation)?.();
      externalObservations.set(observation, worker?.attachExternalObservation?.(observation) ?? null);
    }
  };
  const activate = async <K extends SplitMachineRoleId>(roleId: K) => {
    const activateRole = await MACHINE_ROLE_ENTRY_LOADERS[roleId]();
    const activation = await activateRole(contexts[roleId] as MachineRoleContexts[K], registrarFor(roleId));
    if (activation) running.set(roleId, activation);
    if (roleId === 'memory') attachObservations((activation as MemoryRoleActivation | null)?.worker ?? null);
  };
  // Activations and deactivations never interleave: each reconcile runs after the previous one.
  let queue: Promise<void> = Promise.resolve();
  const serialize = (work: () => Promise<void>) => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };
  const activeRoles = new Set<SplitMachineRoleId>();
  let unsubscribe: (() => void) | null = null;
  let started = false;
  let stopped = false;
  const roles: NonNullable<typeof params.roles> = params.roles ?? { activeRoles: () => resolveActiveMachineRolesV1(undefined), subscribe: () => () => {} };
  const reconcile = (active: ReadonlySet<string>) => serialize(async () => {
    if (stopped) return;
    // New calls into a removed role are refused at once; its admitted work finishes as it stops.
    params.rpcHandlerManager?.setInactiveRoleNamespaces(SPLIT_MACHINE_ROLE_IDS
      .filter(roleId => !active.has(roleId))
      .flatMap(roleId => MACHINE_ROLE_RPC_NAMESPACES[roleId].map(prefix => [prefix, roleId] as const)));
    for (const roleId of ownedRoleIds()) {
      if (!active.has(roleId) && activeRoles.delete(roleId)) await deactivate(roleId, 'inactive');
    }
    for (const roleId of ownedRoleIds()) {
      if (active.has(roleId) && !activeRoles.has(roleId)) await activateTracked(roleId);
    }
  });
  const activateTracked = async (roleId: SplitMachineRoleId) => {
    activeRoles.add(roleId);
    try {
      await activate(roleId);
    } catch (error) {
      activeRoles.delete(roleId);
      throw error;
    }
  };
  return {
    start: async bootMetadata => {
      if (stopped) return;
      started = true;
      // Read the role set before anything starts, so an excluded role never runs at boot.
      if (bootMetadata) roles.observe?.(bootMetadata);
      unsubscribe ??= roles.subscribe(() => {
        void reconcile(roles.activeRoles())
          .catch(error => logger.warn('[DAEMON RUN] Machine role activation failed', error));
      });
      await reconcile(roles.activeRoles());
    },
    memoryExternalObservation: {
      attachExternalObservation: observation => {
        const worker = (running.get('memory') as MemoryRoleActivation | undefined)?.worker ?? null;
        externalObservations.set(observation, worker?.attachExternalObservation?.(observation) ?? null);
        return () => {
          externalObservations.get(observation)?.();
          externalObservations.delete(observation);
        };
      },
    },
    voiceBinaryConsumers: {
      append: async input => {
        const streaming = (running.get('voice') as VoiceRoleActivation | undefined)?.registration.voiceInferenceStreaming;
        return streaming ? await streaming.appendSttStreamBinaryFrame(input) : {
          ok: false, errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE, roleId: 'voice',
          error: 'The Machine role that serves voice media is not active',
        };
      },
      terminal: async input => {
        const streaming = (running.get('voice') as VoiceRoleActivation | undefined)?.registration.voiceInferenceStreaming;
        return streaming ? await streaming.cancelSttStreamForTransportLoss(input) : undefined;
      },
    },
    get: <K extends SplitMachineRoleId>(roleId: K) => (running.get(roleId) as MachineRoleActivations[K] | undefined) ?? null,
    provide: (roleId, ctx) => serialize(async () => {
      if (stopped) return;
      contexts[roleId] = ctx;
      // A new context replaces the running activation (the owner re-composed its inputs).
      if (activeRoles.delete(roleId)) await deactivate(roleId, 'shutdown');
      if (started && roles.activeRoles().has(roleId)) await activateTracked(roleId);
    }),
    stop: () => {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      return serialize(async () => {
        for (const roleId of [...activeRoles]) {
          activeRoles.delete(roleId);
          await deactivate(roleId, 'shutdown');
        }
      });
    },
  };
}
