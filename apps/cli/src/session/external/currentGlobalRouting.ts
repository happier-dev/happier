import type {
  PluginSessionAccess,
  PluginSessionAccessScope,
} from '@/session/services/pluginSessionsInventory';

import type { CurrentGlobalExternalSessionsAuthorService } from './currentGlobalAuthorService';

/**
 * Current-public authorization is deliberately distinct from exact retained
 * generation custody. A retained runner can still be current enough to finish
 * private work while its public SDK call must obey the newly published
 * contribution's HostAccess policy.
 */
export type CurrentGlobalExternalSessionsPublicAccess = Readonly<
  | {
      status: 'available';
      /**
       * Resolved current-public Session HostAccess scopes that are applicable
       * on this host, as projected by the HostAccess policy owner. The
       * ratified operation mapping is enforced against these scopes:
       * `capabilities`, `list`, `readTranscript`, and `followTranscript`
       * require a scope granting Session `read`; `attach` and `takeover`
       * require Session `control`. An empty list means no applicable scope
       * grants anything.
       *
       * Host-context restrictions (machine identity, project identity) are
       * resolved by the router before the scopes arrive here; see
       * `resolveHostApplicableExternalSessionsPublicScopes`.
       */
      scopes: readonly PluginSessionAccessScope[];
    }
  | { status: 'denied' }
  | { status: 'unavailable' }
>;

/**
 * Fallback for author bindings whose owner-local context does not model the
 * daemon-lifetime router (owner-local tests). It is the same unrestricted
 * Session grant the router would resolve for an unrestricted `sessions`
 * HostAccess request.
 */
export const unrestrictedCurrentGlobalExternalSessionsPublicAccess: CurrentGlobalExternalSessionsPublicAccess =
  Object.freeze({
    status: 'available',
    scopes: Object.freeze([
      Object.freeze({
        access: Object.freeze(['read', 'write', 'control'] satisfies readonly PluginSessionAccess[]),
      }),
    ]),
  });

/**
 * Applies the host-context restrictions a bare scope list cannot carry:
 *
 * - `machineIds` must include the host's current machine id; a scope that
 *   names other machines grants nothing here, and it also grants nothing when
 *   the host machine identity is unavailable.
 * - `projectIds` restrictions fail closed. The public External Sessions
 *   surface has no host-owned canonical project identity, and plugin-private
 *   source link data is never consulted to reconstruct one. If a host-owned
 *   canonical project identity for external sources ever exists, this ceiling
 *   — not a link-data read — is what must change.
 */
export function resolveHostApplicableExternalSessionsPublicScopes(input: Readonly<{
  scopes: readonly PluginSessionAccessScope[];
  resolveCurrentMachineId(): string | null;
}>): readonly PluginSessionAccessScope[] {
  const currentMachineId = input.resolveCurrentMachineId()?.trim() ?? '';
  return Object.freeze(input.scopes.filter((scope) => {
    if (scope.machineIds !== undefined
      && (!currentMachineId || !scope.machineIds.includes(currentMachineId))
    ) {
      return false;
    }
    return scope.projectIds === undefined;
  }));
}

export type CurrentGlobalExternalSessionsPublicCaller = Readonly<{
  pluginId: string;
  contribution: Readonly<{
    id: string;
    qualifiedId: string;
  }>;
  /** The caller's real invocation surface is part of current HostAccess policy. */
  surface: string;
  sessionId?: string;
}>;

/**
 * The public current-global External Sessions authority, as one indirection a
 * caller keeps for its whole lifetime.
 *
 * A long-lived plugin context — a background service, for instance — is created
 * once and survives an unrelated peer Agent replacement, but the registry that
 * built it does not stay current. Capturing that registry's own owner pins the
 * caller to a predecessor generation, so every later public call keeps
 * resolving a retired Agent instead of the currently published one. The
 * daemon/controller-lifetime router resolves the currently published registry
 * per call. Exact retained-G private composition is unaffected and must stay
 * exact to G.
 *
 * This module deliberately holds only a type import so the reload controller
 * can own a router without pulling the External Sessions runtime graph — and
 * its transitive import of the controller singleton — into a cycle.
 */
export type CurrentGlobalExternalSessionsRouter = Readonly<{
  resolveCurrent(): CurrentGlobalExternalSessionsAuthorService | null;
  activateConfiguredSources(agentId?: string): Promise<void>;
  readPublicCallerAccess?(
    caller: CurrentGlobalExternalSessionsPublicCaller,
  ): CurrentGlobalExternalSessionsPublicAccess;
}>;

/**
 * Routes public current-global calls through whatever registry is published
 * now. There is no retarget call and no stored generation: publication is
 * already the one atomic swap, so the router simply reads it.
 */
export function createCurrentGlobalExternalSessionsRouter(
  resolvePublished: () => CurrentGlobalExternalSessionsRouter | null,
): CurrentGlobalExternalSessionsRouter {
  return Object.freeze({
    resolveCurrent: () => resolvePublished()?.resolveCurrent() ?? null,
    activateConfiguredSources: async (agentId) => {
      await resolvePublished()?.activateConfiguredSources(agentId);
    },
    readPublicCallerAccess: (caller) => (
      resolvePublished()?.readPublicCallerAccess?.(caller) ?? { status: 'unavailable' }
    ),
  });
}
