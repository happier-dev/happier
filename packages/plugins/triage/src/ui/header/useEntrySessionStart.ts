import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type {
    TriageStartEntrySessionInputV1,
    TriageStartEntrySessionResultV1,
} from '../../actions/entrySessionProtocol.js';
import type { TriageWorkspaceModeV1 } from '../../sessions/entrySessionWorkspace.js';
import {
    projectTriageNewSessionDestinationV1,
    triageNewSessionDraftSeedV1,
    triageNewSessionWireMaterializationV1,
    type TriageNewSessionPreferenceV1,
} from './newSessionDestination.js';
import {
    requestTriageNewSessionDraft,
    type TriageNewSessionDraftHostV1,
} from './newSessionDraftCommand.js';
import {
    submitTriageEntrySessionStart,
    type TriageSessionStartHostV1,
} from './startEntrySessionCommand.js';

/**
 * The common header's transient Session-start controller.
 *
 * One press is two host hops. The reader is first taken to the host's own New
 * Session surface, where they pick the Agent and the working directory exactly
 * as they do for any other Session; what they settle there is then carried,
 * unchanged, into this plugin's one start Action, which owns the
 * workspace-mode gate, the creation, the link and the open. Triage names no
 * Agent on either hop.
 *
 * It is deliberately the only state in the whole start path, and it is
 * transient: an in-flight press and the last settled verdict, both scoped to
 * this mount. There is no local Session record, no optimistic link, no queue and
 * no retry policy — the orchestrator's phase-local result already says exactly
 * what settled and what a retry would repeat, and a second opinion here would be
 * a second start owner for one entry.
 *
 * A press that arrives while one is in flight is ignored rather than queued: two
 * presses of one action are one request, and admitting the second would open a
 * second New Session surface and mint a second creation key for the Session the
 * first is already creating.
 */

export type TriageEntrySessionStartRequestV1 = Readonly<{
    /** The pressed action's declared mode; the gate reads exactly this. */
    workspaceMode: TriageWorkspaceModeV1;
    entryRef: TriageEntryRefV1;
    display: TriageStartEntrySessionInputV1['display'];
    /**
     * What Triage settings pin for this action, when the reader set anything.
     * Absent is the default path: the host's New Session surface opens on its
     * own defaults.
     */
    preference?: TriageNewSessionPreferenceV1;
}>;

/**
 * `SessionCreationKeyV1`: the one identity of one logical new-Session request.
 *
 * It is injectable for the same reason the link's publication id is
 * (`sessions/entrySessionLinks.ts`) — a caller that must pin exactly what left
 * for the daemon, and a runtime whose `crypto` surface is not guaranteed.
 */
export type TriageSessionCreationKeyMintV1 = () => string;

