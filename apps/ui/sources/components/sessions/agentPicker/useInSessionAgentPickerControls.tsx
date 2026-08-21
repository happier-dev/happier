import * as React from 'react';

import { buildAcpConfigOptionOverridesV1FromConfigOptions } from '@happier-dev/protocol';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import {
    APPLIED_RUNTIME_MARKER_ICON,
    APPLIED_RUNTIME_MARKER_RAIL_SIZE,
    resolveAppliedRuntimeStatus,
    type AppliedRuntimeStatus,
} from '@/components/sessions/agentInput/appliedRuntimeMarker';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { Icon } from '@/components/ui/icons/Icon';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { isHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';

import {
    clearSessionDraftValue,
    readSessionDraftValue,
    writeSessionDraftValue,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import type { SessionArmedAgentContinuation } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Settings } from '@/sync/domains/settings/settings';

import {
    buildSessionAgentPickerDetailContent,
    type SessionAgentPickerSelection,
} from './buildSessionAgentPickerDetailContent';
import { buildSessionAgentPickerOptions } from './buildSessionAgentPickerOptions';
import { useSessionAgentPickerControls } from './useSessionAgentPickerControls';
import { useSessionContinuationInspections } from './useSessionContinuationInspections';
import {
    resolveSessionAgentContinuationEligibility,
    resolveSessionAgentContinuationSessionReason,
    type SessionAgentContinuationEligibility,
    type SessionAgentContinuationMachineTarget,
    type SessionAgentContinuationSourceState,
} from './resolveSessionAgentContinuationEligibility';

/**
 * The armed intent plus the catalog row it came from, so the picker can keep showing
 * the exact chosen row even when several rows resolve to the same Agent id, and the
 * words the composer's engine chip uses for the chosen model.
 *
 * Declared once, by the Session draft that persists it, so the live value and the
 * stored value can never drift into two shapes of the same choice.
 */
type ArmedAgentContinuation = SessionArmedAgentContinuation;

const ARMED_AGENT_CONTINUATION_FIELD_ID = 'routing.agentContinuation' as const;
const ARMED_AGENT_CONTINUATION_SUBMISSION_FIELD_ID = 'routing.agentContinuationSubmission' as const;

/**
 * The lifetime of one armed choice, as a key. Formed in one place so the value
 * a restore adopts an identity under is the same value the render mints under —
 * two spellings of this would silently re-mint on the very mount the identity
 * has to survive.
 */
function buildArmedContinuationIdentityKey(armScopeKey: string, arm: ArmedAgentContinuation): string {
    return `${armScopeKey} ${arm.backendTargetKey} ${JSON.stringify(arm.intent)}`;
}

type UseInSessionAgentPickerControlsParams = Readonly<{
    sessionId: string;
    /**
     * The Server/Account the Session's draft belongs to. The armed Agent is part
     * of that draft, so it is stored in the same scope as the draft text rather
     * than in a second place with its own lifetime.
     */
    accountScope: ServerAccountScope | null;
    /** The Agent running this Session, as the catalog knows it. */
    currentAgentId: string | null;
    currentAgentLabel: string;
    /**
     * Whether this Session's runtime is alive, undefined when unknown.
     *
     * It decides how the running Agent's marker reads — running now, last used,
     * last reported — through the same owner the model list uses for the applied
     * model, so the two columns of one popover cannot claim different things.
     */
    currentAgentSessionActive?: boolean | null;
    entries: readonly ResolvedBackendCatalogEntry[];
    favoriteBackendTargetKeys?: ReadonlyArray<string>;
    /**
     * The `sessions.agentSwitching` decision for this Session's server, resolved
     * by the canonical feature-decision runtime, which reads the server bit as
     * `readServerEnabledBit(...) === true` and applies the catalog's dependency
     * closure. It is required rather than defaulted because the feature is
     * server-represented and `fail_closed`: a caller that forgets it must not
     * silently get the rail.
     *
     * The gate lands here, at the one place a target Agent can be armed, so
     * there is exactly one decision-maker. A closed gate means no inspection, no
     * rail, and no armed intent — and the submit path reads only the armed
     * intent, so it cannot be reached behind a closed gate.
     */
    featureEnabled: boolean;
    source: SessionAgentContinuationSourceState;
    /** Where continuation support is inspected, and how long an answer holds. */
    machine: SessionAgentContinuationMachineTarget;
    /**
     * What a target Agent's own model, mode and configuration detail needs to
     * resolve. Engine and model are one decision, so a target row shows the same
     * detail New Session shows for that Agent rather than prose about switching.
     */
    detail: SessionAgentPickerTargetDetailContext;
}>;

export type SessionAgentPickerTargetDetailContext = Readonly<{
    settings: Settings;
    capabilityServerId: string;
    /** The Session's machine; null falls back to the Agent catalog's static models. */
    machineId: string | null;
    cwd: string | null;
    profileId?: string | null;
}>;

/**
 * How the running Agent's row names itself, per applied-runtime status.
 *
 * The words carry what the glyph shows, because a glyph reaches no screen reader —
 * and `accessibilityState.selected` maps to `aria-selected`, which `role="button"`
 * silently drops. They are three states rather than one so the row cannot say
 * "Running this Session" beside a clock.
 */
const CURRENT_AGENT_ACCESSIBILITY_LABEL_KEY = {
    running: 'session.agentContinuation.currentAgentAccessibilityLabel',
    lastUsed: 'session.agentContinuation.currentAgentLastUsedAccessibilityLabel',
    lastReported: 'session.agentContinuation.currentAgentLastReportedAccessibilityLabel',
} as const satisfies Record<AppliedRuntimeStatus, string>;

/** A target Agent starts at its own defaults, exactly as New Session starts it. */
const DEFAULT_TARGET_SELECTION: SessionAgentPickerSelection = {
    modelId: 'default',
    modelLabel: null,
    sessionModeId: null,
    configOverrides: {},
};

/**
 * Whether this host's primary pointer can announce intent before the popover opens.
 *
 * A mouse or trackpad has to travel over the Agent chip to click it, and a keyboard
 * has to focus it, so both give the machine a head start on `session.continuation.
 * inspect` — enough for the rail to be decided in the popover's FIRST painted frame.
 * A finger has none of that: press-in is roughly one frame before the open, and the
 * answers take 250-350ms, so warming on it would put the rail's arrival back into a
 * race with the popover's mount — the resize-after-open defect, restored.
 *
 * So intent gates the question where intent is available, and where it is not the
 * question is still asked as soon as the rail is a live possibility. That is a real
 * cost on touch, and it is the smaller one: the alternative is a popover that grows
 * by the width of a rail 40ms after the reader is already looking at it.
 */
export type InSessionAgentPickerControls = Readonly<{
    /**
     * Extends the composer's own current-Agent rows with the rest of the catalog.
     * Returns the input unchanged when this Session has no other Agent to offer.
     */
    composeAgentPickerOptions: (
        currentAgentOptions: ReadonlyArray<AgentInputChipPickerOption>,
    ) => ReadonlyArray<AgentInputChipPickerOption>;
    /** The armed target, or null so the composer keeps selecting the current Agent. */
    agentPickerSelectedOptionId: string | null;
    armedContinuation: ArmedAgentContinuation['intent'] | null;
    /**
     * The stable localId the submit path must carry for {@link armedContinuation}.
     * Non-null exactly when `armedContinuation` is.
     */
    armedContinuationLocalId: string | null;
    /**
     * What the picker called the armed target's model, or null while it is on that
     * Agent's own defaults. The composer's engine chip names it.
     */
    armedContinuationModelLabel: string | null;
    clearArmedContinuation: () => void;
    /**
     * The reader is reaching for the Agent chip — hovering it, focusing it, or
     * pressing it down. Continuation support is inspected from here, so a Session
     * whose picker is never approached asks its machine nothing.
     */
    onAgentPickerIntent: () => void;
    /**
     * The composer's Agent picker became visible or hidden. It scopes the rail
     * decision: one open popover keeps the one shape it opened with.
     */
    onAgentPickerVisibilityChange: (visible: boolean) => void;
}>;

type UnavailableEligibility = Extract<SessionAgentContinuationEligibility, { status: 'unavailable' }>;

type SessionAgentPickerTargetRow = Readonly<{
    entry: ResolvedBackendCatalogEntry;
    eligibility: SessionAgentContinuationEligibility;
}>;

/**
 * Why this one Agent is blocked, or null when the reason is a fact about the whole
 * Session rather than about this Agent.
 *
 * A Session-scoped reason is never rendered. When one applies it applies to every
 * target at once, and the picker then drops the Agent rail entirely rather than
 * repeating one fact down a list of choices that cannot be taken. Only a reason
 * that can single out one Agent inside an otherwise live rail has copy.
 */
function resolveTargetRowUnavailableText(
    eligibility: UnavailableEligibility,
    agentLabel: string,
): string | null {
    if (eligibility.kind === 'continuation') {
        switch (eligibility.presentation) {
            case 'update_cli':
                return t('session.agentContinuation.unavailable.updateCli');
            case 'update_or_reconnect':
                return t('session.agentContinuation.unavailable.updateOrReconnect');
            case 'unsupported_session':
                return t('session.agentContinuation.unavailable.unsupportedSession', { agent: agentLabel });
            case 'target_unavailable':
                return t('session.agentContinuation.unavailable.targetUnavailable', { agent: agentLabel });
            // Presence is one fact held for the Session, so an offline machine
            // blocks every row and the rail is gone before this could be read.
            case 'machine_offline':
                return null;
        }
    }
    switch (eligibility.reason) {
        case 'target_not_proven':
            return t('session.agentContinuation.unavailable.targetNotProven', { agent: agentLabel });
        // Facts about this Session, decided before any target is considered.
        case 'read_only':
        case 'external_session':
            return null;
    }
}

/**
 * The in-session half of the shared Agent picker.
 *
 * It projects the same Agent catalog New Session shows, with in-session eligibility.
 * Choosing an Agent, or one of its models, *is* the choice — the same commit-on-select
 * contract every other model picker in the product follows. There is no confirm step.
 *
 * What that choice does is arm the next message, and nothing else: no request, no
 * stop, no start, no write happens until the reader actually sends. Hovering or
 * travelling over a row does nothing at all; only deliberate activation — tap, click,
 * Enter or Space — selects.
 */
export function useInSessionAgentPickerControls(
    params: UseInSessionAgentPickerControlsParams,
): InSessionAgentPickerControls {
    const { accountScope, currentAgentId, currentAgentLabel, entries, featureEnabled, sessionId, source } = params;
    const draftSessionId = sessionId.trim().length > 0 ? sessionId.trim() : null;

    const currentAgentAppliedStatus = resolveAppliedRuntimeStatus(params.currentAgentSessionActive);
    // Read once per mount rather than at module evaluation: this file is reached
    // from the session shell, and importing it must not touch `window`.
    const pointerCanSignalIntent = React.useMemo(() => isHoverCapablePrimaryPointer(), []);

    const [armed, setArmed] = React.useState<ArmedAgentContinuation | null>(null);
    // The armed Agent is written straight through to the Session draft that already
    // holds the message it belongs to, so both halves of one composer decision have
    // one lifetime. The draft owner flushes on write; arming is a deliberate, rare
    // gesture, and the reader may leave the screen in the very next frame.
    const persistArmedContinuation = React.useCallback((next: ArmedAgentContinuation | null) => {
        setArmed(next);
        if (draftSessionId === null) return;
        if (next === null) {
            clearSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
        } else {
            writeSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID, next);
        }
    }, [accountScope, draftSessionId]);
    // Whether the composer's Agent picker is on screen. Its only job is to scope
    // the rail decision below to one open popover.
    const [pickerVisible, setPickerVisible] = React.useState(false);
    // Whether the reader has reached for the Agent chip on this Session yet.
    // One-way: an answer is cached for the whole connection, so there is nothing to
    // give back by forgetting the intent that bought it.
    const [pickerApproached, setPickerApproached] = React.useState(false);
    const signalAgentPickerIntent = React.useCallback(() => {
        setPickerApproached((current) => (current ? current : true));
    }, []);

    // A Session the reader already armed HAS been approached — in an earlier mount,
    // with the choice carried across it by the draft. Demanding the gesture again
    // would leave the composer promising "Continue with {Agent}" while the rail it
    // depends on is still undecided, so the persisted arm is its own intent signal.
    const hasPersistedArmedContinuation = React.useMemo(() => (
        draftSessionId !== null
        && typeof readSessionDraftValue(
            accountScope,
            draftSessionId,
            ARMED_AGENT_CONTINUATION_FIELD_ID,
        ) !== 'undefined'
    ), [accountScope, draftSessionId]);

    const targetEntries = React.useMemo(() => entries.filter((entry) => (
        entry.targetKey !== source.currentBackendTargetKey
    )), [entries, source.currentBackendTargetKey]);

    // A Session that cannot continue with any Agent asks its machine nothing, and
    // everything else the local rules already reject — an unproven configured ACP
    // target — is decided here for free.
    const sessionReason = resolveSessionAgentContinuationSessionReason(source);
    const inspectableTargetAgentIds = React.useMemo(() => (
        sessionReason === null && featureEnabled
            ? targetEntries
                .filter((entry) => entry.family === 'builtInAgent')
                .map((entry) => entry.providerAgentId)
            : []
    ), [featureEnabled, sessionReason, targetEntries]);

    // The rail decision has to be settled BEFORE the popover paints, or the
    // popover opens at one width and then grows by the width of the rail. That is
    // the same defect as a rail appearing and vanishing, seen as geometry.
    //
    // Asking when the popover opens is structurally too late: the machine round
    // trip and the popover's own mount take about the same time, so which one wins
    // is a coin flip, and the reader sees the loser.
    //
    // So the question is asked on APPROACH instead. A pointer has to travel over
    // the Agent chip to click it and a keyboard has to focus it, which is a real
    // head start; where the primary pointer can give none — a finger — the
    // question falls back to being asked as soon as the rail is a live possibility
    // for this Session, because a late rail is a worse outcome than an early ask.
    //
    // It is never asked for every Session regardless. `inspectableTargetAgentIds`
    // is already empty for a closed gate, a read-only or external Session and one
    // with no other Agent; the inspection hook never calls a machine it knows is
    // offline; and one answer serves the whole realtime connection.
    const inspections = useSessionContinuationInspections({
        sessionId,
        machine: params.machine,
        machinePresence: source.machinePresence,
        targetAgentIds: inspectableTargetAgentIds,
        demanded: inspectableTargetAgentIds.length > 0
            && (pickerApproached || hasPersistedArmedContinuation || !pointerCanSignalIntent),
    });
    const readInspection = inspections.read;

    const targetRows = React.useMemo<readonly SessionAgentPickerTargetRow[]>(() => (
        targetEntries.map((entry) => ({
            entry,
            eligibility: resolveSessionAgentContinuationEligibility({
                entry,
                source,
                inspection: readInspection(entry.providerAgentId),
            }),
        }))
    ), [readInspection, source, targetEntries]);

    // The rail exists to offer a choice, and a question still in flight is not a
    // choice. Only a target the machine has actually cleared sustains the rail:
    // counting an unanswered one is what let the rail appear on the strength of
    // questions the machine then refused, and take itself away half a second
    // later with the reader already looking at it.
    const hasSwitchableTarget = targetRows.some((row) => row.eligibility.status === 'eligible');
    // Every target has been decided — answered by the machine, or refused by the
    // local rules before the machine was ever asked.
    const railDecisionSettled = targetRows.every((row) => row.eligibility.status !== 'checking');

    // What the rail decision would be from everything known right now; the latch
    // below turns it into the one value this popover keeps.
    //
    // A closed gate produces no rail — not a rail of rows stuck on "checking"
    // because nothing was ever asked, and not a rail of disabled rows repeating
    // one fact about the deployment down a list of Agents. Nor does a Session
    // with no other Agent, or one whose every target has been refused.
    //
    // It stays one value, because two things depend on it and they must not
    // disagree: the rows the composer is given, and whether an armed choice is
    // still cancellable.
    const railOffersRowsNow = featureEnabled
        && currentAgentId !== null
        && targetRows.length > 0
        && hasSwitchableTarget;

    // One open popover keeps one shape.
    //
    // Inspection is answered over the network while the popover is opening, so
    // the honest value of the line above changes mid-open. Rendering that change
    // is the defect: a rail that appears and then vanishes is worse than either
    // steady answer, and a rail frozen on the optimistic pending value would be a
    // list of dead rows, which is worse still.
    //
    // So the decision moves in one direction per open. It starts at "no rail",
    // becomes "rail" the moment one target is proven switchable, and settles at
    // "no rail" once every target has answered and none was. Whichever it reaches
    // first is what that popover keeps until it closes. In practice the answers
    // arrive while the popover is still mounting, so the reader sees a decided
    // popover; a warm cache — every reopen on the same connection — decides
    // before the first render.
    //
    // While the picker is closed the live value is used directly: nothing is on
    // screen to disturb, and the next open must start from the truth.
    const railLatchRef = React.useRef<Readonly<{ open: boolean; decided: boolean | null }>>(
        { open: false, decided: null },
    );
    if (railLatchRef.current.open !== pickerVisible) {
        railLatchRef.current = { open: pickerVisible, decided: null };
    }
    if (pickerVisible && railLatchRef.current.decided === null) {
        if (railOffersRowsNow) {
            railLatchRef.current = { open: true, decided: true };
        } else if (railDecisionSettled) {
            railLatchRef.current = { open: true, decided: false };
        }
    }
    const railOffersRows = pickerVisible
        ? railLatchRef.current.decided === true
        : railOffersRowsNow;

    // UI rail visibility and arm validity deliberately diverge during a fresh
    // inspection. A changed runtime pair turns every cached answer into
    // `checking`; that is not proof an existing choice is stale. Preserve an arm
    // until the replacement inspection settles, then keep it only when the rail
    // can still offer its cancellation gesture.
    const armMayRemain = !railDecisionSettled || railOffersRowsNow;

    // An armed choice belongs to one Session, one running Agent, one open feature
    // gate, and one settled rail decision. If any established fact changes
    // underneath the composer the intent is stale and must not silently survive —
    // the submit path reads this value and nothing else, so an arm that outlives a
    // closing gate is the gate bypassed.
    //
    // Once that decision settles, the rail belongs in this scope because selection
    // IS arming: there is no confirm step, so re-selecting the running Agent's row
    // is the only gesture that cancels. Pending reinspection is deliberately not a
    // lost gesture; it only hides the rows until the machine answers. An arm that
    // outlived a settled no-rail result would have no way out — the send control
    // still promises "Continue with {Agent}", every ordinary send is re-routed
    // into a transition the machine now refuses, and a refusal deliberately KEEPS
    // the arm, so not even sending clears it. Leaving the Session was the only
    // escape.
    const armScopeKey = `${featureEnabled ? 'on' : 'off'}:${armMayRemain ? 'rail' : 'norail'}:${sessionId} ${source.currentBackendTargetKey ?? ''}`;
    const armScopeKeyRef = React.useRef(armScopeKey);
    // A render may not write to storage, so the invalidation records the fact and
    // the reconciler below takes the persisted half away with the live one.
    const invalidatedArmRef = React.useRef(false);
    if (armScopeKeyRef.current !== armScopeKey) {
        armScopeKeyRef.current = armScopeKey;
        if (armed !== null) {
            setArmed(null);
            invalidatedArmRef.current = true;
        }
    }

    const clearArmedContinuation = React.useCallback(() => {
        persistArmedContinuation(null);
    }, [persistArmedContinuation]);

    // The submission identity for the armed choice, derived from the choice
    // itself rather than minted at whichever affordance established it.
    //
    // It is the transition's dedupe key, divider correlation key and draft
    // compare-clear key, so its lifetime has to be exactly the lifetime of one
    // armed choice: stable across re-renders, so retrying the same armed switch
    // after an unknown outcome re-admits ONE message instead of sending a second
    // copy, and replaced the moment the reader picks a different Agent, model,
    // mode or configuration, because that is a different switch.
    //
    // It identifies the TRANSITION, not the draft, so an edited draft retried
    // under the same arm deliberately keeps it: the daemon correlates a repeated
    // invocation against the divider derived from this value, and the canonical
    // admission owner — not this identity — is what refuses a reused identity
    // whose content differs.
    const armedIdentityKey = armed === null ? null : buildArmedContinuationIdentityKey(armScopeKey, armed);
    const armedLocalIdRef = React.useRef<Readonly<{ key: string; localId: string }> | null>(null);
    if (armedIdentityKey === null) {
        armedLocalIdRef.current = null;
    } else if (armedLocalIdRef.current?.key !== armedIdentityKey) {
        armedLocalIdRef.current = { key: armedIdentityKey, localId: randomUUID() };
    }
    const armedContinuationLocalId = armedLocalIdRef.current?.localId ?? null;

    // Restoring an arm is not rehydrating it. An armed choice is only meaningful
    // in the context it was made in, and persistence must not defeat the scope
    // that protects it: the gate has to still be open, the Session has to still
    // run the Agent the arm was formed against, and the exact row it was chosen
    // from has to still be offered and still be eligible. An arm restored onto an
    // Agent that can no longer be switched to is strictly worse than no arm — the
    // send control would promise a continuation the machine has already refused.
    //
    // The decision therefore waits for the rail to settle. Before every target has
    // answered, "not eligible" only means "not answered yet", and clearing on that
    // would throw away a good arm every time the reader returns to the Session.
    //
    // A closed gate is deliberately NOT treated as proof of staleness. The feature
    // decision fails closed, so an unresolved one looks exactly like a disabled
    // one; the arm is simply not restored, and it is re-validated properly on the
    // next visit where the gate is genuinely open.
    const reconciledArmScopeKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (draftSessionId === null) return;

        if (invalidatedArmRef.current) {
            invalidatedArmRef.current = false;
            reconciledArmScopeKeyRef.current = armScopeKey;
            clearSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
            return;
        }

        if (reconciledArmScopeKeyRef.current === armScopeKey) return;
        if (!featureEnabled || !railDecisionSettled || currentAgentId === null) return;
        reconciledArmScopeKeyRef.current = armScopeKey;
        if (armed !== null) return;

        const persisted = readSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
        if (typeof persisted === 'undefined') return;

        const row = targetRows.find(({ entry }) => entry.targetKey === persisted.backendTargetKey);
        const stillHonourable = row !== undefined
            && row.eligibility.status === 'eligible'
            && row.entry.providerAgentId === persisted.intent.selection.agentId
            && persisted.intent.sourceAgentId === currentAgentId;
        if (stillHonourable) {
            // A restored arm is not automatically a fresh attempt. If this
            // Session already submitted THIS switch and its effect is still
            // unestablished, the submission identity is retained with it: the
            // daemon dedupes a repeat against the divider derived from that
            // value, so re-minting here is what turned a retry into a second
            // message and a second divider for a switch that may already have
            // happened. A reader who re-armed elsewhere gets a fresh identity,
            // because that is a different switch.
            const submission = readSessionDraftValue(
                accountScope,
                draftSessionId,
                ARMED_AGENT_CONTINUATION_SUBMISSION_FIELD_ID,
            );
            if (
                typeof submission !== 'undefined'
                && JSON.stringify(submission.intent) === JSON.stringify(persisted.intent)
            ) {
                armedLocalIdRef.current = {
                    key: buildArmedContinuationIdentityKey(armScopeKey, persisted),
                    localId: submission.localId,
                };
            }
            setArmed(persisted);
            return;
        }
        clearSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
    }, [
        accountScope,
        armScopeKey,
        armed,
        currentAgentId,
        draftSessionId,
        featureEnabled,
        railDecisionSettled,
        targetRows,
    ]);

    const armedTargetKey = armed?.backendTargetKey ?? null;

    // Each target row keeps its own model/mode/config choice while the picker is
    // open, so walking between Agents does not silently carry one Agent's model on
    // to another. Nothing here is applied until the row's explicit apply.
    const [selectionByTargetKey, setSelectionByTargetKey] = React.useState<
        ReadonlyMap<string, SessionAgentPickerSelection>
    >(() => new Map());
    const readTargetSelection = React.useCallback(
        (targetKey: string): SessionAgentPickerSelection => (
            selectionByTargetKey.get(targetKey) ?? DEFAULT_TARGET_SELECTION
        ),
        [selectionByTargetKey],
    );

    const targetOptions = React.useMemo(() => {
        if (!railOffersRows) return [];
        // A continuation intent has to name the Agent it leaves. The rail decision
        // already proves one exists, but it is latched through a ref now, so the
        // proof is re-established here as a value the nested callbacks can carry.
        const sourceAgentId = currentAgentId;
        if (sourceAgentId === null) return [];
        const eligibilityByTargetKey = new Map(
            targetRows.map(({ entry, eligibility }) => [entry.targetKey, eligibility] as const),
        );
        return buildSessionAgentPickerOptions({
            entries: targetEntries,
            favoriteBackendTargetKeys: params.favoriteBackendTargetKeys ?? [],
            resolvePresentation: (entry) => {
                const eligibility = eligibilityByTargetKey.get(entry.targetKey);
                // A row still being asked about is held in the same restrained
                // treatment as an unavailable one, so nothing can be armed before
                // its machine has answered — and it never claims a reason it lacks.
                if (eligibility === undefined || eligibility.status === 'checking') {
                    return {
                        subtitle: t('session.agentContinuation.checking'),
                        disabled: true,
                        muted: true,
                    };
                }
                // A blocked row is plainly disabled and says nothing in the rail.
                // Its reason is stated once, in the detail pane, for whoever asks
                // — never twice on the same screen.
                if (eligibility.status === 'unavailable') {
                    return { disabled: true, muted: true };
                }
                // No subtitle for the armed row either: a second line wraps in the
                // rail and breaks its rhythm, which is exactly why the running row
                // lost its own. The checkmark carries the choice visually and the
                // accessible name carries it in words — one pattern, both rows.
                return {
                    accessibilityLabel: entry.targetKey === armedTargetKey
                        ? t('session.agentContinuation.armedAccessibilityLabel', { agent: entry.title })
                        : undefined,
                    disabled: false,
                    muted: false,
                };
            },
            resolveBehavior: ({ entry, presentation }) => {
                if (presentation.disabled) {
                    const eligibility = eligibilityByTargetKey.get(entry.targetKey);
                    return {
                        detailTitle: entry.title,
                        detailDescription: eligibility?.status === 'unavailable'
                            ? resolveTargetRowUnavailableText(eligibility, entry.title) ?? undefined
                            : t('session.agentContinuation.checking'),
                    };
                }
                // Choosing this Agent, or one of its models, IS the choice. There is
                // no confirm step: every other model picker in the product commits on
                // selection, and a picker that alone demanded a second tap both broke
                // that consistency and hid its own primary action below the fold.
                // Nothing is sent either way — the choice arms the next message.
                const armWithSelection = (selection: SessionAgentPickerSelection) => {
                    persistArmedContinuation({
                        backendTargetKey: entry.targetKey,
                        // `default` is the absence of a model choice, so there is no
                        // model to name and the composer's chip names the Agent instead.
                        modelLabel: selection.modelId !== 'default' ? selection.modelLabel : null,
                        intent: {
                            v: 1,
                            mode: 'same_session',
                            sourceAgentId,
                            selection: {
                                v: 1,
                                agentId: entry.providerAgentId,
                                // `default` means "use the Agent's own settings", which
                                // is the absence of a choice, not a model named default.
                                ...(selection.modelId !== 'default' ? { modelId: selection.modelId } : {}),
                                ...(selection.sessionModeId !== null
                                    ? { acpSessionModeId: selection.sessionModeId }
                                    : {}),
                                // The wire carries a timestamped override envelope,
                                // not a flat map; its canonical builder owns that
                                // shape and its clock.
                                ...(() => {
                                    const overrides = buildAcpConfigOptionOverridesV1FromConfigOptions({
                                        configOptions: selection.configOverrides,
                                    });
                                    return overrides ? { sessionConfigOptionOverrides: overrides } : {};
                                })(),
                            },
                        },
                    });
                };

                return {
                    detailTitle: t('session.agentContinuation.detailTitle', { agent: entry.title }),
                    // This Agent's own models, thinking tiers and configuration, from
                    // the same owner New Session uses. The continuation meaning rides
                    // the model section's single subtitle line rather than a paragraph
                    // of prose above an empty pane.
                    deferRenderDetailContent: true,
                    deferredDetailContentCacheKey: `session-continuation-engine:${entry.targetKey}`,
                    renderDetailContent: () => buildSessionAgentPickerDetailContent({
                        backendTarget: entry.target,
                        selectedMachineId: params.detail.machineId,
                        capabilityServerId: params.detail.capabilityServerId,
                        cwd: params.detail.cwd,
                        profileId: params.detail.profileId ?? null,
                        settings: params.detail.settings,
                        // The same disclosure, told truthfully for this Session:
                        // an empty transcript has no conversation to carry, so the
                        // line keeps only the half that still holds.
                        modelSummary: params.source.hasConversationToCarry
                            ? t('session.agentContinuation.detailDescription')
                            : t('session.agentContinuation.detailDescriptionEmpty'),
                        selection: readTargetSelection(entry.targetKey),
                        onSelectionChange: (next) => {
                            setSelectionByTargetKey((current) => {
                                const nextMap = new Map(current);
                                nextMap.set(entry.targetKey, next);
                                return nextMap;
                            });
                            // Re-arm rather than announce: the model row's own selected
                            // state is the feedback here, exactly as in every sibling
                            // picker, and re-speaking on each model tap would nag. The
                            // submission identity is derived from the intent, so it
                            // re-mints itself for what is genuinely a different switch.
                            armWithSelection(next);
                        },
                    }),
                    // Fired on deliberate activation of the row — tap, click, Enter or
                    // Space — never on hover or pointer travel.
                    onSelectImmediate: () => {
                        armWithSelection(readTargetSelection(entry.targetKey));
                        // The one thing a vanished confirm step would otherwise cost a
                        // screen-reader user: what just changed, and that nothing was sent.
                        announceAccessibilityMessage(
                            t('session.agentContinuation.announcement', { agent: entry.title }),
                        );
                    },
                    // The row opens its own model list in place; closing here would
                    // make the Agent choice and the model choice two separate trips.
                    closeOnSelectImmediate: false,
                };
            },
        });
    }, [
        armedTargetKey,
        currentAgentId,
        params.detail,
        params.favoriteBackendTargetKeys,
        persistArmedContinuation,
        railOffersRows,
        readTargetSelection,
        targetEntries,
        targetRows,
    ]);

    // An armed row only stays selected while the catalog still offers it, so a target
    // that disappears cannot leave the composer pointing at an Agent that is gone.
    const { agentPickerSelectedOptionId } = useSessionAgentPickerControls({
        options: targetOptions,
        preferredOptionId: armedTargetKey,
    });

    const composeAgentPickerOptions = React.useCallback((
        currentAgentOptions: ReadonlyArray<AgentInputChipPickerOption>,
    ): ReadonlyArray<AgentInputChipPickerOption> => {
        if (targetOptions.length === 0) return currentAgentOptions;
        return [
            ...currentAgentOptions.map((option) => ({
                ...option,
                // One checkmark, on the selection — the same shape every sibling model
                // picker uses. Once the selection MOVES, though, the running Agent is
                // left with nothing at all, and "which Agent is running right now" is a
                // question the send button cannot answer. So this row takes the marker
                // the model list has always drawn beside the Session's applied model:
                // the same glyph, from the same owner, in the checkmark's own slot.
                //
                // No visible subtitle: a second line wrapped and broke the rail's
                // rhythm. A glyph is not an accessible state either, so the fact travels
                // in the accessible name — "Running this Session." against the armed
                // row's "Selected for your next message."
                ...(armedTargetKey !== null
                    ? {
                        statusMarker: (
                            <Icon
                                name={APPLIED_RUNTIME_MARKER_ICON[currentAgentAppliedStatus]}
                                size={APPLIED_RUNTIME_MARKER_RAIL_SIZE}
                                testID="agent-input-chip-picker.running-agent-marker"
                            />
                        ),
                    }
                    : {}),
                accessibilityLabel: t(
                    CURRENT_AGENT_ACCESSIBILITY_LABEL_KEY[currentAgentAppliedStatus],
                    { agent: currentAgentLabel },
                ),
                // Going back to the running Agent is the same gesture as choosing any
                // other one: select its row. That replaces the separate "keep" button,
                // which was the same redundant confirm step as the removed apply — and
                // it composes with whatever the composer's own row already does, rather
                // than displacing it.
                onSelectImmediate: () => {
                    option.onSelectImmediate?.();
                    clearArmedContinuation();
                },
            })),
            ...targetOptions,
        ];
    }, [armedTargetKey, clearArmedContinuation, currentAgentAppliedStatus, currentAgentLabel, targetOptions]);

    return {
        composeAgentPickerOptions,
        agentPickerSelectedOptionId,
        armedContinuation: armed?.intent ?? null,
        armedContinuationLocalId,
        armedContinuationModelLabel: armed?.modelLabel ?? null,
        clearArmedContinuation,
        onAgentPickerIntent: signalAgentPickerIntent,
        onAgentPickerVisibilityChange: setPickerVisible,
    };
}
