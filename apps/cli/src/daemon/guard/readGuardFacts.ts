import type { BrowserSidecarResourceTarget } from '../browser/sidecar/controlAdapter';
import type { NormalizedLocalServiceInventorySnapshot } from '../local/services/inventory/scanner';
import type { ManagedServiceResourceTarget } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { readWorkspaceSessionIdle, type LiveWorkInventoryV1, type LiveWorkReadScopeV1 } from '../lifecycle/managedActivity';
import type { TrackedSession } from '../types';
import type { SessionEligibility } from './sessionEligibility';
import type { GuardFacts, GuardOwnership, GuardTarget } from './guardPlanner';
import { equalProcessStart, processOwnerKey, type HappierProcessRoot } from '../processes/ownership/types';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { readTrackedSessionProcessIdentity } from '../processes/roots/listHappierProcessRoots';
import { readGuardSessionTitle } from './readGuardSessionTitle';

export type ReadGuardFactsDependencies = Readonly<{
  readBrowsers: () => readonly BrowserSidecarResourceTarget[];
  readServices: (signal?: AbortSignal) => Promise<NormalizedLocalServiceInventorySnapshot>;
  readInventory: (scope?: LiveWorkReadScopeV1) => Promise<LiveWorkInventoryV1>;
  readServiceTargets?: () => readonly ManagedServiceResourceTarget[];
  trackedSessions: () => Iterable<TrackedSession>;
  readSessionEligibility: (tracked: TrackedSession, inventory: LiveWorkInventoryV1, signal?: AbortSignal) => Promise<SessionEligibility>;
}>;

/** Projects already-admitted owners; it never reads or reclassifies a process census. */
export function createReadGuardFacts(dependencies: ReadGuardFactsDependencies) {
  return async (input: Readonly<{ ownership: GuardOwnership; inventory: LiveWorkInventoryV1; signal?: AbortSignal;
    scope?: LiveWorkReadScopeV1 }>): Promise<GuardFacts> => {
    const { ownership, inventory: initialInventory } = input;
    if (ownership.status !== 'ok') return { ownership, inventory: initialInventory, targets: [] };
    const tracked = [...dependencies.trackedSessions()];
    const nativeByPid = new Map(ownership.snapshot.rows.map(row => [row.pid, row]));
    const ownershipByPid = new Map(ownership.rows.map(row => [row.pid, row]));
    const sessionRoots = ownership.roots.flatMap(root => {
      if (root.owner.kind !== 'session' || !root.live) return [];
      const sessionId = root.owner.sessionId;
      const session = tracked.find(item => {
        const identity = readTrackedSessionProcessIdentity(item);
        return item.happySessionId === sessionId && identity.pid === root.pid
          && identity.processStartTimeMs === root.start.startTimeMs;
      });
      const native = nativeByPid.get(root.pid);
      return session && native && equalProcessStart(root.start, native.start) ? [{ root, session, sessionId }] : [];
    });
    const targets: GuardTarget[] = await Promise.all(sessionRoots.map(async ({ root, session, sessionId }) => ({
      kind: 'session' as const, root, tracked: session,
      eligibility: await dependencies.readSessionEligibility(session, initialInventory, input.signal),
      label: readGuardSessionTitle(session.happySessionMetadataFromLocalWebhook),
      wayBack: [{ label: 'resume' as const, actionId: 'session.open' as const,
        input: { sessionId, intent: 'resume', ...(session.requesterWorkAttributionV1?.serverId
          ? { serverId: session.requesterWorkAttributionV1.serverId } : {}) } }],
    })));
    // All draft/resume and inventory transports finish before native socket/control observations.
    const inventory = await dependencies.readInventory(input.scope);
    const services = await dependencies.readServices(input.signal);
    const serviceTargets = dependencies.readServiceTargets?.() ?? [];
    const sessionsById = new Map<string, TrackedSession | undefined>();
    for (const { session, sessionId } of sessionRoots) {
      // A Session-only origin cannot select between multiple currently tracked runners.
      sessionsById.set(sessionId, sessionsById.has(sessionId) ? undefined : session);
    }
    for (const root of ownership.roots) {
      if (root.owner.kind !== 'service' || root.owner.sessionId || root.owner.pluginId) continue;
      const original = serviceTargets.find(target => target.root.pid === root.pid
        && processOwnerKey(target.root.owner) === processOwnerKey(root.owner)
        && (!target.root.start || equalProcessStart(target.root.start, root.start))
        && (target.root.processStartTimeMs === undefined || target.root.processStartTimeMs === root.start.startTimeMs));
      if (!original?.project || original.lifecyclePurpose !== 'development') continue;
      const project = original.project;
      const isOwnedListenerMember = (pid: number): boolean => {
        const member = ownershipByPid.get(pid);
        return Boolean(member?.owner && processOwnerKey(member.owner) === processOwnerKey(root.owner)
          && member.chain.some(link => link.pid === root.pid));
      };
      const listenerEntries = services.entries.filter(entry => {
        const process = entry.provenance?.process;
        if (!process) return false;
        // A late child outside the supplied census can only contribute unknown, never ownership or zero.
        return isOwnedListenerMember(process.pid) || process.lineagePids.includes(root.pid);
      });
      const wayBack = original.wayBack?.map(action => ({ ...action,
        input: projectNativeJsonValueForTransport(action.input) }));
      targets.push({ kind: 'service', root, scope: 'project', ownerRef: project,
        workspacePath: project.workspace.rootPath,
        workspaceIdle: readWorkspaceSessionIdle(inventory, {
          workspacePath: project.workspace.rootPath, workspaceId: project.workspace.id,
        }), attribution: project.requester,
        listeners: listenerEntries.length ? listenerEntries.map(entry => {
          const process = entry.provenance?.process;
          const native = process ? nativeByPid.get(process.pid) : undefined;
          const member = process ? ownershipByPid.get(process.pid) : undefined;
          return { establishedConnections:
            !process || !isOwnedListenerMember(process.pid) || !native || !member || !equalProcessStart(member.start, native.start)
              || process?.processStartTimeMs !== native.start.startTimeMs
              || services.refreshState === 'error' || entry.state !== 'listening'
              || typeof entry.establishedConnections !== 'number' || !Number.isSafeInteger(entry.establishedConnections)
              || entry.establishedConnections < 0 ? null : entry.establishedConnections };
        }) : [{ establishedConnections: null }],
        label: listenerEntries[0]?.presentation?.displayName ?? listenerEntries[0]?.classification?.displayName ?? 'Service',
        ...(wayBack?.length ? { wayBack } : {}),
      });
    }
    // No await follows these real input/control facts, so no network read can stale them.
    for (const browser of dependencies.readBrowsers()) {
      const canonical = ownership.roots.find(root => root.pid === browser.root.pid
        && root.owner.kind === 'browser_sidecar' && equalProcessStart(root.start, browser.root.start));
      if (!canonical) continue;
      const root: HappierProcessRoot = { ...canonical, stop: browser.root.stop };
      targets.push({ ...browser, kind: 'browser', root,
        ownerRef: sessionsById.get(browser.ownerRef) ?? browser.ownerRef });
    }
    return { ownership, inventory, targets };
  };
}