const mintRandomCreationKey: TriageSessionCreationKeyMintV1 = () => {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
    // React Native has no WebCrypto, and a creation key is a dedupe identity
    // rather than a secret: distinctness per press is the whole requirement.
    return `triage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

/**
 * Why nothing was started, when the failure is this surface's rather than a
 * phase of the orchestrator's own verdict.
 */
export type TriageEntrySessionStartUnavailableReasonV1 =
    /** This mount cannot open the host's New Session surface at all. */
    | 'newSessionUnsupported'
    /** It could not be opened, or settled something no start can be built from. */
    | 'newSessionUnavailable'
    /** The reachable wire cannot request a prepared review workspace. */
    | 'preparedWorkspaceUnsupported'
    /** The Action dispatch did not happen or did not answer in this contract's shape. */
    | 'dispatch';

export type TriageEntrySessionStartPhaseV1 =
    | Readonly<{ kind: 'idle' }>
    /** The host's New Session surface is open and the reader is choosing. */
    | Readonly<{ kind: 'choosing' }>
    | Readonly<{ kind: 'starting' }>
    /** The orchestrator answered. Every arm — including its refusals — is here. */
    | Readonly<{ kind: 'settled'; result: TriageStartEntrySessionResultV1 }>
    /**
     * Nothing was started. It is deliberately distinct from every settled arm,
     * because "nothing was started" and "the start failed at a named phase" are
     * different things to tell a reader.
     */
    | Readonly<{ kind: 'unavailable'; reason: TriageEntrySessionStartUnavailableReasonV1 }>;

export type TriageEntrySessionStartControllerV1 = Readonly<{
    phase: TriageEntrySessionStartPhaseV1;
    /** Ignored while a press is in flight; otherwise starts exactly one. */
    start: (request: TriageEntrySessionStartRequestV1) => void;
    /** Returns to `idle` — for dismissing a settled outcome, never for retrying one. */
    reset: () => void;
}>;

const IDLE: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'idle' });
const CHOOSING: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'choosing' });
const STARTING: TriageEntrySessionStartPhaseV1 = Object.freeze({ kind: 'starting' });

function unavailable(
    reason: TriageEntrySessionStartUnavailableReasonV1,
): TriageEntrySessionStartPhaseV1 {
    return Object.freeze({ kind: 'unavailable', reason });
}

export type TriageEntrySessionStartOptionsV1 = Readonly<{
    mintCreationKey?: TriageSessionCreationKeyMintV1;
}>;

export function useTriageEntrySessionStart(
    options?: TriageEntrySessionStartOptionsV1,
): TriageEntrySessionStartControllerV1 {
    const host = usePluginHostApi() as unknown as
        TriageSessionStartHostV1 & TriageNewSessionDraftHostV1;
    const [phase, setPhase] = React.useState<TriageEntrySessionStartPhaseV1>(IDLE);
    // Read synchronously by `start`, so two presses in one tick cannot both pass
    // the gate the way a state read would.
    const inFlight = React.useRef(false);
    const retired = React.useRef(false);
    // Absent options resolve to the one module-level default, so the ordinary
    // caller keeps a referentially stable `start`.
    const mintCreationKey = options?.mintCreationKey ?? mintRandomCreationKey;

    React.useEffect(() => {
        retired.current = false;
        return () => { retired.current = true; };
    }, []);

    const start = React.useCallback((request: TriageEntrySessionStartRequestV1) => {
        if (inFlight.current) return;
        // Refused before anything opens. Asking the reader to pick an Agent and
        // a directory for a start this wire cannot carry spends their choice on
        // a refusal they could have been told about first.
        if (triageNewSessionWireMaterializationV1(request.workspaceMode) === null) {
            setPhase(unavailable('preparedWorkspaceUnsupported'));
            return;
        }
        inFlight.current = true;
        setPhase(CHOOSING);
        void (async () => {
            try {
                const seed = triageNewSessionDraftSeedV1(request.preference ?? {});
                const draft = await requestTriageNewSessionDraft(host, seed);
                if (retired.current) return;
                if (draft.status === 'cancelled') {
                    // The reader closed the surface. Nothing was chosen, nothing
                    // failed, and no creation key was spent.
                    setPhase(IDLE);
                    return;
                }
                if (draft.status !== 'settled') {
                    setPhase(unavailable(
                        draft.status === 'unsupported' ? 'newSessionUnsupported' : 'newSessionUnavailable',
                    ));
                    return;
                }
                const destination = projectTriageNewSessionDestinationV1({
                    workspaceMode: request.workspaceMode,
                    creationKey: mintCreationKey(),
                    settlement: draft.settlement,
                });
                if (destination.status === 'refused') {
                    setPhase(unavailable(destination.reason === 'preparedWorkspaceUnsupported'
                        ? 'preparedWorkspaceUnsupported'
                        : 'newSessionUnavailable'));
                    return;
                }
                setPhase(STARTING);
                const result = await submitTriageEntrySessionStart(host, {
                    v: 1,
                    workspaceMode: request.workspaceMode,
                    entryRef: request.entryRef,
                    display: request.display,
                    destination: destination.destination,
                });
                if (!retired.current) setPhase(Object.freeze({ kind: 'settled', result }));
            } catch {
                if (!retired.current) setPhase(unavailable('dispatch'));
            } finally {
                inFlight.current = false;
            }
        })();
    }, [host, mintCreationKey]);

    const reset = React.useCallback(() => { setPhase(IDLE); }, []);

    return React.useMemo(
        () => Object.freeze({ phase, start, reset }),
        [phase, reset, start],
    );
}
