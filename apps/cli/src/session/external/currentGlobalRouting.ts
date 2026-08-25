import type { CurrentGlobalExternalSessionsAuthorService } from './currentGlobalAuthorService';

/**
 * Current-public authorization is deliberately distinct from exact retained
 * generation custody. A retained runner can still be current enough to finish
 * private work while its public SDK call must obey the newly published
 * contribution's HostAccess policy.
 */
export type CurrentGlobalExternalSessionsPublicAccess =
  | 'available'
  | 'denied'
  | 'unavailable';

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
      resolvePublished()?.readPublicCallerAccess?.(caller) ?? 'unavailable'
    ),
  });
}
