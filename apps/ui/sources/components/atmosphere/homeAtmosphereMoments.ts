import * as React from 'react';
import type { AtmospherePicture } from '@happier-dev/brand/atmosphere';
import type { HomeAtmosphere } from '@happier-dev/protocol/account/settings/accountSettings';
import {
  MOMENT_TRIGGER_WINDOWS_MS,
  idleResettleTrigger,
} from '@happier-dev/brand/planet-moments';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import {
  isActivityCandidateAwaitingPerson,
  forEachActivitySummaryCandidate,
} from '@/activity/source/buildActivityOverviewFromSource';
import { createActivitySourceSessionAddressProjection } from '@/activity/source/activitySourceSessionAddresses';
import { readActivityAttentionStoreSource } from '@/activity/source/createActivityAttentionStoreSourceSelector';
import { useActivityPersonalSessionMembership, type ActivityPersonalSessionMembership } from '@/activity/source/activityPersonalSessionMembership';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { getActiveServerSnapshot, subscribeActiveServer, type ActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { atmosphereResettleFact, type AtmosphereRotationAnchor } from './atmosphereStage';
import { builtinPictureLocalId } from './ensureBuiltinPicture';
import { homeIdleResettlePicture } from './resolveAtmosphere';
import { createSessionFinishedRippleObserver, type SessionTurnState } from './sessionFinishedRippleObserver';
export { createSessionFinishedRippleObserver, type SessionTurnState } from './sessionFinishedRippleObserver';

/**
 * Home's two answering moments (plan UD-4): the session-finished ripple and the idle resettle. The brand
 * owns their frame maths and admission policies; Home keeps the policies' memory while it is mounted,
 * so nothing here persists, polls or runs at rest.
 */
const clock = () => performance.now();


/**
 * Each personal session's canonical completion watermark and the same "needs you" classification
 * Home's status line counts. A quiet, queued or interrupted runtime is not a completed turn.
 */
export function buildSessionTurnStates(
  params: Readonly<{ source: ActivityAttentionSource; nowMs: number; addresses?: readonly SessionAddress[] }>,
): ReadonlyMap<string, SessionTurnState> {
  const states = new Map<string, SessionTurnState>();
  forEachActivitySummaryCandidate(
    { ...params, includeWarmSourceWhenNotReady: true },
    ({ entry, candidate }) => {
      states.set(`${entry.address.serverId}\u0000${entry.address.sessionId}`, {
        lastTurnCompletedAt: candidate.lastTurnCompletedAt,
        pendingApproval: isActivityCandidateAwaitingPerson(candidate),
      });
    },
  );
  return states;
}

export type SessionTurnStateChanges = Readonly<{
  /** Null removes a formerly admitted Session, so a later reappearance is learned afresh. */
  states: ReadonlyMap<string, SessionTurnState | null>;
  reset: boolean;
}>;

/**
 * Consume the store's changed-id publication, retaining only compact turn facts. Corpus/policy
 * changes rebuild through Activity's address owner; ordinary arrivals classify exact changed
 * addresses through that same attention owner, without Activity's full overview signatures.
 */
export function createSessionTurnStateSelector() {
  let previous: StorageState | null = null;
  let previousMembership: ActivityPersonalSessionMembership | null = null;
  let previousServer: ActiveServerSnapshot | null = null;
  let addressProjection: ReturnType<typeof createActivitySourceSessionAddressProjection> | null = null;
  const known = new Map<string, SessionTurnState>();
  return (state: StorageState, membership: ActivityPersonalSessionMembership, activeServer: ActiveServerSnapshot): SessionTurnStateChanges | null => {
    const samePolicy = previous !== null && previousMembership === membership && previousServer === activeServer
      && previous.profileScope === state.profileScope && previous.isDataReady === state.isDataReady
      && previous.projectAccountRows === state.projectAccountRows
      && previous.sessionOrganizationTagAssignmentsBySessionKey === state.sessionOrganizationTagAssignmentsBySessionKey;
    if (samePolicy && previous?.sessions === state.sessions && previous.sessionListRowsByServerId === state.sessionListRowsByServerId
      && previous.ordinarySessionListMembershipByServerId === state.ordinarySessionListMembershipByServerId) {
      previous = state;
      return null;
    }
    const source: ActivityAttentionSource = {
      ...readActivityAttentionStoreSource(state, false, true), activeServer, activeServerId: activeServer.serverId,
      personalSessionListMembershipByServerId: membership.membershipByServerId,
      personalSessionListQueryStatesByServerId: membership.statesByServerId,
      personalFollowRulesByServerId: membership.followRulesByServerId,
    };
    const delta = state.sessionListRenderableDelta;
    const incremental = samePolicy && previous !== null && addressProjection !== null
      && delta.revision === previous.sessionListRenderableDelta.revision + 1
      && (delta.ordinaryMembershipChanges !== undefined
        || previous.ordinarySessionListMembershipByServerId === state.ordinarySessionListMembershipByServerId);
    if (!incremental || !addressProjection) addressProjection = createActivitySourceSessionAddressProjection(source, true);
    const changedAddresses = incremental ? addressProjection.update(source, delta) : null;
    const addresses = changedAddresses?.addresses ?? addressProjection.all();
    const next = buildSessionTurnStates({ source, nowMs: Date.now(), addresses });
    const changes = new Map<string, SessionTurnState | null>();
    const reset = previous === null || previous.profileScope?.accountId !== state.profileScope?.accountId
      || previous.profileScope?.serverId !== state.profileScope?.serverId;
    if (reset) known.clear();
    const inspectedKeys = changedAddresses
      ? [...addresses, ...changedAddresses.removed].map(address => `${address.serverId}\u0000${address.sessionId}`) : known.keys();
    for (const key of inspectedKeys) {
      if (known.has(key) && !next.has(key)) { known.delete(key); changes.set(key, null); }
    }
    for (const [key, value] of next) {
      const before = known.get(key);
      if (!before || before.lastTurnCompletedAt !== value.lastTurnCompletedAt || before.pendingApproval !== value.pendingApproval) {
        known.set(key, value);
        changes.set(key, value);
      }
    }
    previous = state;
    previousMembership = membership;
    previousServer = activeServer;
    return changes.size > 0 || reset ? { states: changes, reset } : null;
  };
}

/** Admission consumes every store publication synchronously; React may batch its answer count. */
export function useSessionFinishedRipple(
  input: Readonly<{ enabled: boolean; visible: boolean; onFinished?: (keys: readonly string[]) => void }>,
): number {
  const membership = useActivityPersonalSessionMembership();
  const activeServer = React.useSyncExternalStore(subscribeActiveServer, getActiveServerSnapshot, getActiveServerSnapshot);
  const project = React.useMemo(createSessionTurnStateSelector, [input.enabled]);
  const [ripples, setRipples] = React.useState(0);
  const latest = React.useRef(input);
  latest.current = input;
  const observe = React.useMemo(() => createSessionFinishedRippleObserver(
    () => setRipples(count => count + 1),
    keys => latest.current.onFinished?.(keys),
  ), []);
  React.useEffect(() => {
    if (!input.enabled) {
      observe({ enabled: false, visible: false, states: new Map() });
      return;
    }
    const update = (state: StorageState) => {
      const changes = project(state, membership, activeServer);
      if (changes) observe({ ...latest.current, ...changes });
    };
    const unsubscribe = storage.subscribe(update, {
      profileScope: true, isDataReady: true, projectAccountRows: true,
      sessionOrganizationTagAssignmentsBySessionKey: true, sessions: true,
      sessionListRowsByServerId: true, ordinarySessionListMembershipByServerId: true,
    });
    update(storage.getState());
    return unsubscribe;
  }, [input.enabled, project, membership, activeServer, observe]);
  return ripples;
}

/**
 * The idle resettle's admission at Home. While Home is idle (composer empty and unfocused, not
 * sending), visible and showing a built-in picture, one timer waits out the rest of the brand's
 * wall-clock window. A successful download announces the deterministic picture to the drawing owner
 * and wakes the resolver's clock sample. The person's saved choice is never written automatically.
 */
export function useIdleResettle(
  input: Readonly<{
    enabled: boolean;
    /** The built-in picture on Home, or null when Home does not show one. */
    picture: string | null;
    idle: boolean;
    visible: boolean;
    reducedMotion: boolean;
    value: HomeAtmosphere;
    anchor: AtmosphereRotationAnchor | null;
    pictures: readonly AtmospherePicture[];
    ensure: (picture: AtmospherePicture) => Promise<unknown>;
  }>,
): void {
  const { anchor } = input;
  const epochMs = anchor?.epochMs ?? 0;
  const windowStart = (nowMs: number) => epochMs
    + Math.floor(Math.max(0, nowMs - epochMs) / MOMENT_TRIGGER_WINDOWS_MS.resettle) * MOMENT_TRIGGER_WINDOWS_MS.resettle;
  const last = React.useRef<{ anchor: AtmosphereRotationAnchor | null; at: number }>({ anchor: null, at: 0 });
  if (last.current.anchor !== anchor) last.current = { anchor, at: windowStart(Date.now()) };
  const latest = React.useRef(input);
  latest.current = input;
  const armed =
    input.enabled && input.picture !== null && input.idle && input.visible
      && anchor !== null && homeIdleResettlePicture(input.value, 0) !== null;
  React.useEffect(() => {
    if (!armed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(
        admit,
        Math.max(
          0,
          last.current.at + MOMENT_TRIGGER_WINDOWS_MS.resettle - Date.now(),
        ),
      );
    };
    const admit = () => {
      const decision = idleResettleTrigger({
        nowMs: Date.now(),
        lastTriggeredAtMs: last.current.at,
        homeIdle: true,
        homeVisible: true,
      });
      if (!decision.trigger || decision.lastTriggeredAtMs === null) {
        arm();
        return;
      }
      last.current.at = windowStart(decision.lastTriggeredAtMs);
      arm();
      const { value, pictures, ensure, picture } = latest.current;
      const ref = homeIdleResettlePicture(value, Date.now() - epochMs);
      const next = ref ? pictures.find(picture => picture.id === ref.id) : undefined;
      if (!next || next.id === picture) return;
      // A failed download keeps the picture on screen; the next window tries again.
      void ensure(next).then(
        () => {
          if (cancelled || !latest.current.enabled || !latest.current.idle || !latest.current.visible) return;
          const current = homeIdleResettlePicture(latest.current.value, Date.now() - epochMs);
          if (current?.id !== next.id) return;
          atmosphereResettleFact.announce(
            builtinPictureLocalId(next.id),
            latest.current.reducedMotion,
          );
        },
        () => {},
      );
    };
    arm();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [armed, input.picture, anchor, epochMs]);
  React.useEffect(() => () => atmosphereResettleFact.clear(), []);
}
