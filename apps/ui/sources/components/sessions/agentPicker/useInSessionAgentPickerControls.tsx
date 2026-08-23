import * as React from 'react';

import {
    buildAcpConfigOptionOverridesV1FromConfigOptions,
    ProviderConnectionIdSchema,
    type FeatureDecision,
    type SessionAgentTransitionSelectionV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import {
    ReportedModelStatusIcon,
    resolveReportedModelStatus,
    type ReportedModelStatus,
} from '@/components/sessions/modelPicker/reportedModelPresentation';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { isHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';

import {
    clearSessionDraftValue,
    flushSessionDraftValues,
    readSessionDraftValue,
    writeSessionDraftValue,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import type {
    SessionArmedAgentContinuation,
    SessionArmedAgentContinuationSubmission,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
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
 * the exact chosen row even when several rows resolve to the same Agent id.
 *
 * Declared once, by the Session draft that persists it, so the live value and the
 * stored value can never drift into two shapes of the same choice.
 */
type ArmedAgentContinuation = SessionArmedAgentContinuation;

const ARMED_AGENT_CONTINUATION_FIELD_ID = 'routing.agentContinuation' as const;

/**
 * The lifetime of one armed choice, as a key. Formed in one place so the value
 * a restore adopts an identity under is the same value the render mints under —
 * two spellings of this would silently re-mint on the very mount the identity
 * has to survive.
 */
function buildArmedContinuationIdentityKey(armScopeKey: string, arm: ArmedAgentContinuation): string {
    return `${armScopeKey} ${arm.backendTargetKey} ${JSON.stringify(arm.intent)}`;
}

function isSameArmedContinuation(
    persisted: ArmedAgentContinuation | undefined,
    expected: ArmedAgentContinuation,
): boolean {
    return persisted?.backendTargetKey === expected.backendTargetKey
        && JSON.stringify(persisted.intent) === JSON.stringify(expected.intent)
        && JSON.stringify(persisted.submission) === JSON.stringify(expected.submission);
}

function isSameArmedContinuationSubmission(
    actual: SessionArmedAgentContinuationSubmission | undefined,
    expected: SessionArmedAgentContinuationSubmission,
): boolean {
    return actual !== undefined && JSON.stringify(actual) === JSON.stringify(expected);
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
    featureDecision: SessionAgentContinuationFeatureDecision;
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

/** The canonical decision's state is enough for this owner to distinguish a real disable from uncertainty. */
export type SessionAgentContinuationFeatureDecision = Readonly<Pick<FeatureDecision, 'state'>> | null;

export type SessionAgentPickerTargetDetailContext = Readonly<{
    settings: Settings;
    capabilityServerId: string;
    /** The Session's machine; null falls back to the Agent catalog's static models. */
    machineId: string | null;
    cwd: string | null;
}>;

/** A target Agent starts at its own defaults, exactly as New Session starts it. */
const DEFAULT_TARGET_SELECTION: SessionAgentPickerSelection = {
    modelId: 'default',
    modelSelection: null,
    modelLabel: null,
    sessionModeId: null,
    configOverrides: {},
};

function buildTargetSelection(
    entry: ResolvedBackendCatalogEntry,
    selection: SessionAgentPickerSelection,
    configUpdatedAt = 0,
): SessionAgentTransitionSelectionV1 {
    const overrides = buildAcpConfigOptionOverridesV1FromConfigOptions({
        configOptions: selection.configOverrides,
        updatedAt: configUpdatedAt,
    });
    return {
        v: 1,
        agentId: entry.agentId,
        ...(selection.modelId !== 'default' ? { modelId: selection.modelId } : {}),
        ...(selection.modelSelection?.ref.providerConnectionId
            ? { providerConnectionId: selection.modelSelection.ref.providerConnectionId }
            : {}),
        ...(selection.sessionModeId !== null ? { acpSessionModeId: selection.sessionModeId } : {}),
        ...(overrides ? { sessionConfigOptionOverrides: overrides } : {}),
    };
}

function projectPersistedArmSelection(arm: ArmedAgentContinuation): SessionAgentPickerSelection {
    const selection = arm.intent.selection;
    const modelId = selection.modelId ?? 'default';
    const modelSelection: SessionModelSelectionV1 | null = selection.modelId
        ? selection.providerConnectionId == null
            ? {
                v: 1,
                // The draft's transition selection is authoritative. This timestamp
                // only satisfies the detail component's local selection shape; it is
                // never written back as a new model decision.
                updatedAt: 0,
                ref: {
                    agentTargetKey: arm.backendTargetKey,
                    providerConnectionId: null,
                    modelId: selection.modelId,
                },
            }
            : {
                v: 1,
                // The draft's transition selection is authoritative. This timestamp
                // only satisfies the detail component's local selection shape; it is
                // never written back as a new model decision.
                updatedAt: 0,
                ref: {
                    agentTargetKey: arm.backendTargetKey,
                    providerConnectionId: ProviderConnectionIdSchema.parse(selection.providerConnectionId),
                    modelId: selection.modelId,
                },
            }
        : null;
    return {
        modelId,
        modelSelection,
        modelLabel: arm.modelLabel ?? null,
        sessionModeId: selection.acpSessionModeId ?? null,
        configOverrides: Object.fromEntries(
            Object.entries(selection.sessionConfigOptionOverrides?.overrides ?? {})
                .flatMap(([configId, override]) => (
                    typeof override?.value === 'string' && override.value.trim().length > 0
                        ? [[configId, override.value.trim()] as const]
                        : []
                )),
        ),
    };
}

function buildArmedContinuation(
    entry: ResolvedBackendCatalogEntry,
    sourceAgentId: string,
    selection: SessionAgentPickerSelection,
): ArmedAgentContinuation {
    return {
        backendTargetKey: entry.backendTargetKey,
        // `default` is the absence of a model choice, so there is no model to
        // name and the composer's chip names the Agent instead.
        modelLabel: selection.modelId !== 'default'
            ? selection.modelLabel ?? null
            : null,
        intent: {
            v: 1,
            mode: 'same_session',
            sourceAgentId,
            // Inspection uses a stable timestamp-free projection. The persisted
            // selection is a real new choice, so its existing canonical builder
            // owns the timestamp on the wire envelope.
            selection: buildTargetSelection(entry, selection, Date.now()),
        },
    };
}

/**
 * How the running Agent's row names itself, per reported-model status.
 *
 * The words carry what the glyph shows, because a glyph reaches no screen reader —
 * and `accessibilityState.selected` maps to `aria-selected`, which `role="button"`
 * silently drops. They are three states rather than one so the row cannot say
 * "Running this Session" beside a clock.
 */
const CURRENT_AGENT_ACCESSIBILITY_LABEL_KEY = {
    running: 'session.agentContinuation.currentAgentAccessibilityLabel',
    last_used: 'session.agentContinuation.currentAgentLastUsedAccessibilityLabel',
    last_reported: 'session.agentContinuation.currentAgentLastReportedAccessibilityLabel',
} as const satisfies Record<ReportedModelStatus, string>;

/** The rail marker stands in the checkmark's slot, so it is the checkmark's size. */
const CURRENT_AGENT_MARKER_SIZE = 14;

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
    /** The pre-dispatch exact input snapshot, if this arm has one. */
    armedContinuationSubmission: ArmedAgentContinuation['submission'] | null;
    /**
     * The submitted snapshot's intent, retained for reconciliation even when the
     * original next-message arm is no longer an eligible promise.
     */
    armedContinuationSubmissionIntent: ArmedAgentContinuation['intent'] | null;
    clearArmedContinuation: () => void;
    /** Clears exactly the persisted submission that canonical custody consumed. */
    clearArmedContinuationSubmissionIfCurrent: (submission: SessionArmedAgentContinuationSubmission) => boolean;
    /**
     * Captures the exact canonical user-message request before the transition
     * RPC leaves this process. The existing arm remains the one persisted owner.
     */
    recordArmedContinuationSubmission: (submission: SessionArmedAgentContinuationSubmission) => boolean;
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
        case 'target_no_sessions':
            return t('session.agentContinuation.unavailable.targetNoSessions', { agent: agentLabel });
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
    const { accountScope, currentAgentId, currentAgentLabel, entries, sessionId, source } = params;
    const featureEnabled = params.featureDecision?.state === 'enabled';
    const featureDefinitelyDisabled = params.featureDecision?.state === 'disabled';
    const accountScopeKey = accountScope ? serverAccountScopeKeySuffix(accountScope) : 'local';

    const currentAgentReportedStatus = resolveReportedModelStatus(params.currentAgentSessionActive);
    // Read once per mount rather than at module evaluation: this file is reached
    // from the session shell, and importing it must not touch `window`.
    const pointerCanSignalIntent = React.useMemo(() => isHoverCapablePrimaryPointer(), []);
    // Whether the reader has reached for the Agent chip on this Session yet.
    // One-way: an answer is cached for the whole connection, so there is nothing to
    // give back by forgetting the intent that bought it.
    const [pickerApproached, setPickerApproached] = React.useState(false);
    const signalAgentPickerIntent = React.useCallback(() => {
        setPickerApproached((current) => (current ? current : true));
    }, []);

    const [armed, setArmed] = React.useState<ArmedAgentContinuation | null>(null);
    const draftSessionId = sessionId.trim().length > 0 ? sessionId.trim() : null;
    const persistedArmedContinuation = draftSessionId === null
        ? undefined
        : readSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
    // A submitted input remains custody even after the arm that promised a
    // next-message transition loses eligibility. It remains in the one existing
    // draft record until SessionView has reconciled canonical custody.
    const retainedSubmissionArm = armed === null && persistedArmedContinuation?.submission !== undefined
        ? persistedArmedContinuation
        : null;
    const submissionArm = armed?.submission !== undefined
        ? armed
        : retainedSubmissionArm;

    // The armed Agent is written straight through to the Session draft that already
    // holds the message it belongs to, so both halves of one composer decision have
    // one lifetime. Arming is a deliberate, rare gesture rather than a keystroke, so
    // it is flushed immediately: the reader may leave the screen in the next frame.
    const persistArmedContinuation = React.useCallback((next: ArmedAgentContinuation | null) => {
        if (draftSessionId === null) {
            setArmed(next);
            return;
        }
        if (next === null) {
            const persisted = readSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
            if (persisted?.submission !== undefined) {
                setArmed(null);
                return;
            }
            setArmed(null);
            clearSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
        } else {
            setArmed(next);
            writeSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID, next);
        }
        flushSessionDraftValues(accountScope);
    }, [accountScope, draftSessionId]);
    // Whether the composer's Agent picker is on screen. Its only job is to scope
    // the rail decision below to one open popover.
    const [pickerVisible, setPickerVisible] = React.useState(false);

    // A Session the reader already armed HAS been approached — in an earlier mount,
    // with the choice carried across it by the draft. Demanding the gesture again
    // would leave the composer promising "Continue with {Agent}" while the rail it
    // depends on is still undecided, so the persisted arm is its own intent signal.
    const hasPersistedArmedContinuation = persistedArmedContinuation !== undefined;

    const targetEntries = React.useMemo(() => entries.filter((entry) => (
        entry.backendTargetKey !== source.currentBackendTargetKey
    )), [entries, source.currentBackendTargetKey]);

    // This is the existing picker/authoring selection owner. A restored arm
    // projects into it so the detail pane continues to show the exact model,
    // provider, mode and config choice the draft will send.
    const [selectionByTargetKey, setSelectionByTargetKey] = React.useState<
        ReadonlyMap<string, SessionAgentPickerSelection>
    >(() => new Map());
    const readTargetSelection = React.useCallback(
        (backendTargetKey: string): SessionAgentPickerSelection => (
            selectionByTargetKey.get(backendTargetKey) ?? DEFAULT_TARGET_SELECTION
        ),
        [selectionByTargetKey],
    );
    const targetSelectionByTargetKey = React.useMemo(() => new Map(
        targetEntries.map((entry) => [
            entry.backendTargetKey,
            buildTargetSelection(entry, readTargetSelection(entry.backendTargetKey)),
        ] as const),
    ), [readTargetSelection, targetEntries]);

    // A Session that cannot continue with any Agent asks its machine nothing, and
    // everything else the local rules already reject — a target that cannot host a
    // Session, an unproven ACP target — is decided here for free.
    const sessionReason = resolveSessionAgentContinuationSessionReason(source);
    const inspectableTargetSelections = React.useMemo(() => (
        sessionReason === null && featureEnabled
            ? targetEntries
                .filter((entry) => entry.kind === 'builtInAgent' && entry.capabilities?.session?.supported !== false)
                .map((entry) => targetSelectionByTargetKey.get(entry.backendTargetKey))
                .filter((selection): selection is SessionAgentTransitionSelectionV1 => selection !== undefined)
            : []
    ), [featureEnabled, sessionReason, targetEntries, targetSelectionByTargetKey]);

    // The rail decision has to be settled BEFORE the popover paints, or the
    // popover opens at one width and then grows by the width of the rail. That is
    // the same defect as a rail appearing and vanishing, seen as geometry.
    //
    // Asking when the popover opens is structurally too late: the machine round
    // trip and the popover's own mount take about the same time, so which one
    // wins is a coin flip, and the reader sees the loser. The question is
    // therefore asked as soon as the rail is a live possibility for this Session.
    //
    // It is still not asked for every Session. `inspectableTargetSelections` is
    // already empty for a closed gate, a read-only or external Session and one
    // with no other Agent; the inspection hook itself never calls a machine it
    // knows is offline; and one answer serves the whole realtime connection.
    const inspections = useSessionContinuationInspections({
        sessionId,
        machine: params.machine,
        machinePresence: source.machinePresence,
        targetSelections: inspectableTargetSelections,
        // Asked on APPROACH where a pointer can announce one. A mouse has to travel
        // over the Agent chip to click it and a keyboard has to focus it, which is a
        // real head start; where the primary pointer can give none — a finger —
        // the question falls back to being asked as soon as the rail is a live
        // possibility, because a rail arriving after the popover has painted is a
        // worse outcome than an early ask.
        demanded: inspectableTargetSelections.length > 0
            && (pickerApproached || hasPersistedArmedContinuation || !pointerCanSignalIntent),
    });
    const readInspection = inspections.read;

    const targetRows = React.useMemo<readonly SessionAgentPickerTargetRow[]>(() => (
        targetEntries.map((entry) => ({
            entry,
            eligibility: resolveSessionAgentContinuationEligibility({
                entry,
                source,
                inspection: readInspection(targetSelectionByTargetKey.get(entry.backendTargetKey)
                    ?? buildTargetSelection(entry, DEFAULT_TARGET_SELECTION)),
            }),
        }))
    ), [readInspection, source, targetEntries, targetSelectionByTargetKey]);

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
    // The first visible render decides the whole open. A cached positive answer
    // therefore opens with the rail, while an unresolved answer opens without it
    // and cannot inject a new column after the reader has started navigating.
    //
    // While the picker is closed the live value is used directly: nothing is on
    // screen to disturb, and the next open must start from the truth.
    const railLatchRef = React.useRef<Readonly<{ open: boolean; decided: boolean | null }>>(
        { open: false, decided: null },
    );
    const railOffersRows = pickerVisible
        ? railLatchRef.current.decided === true
        : railOffersRowsNow;
    const onAgentPickerVisibilityChange = React.useCallback((visible: boolean) => {
        // The visibility event, rather than a later render, defines a popover's
        // semantic start. A close and reopen batched by React must therefore
        // take a fresh snapshot instead of carrying the prior open's geometry.
        if (railLatchRef.current.open !== visible) {
            railLatchRef.current = {
                open: visible,
                decided: visible ? railOffersRowsNow : null,
            };
        }
        setPickerVisible(visible);
    }, [railOffersRowsNow]);

    // UI rail visibility and arm validity deliberately diverge during a fresh
    // inspection. A changed runtime pair turns every cached answer into
    // `checking`; that is not proof an existing choice is stale. Preserve an arm
    // until the replacement inspection settles, then keep it only when the rail
    // can still offer its cancellation gesture.
    // An unresolved feature decision fails closed for presentation, but it is
    // not evidence that an existing persisted choice is stale. Only the
    // canonical decision's definite disabled state clears it.
    const armMayRemain = !featureDefinitelyDisabled
        && (!featureEnabled || !railDecisionSettled || railOffersRows);

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
    const armScopeKey = `${accountScopeKey}\u0000${featureDefinitelyDisabled ? 'disabled' : 'not-disabled'}:${armMayRemain ? 'rail' : 'norail'}:${sessionId}\u0000${source.currentBackendTargetKey ?? ''}`;
    const armScopeRef = React.useRef({ key: armScopeKey, accountScope });
    // A render may not write to storage, so the invalidation records the fact and
    // the reconciler below compare-clears the old scope's persisted half with
    // the live one. It must never write into the newly active Account scope.
    const invalidatedArmRef = React.useRef<Readonly<{
        accountScope: ServerAccountScope | null;
        arm: ArmedAgentContinuation;
    }> | null>(null);
    if (armScopeRef.current.key !== armScopeKey) {
        const previousScope = armScopeRef.current;
        armScopeRef.current = { key: armScopeKey, accountScope };
        if (armed !== null) {
            setArmed(null);
            invalidatedArmRef.current = { accountScope: previousScope.accountScope, arm: armed };
        }
    }

    const clearArmedContinuation = React.useCallback(() => {
        persistArmedContinuation(null);
    }, [persistArmedContinuation]);

    const clearArmedContinuationSubmissionIfCurrent = React.useCallback((
        expected: SessionArmedAgentContinuationSubmission,
    ): boolean => {
        if (draftSessionId === null) {
            return isSameArmedContinuationSubmission(armed?.submission, expected);
        }
        const persisted = readSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
        if (!isSameArmedContinuationSubmission(persisted?.submission, expected)) return false;
        clearSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
        flushSessionDraftValues(accountScope);
        return true;
    }, [accountScope, armed?.submission, draftSessionId]);

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
    // It identifies the transition. An edited composer keeps this localId, but
    // its first exact wire input is retained inside the arm and reused on retry;
    // localId alone is not a differing-content guard at the server boundary.
    const armedIdentityKey = armed === null ? null : buildArmedContinuationIdentityKey(armScopeKey, armed);
    const armedLocalIdRef = React.useRef<Readonly<{ key: string; localId: string }> | null>(null);
    if (armedIdentityKey === null) {
        armedLocalIdRef.current = null;
    } else if (armedLocalIdRef.current?.key !== armedIdentityKey) {
        armedLocalIdRef.current = { key: armedIdentityKey, localId: randomUUID() };
    }
    const armedContinuationLocalId = armedLocalIdRef.current?.localId ?? null;

    const recordArmedContinuationSubmission = React.useCallback((submission: SessionArmedAgentContinuationSubmission): boolean => {
        if (!featureEnabled || armed === null) return false;
        if (armedLocalIdRef.current?.localId !== submission.localId) return false;
        // A localId identifies one logical transition. If an indeterminate call
        // is retried after the composer changes, preserve the FIRST exact
        // snapshot: a later retry dispatches that first input, and replacing its
        // currentness fence would clear the newer draft for the wrong message.
        if (armed.submission !== undefined) return true;
        persistArmedContinuation({
            ...armed,
            submission,
        });
        return true;
    }, [armed, featureEnabled, persistArmedContinuation]);

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
    const reconciledArmScopeKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (draftSessionId === null) return;

        const invalidation = invalidatedArmRef.current;
        if (invalidation !== null) {
            invalidatedArmRef.current = null;
            reconciledArmScopeKeyRef.current = armScopeKey;
            const persisted = readSessionDraftValue(
                invalidation.accountScope,
                draftSessionId,
                ARMED_AGENT_CONTINUATION_FIELD_ID,
            );
            if (isSameArmedContinuation(persisted, invalidation.arm) && persisted?.submission === undefined) {
                clearSessionDraftValue(
                    invalidation.accountScope,
                    draftSessionId,
                    ARMED_AGENT_CONTINUATION_FIELD_ID,
                );
                flushSessionDraftValues(invalidation.accountScope);
            }
            return;
        }

        if (featureDefinitelyDisabled) {
            reconciledArmScopeKeyRef.current = armScopeKey;
            const persisted = readSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
            if (persisted?.submission === undefined && typeof persisted !== 'undefined') {
                clearSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
                flushSessionDraftValues(accountScope);
            }
            return;
        }

        if (reconciledArmScopeKeyRef.current === armScopeKey) return;
        if (!featureEnabled || !railDecisionSettled || currentAgentId === null) return;
        if (armed !== null) return;

        const persisted = readSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
        if (typeof persisted === 'undefined') return;

        const persistedTargetSelection = projectPersistedArmSelection(persisted);
        const inspectedSelection = targetSelectionByTargetKey.get(persisted.backendTargetKey);
        const entryForPersistedArm = targetEntries.find((entry) => entry.backendTargetKey === persisted.backendTargetKey);
        if (
            entryForPersistedArm !== undefined
            && JSON.stringify(inspectedSelection) !== JSON.stringify(buildTargetSelection(entryForPersistedArm, persistedTargetSelection))
        ) {
            setSelectionByTargetKey((current) => {
                const next = new Map(current);
                next.set(persisted.backendTargetKey, persistedTargetSelection);
                return next;
            });
            return;
        }

        const row = targetRows.find(({ entry }) => entry.backendTargetKey === persisted.backendTargetKey);
        const stillHonourable = row !== undefined
            && row.eligibility.status === 'eligible'
            && row.entry.agentId === persisted.intent.selection.agentId
            && persisted.intent.sourceAgentId === currentAgentId;
        if (stillHonourable) {
            if (persisted.submission) {
                armedLocalIdRef.current = {
                    key: buildArmedContinuationIdentityKey(armScopeKey, persisted),
                    localId: persisted.submission.localId,
                };
            }
            reconciledArmScopeKeyRef.current = armScopeKey;
            setArmed(persisted);
            return;
        }
        reconciledArmScopeKeyRef.current = armScopeKey;
        if (persisted.submission === undefined) {
            clearSessionDraftValue(accountScope, draftSessionId, ARMED_AGENT_CONTINUATION_FIELD_ID);
            flushSessionDraftValues(accountScope);
        }
    }, [
        accountScope,
        armScopeKey,
        armed,
        currentAgentId,
        draftSessionId,
        featureEnabled,
        featureDefinitelyDisabled,
        railDecisionSettled,
        targetEntries,
        targetRows,
        targetSelectionByTargetKey,
    ]);

    const armedTargetKey = featureEnabled ? armed?.backendTargetKey ?? null : null;

    // A target detail choice may change model, provider connection, mode or
    // configuration. It is not armable until the inspection has answered for
    // that exact full selection; the existing picker selection remains the
    // authority while this tiny pending reference waits for that answer.
    const pendingArmRef = React.useRef<Readonly<{
        backendTargetKey: string;
        sourceAgentId: string;
        selection: SessionAgentPickerSelection;
    }> | null>(null);

    const armExactSelection = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        sourceAgentId: string,
        selection: SessionAgentPickerSelection,
    ) => {
        const eligibility = resolveSessionAgentContinuationEligibility({
            entry,
            source,
            inspection: readInspection(buildTargetSelection(entry, selection)),
        });
        if (eligibility.status === 'eligible') {
            pendingArmRef.current = null;
            persistArmedContinuation(buildArmedContinuation(entry, sourceAgentId, selection));
            return;
        }
        // Changing a selected target's configuration invalidates the former
        // exact choice. Hold no arm while the new complete selection is being
        // inspected; an answered refusal simply leaves it clear.
        persistArmedContinuation(null);
        pendingArmRef.current = eligibility.status === 'checking'
            ? { backendTargetKey: entry.backendTargetKey, sourceAgentId, selection }
            : null;
    }, [persistArmedContinuation, readInspection, source]);

    React.useEffect(() => {
        const pending = pendingArmRef.current;
        if (pending === null) return;
        if (!featureEnabled || currentAgentId !== pending.sourceAgentId) {
            pendingArmRef.current = null;
            return;
        }
        const entry = targetEntries.find((candidate) => candidate.backendTargetKey === pending.backendTargetKey);
        if (!entry || JSON.stringify(readTargetSelection(entry.backendTargetKey)) !== JSON.stringify(pending.selection)) {
            pendingArmRef.current = null;
            return;
        }
        const eligibility = resolveSessionAgentContinuationEligibility({
            entry,
            source,
            inspection: readInspection(buildTargetSelection(entry, pending.selection)),
        });
        if (eligibility.status === 'checking') return;
        pendingArmRef.current = null;
        if (eligibility.status === 'eligible') {
            persistArmedContinuation(buildArmedContinuation(entry, pending.sourceAgentId, pending.selection));
        }
    }, [currentAgentId, featureEnabled, persistArmedContinuation, readInspection, readTargetSelection, source, targetEntries]);

    const targetOptions = React.useMemo(() => {
        // A retained submitted snapshot is already in custody reconciliation. It
        // is not a next-message arm, and offering another one before the existing
        // localId is spent could overwrite the only retry identity.
        if (!featureEnabled || !railOffersRows || retainedSubmissionArm !== null) return [];
        // A continuation intent has to name the Agent it leaves. The rail decision
        // already proves one exists, but it is latched through a ref now, so the
        // proof is re-established here as a value the nested callbacks can carry.
        const sourceAgentId = currentAgentId;
        if (sourceAgentId === null) return [];
        const eligibilityByTargetKey = new Map(
            targetRows.map(({ entry, eligibility }) => [entry.backendTargetKey, eligibility] as const),
        );
        return buildSessionAgentPickerOptions({
            entries: targetEntries,
            favoriteBackendTargetKeys: params.favoriteBackendTargetKeys ?? [],
            resolvePresentation: (entry) => {
                const eligibility = eligibilityByTargetKey.get(entry.backendTargetKey);
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
                    accessibilityLabel: entry.backendTargetKey === armedTargetKey
                        ? t('session.agentContinuation.armedAccessibilityLabel', { agent: entry.title })
                        : undefined,
                    disabled: false,
                    muted: false,
                };
            },
            resolveBehavior: ({ entry, presentation }) => {
                if (presentation.disabled) {
                    const eligibility = eligibilityByTargetKey.get(entry.backendTargetKey);
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
                return {
                    detailTitle: t('session.agentContinuation.detailTitle', { agent: entry.title }),
                    // This Agent's own models, thinking tiers and configuration, from
                    // the same owner New Session uses. The continuation meaning rides
                    // the model section's single subtitle line rather than a paragraph
                    // of prose above an empty pane.
                    deferRenderDetailContent: true,
                    deferredDetailContentCacheKey: `session-continuation-engine:${entry.backendTargetKey}`,
                    renderDetailContent: () => buildSessionAgentPickerDetailContent({
                        backendTarget: entry.backendTarget,
                        runtimeCarrierAgentId: entry.agentId as never,
                        selectedMachineId: params.detail.machineId,
                        capabilityServerId: params.detail.capabilityServerId,
                        cwd: params.detail.cwd,
                        settings: params.detail.settings,
                        // The same disclosure, told truthfully for this Session:
                        // an empty transcript has no conversation to carry, so the
                        // line keeps only the half that still holds.
                        modelSummary: params.source.hasConversationToCarry
                            ? t('session.agentContinuation.detailDescription')
                            : t('session.agentContinuation.detailDescriptionEmpty'),
                        selection: readTargetSelection(entry.backendTargetKey),
                        onSelectionChange: (next) => {
                            setSelectionByTargetKey((current) => {
                                const nextMap = new Map(current);
                                nextMap.set(entry.backendTargetKey, next);
                                return nextMap;
                            });
                            // Re-arm rather than announce: the model row's own selected
                            // state is the feedback here, exactly as in every sibling
                            // picker, and re-speaking on each model tap would nag. The
                            // submission identity is derived from the intent, so it
                            // re-mints itself for what is genuinely a different switch.
                            armExactSelection(entry, sourceAgentId, next);
                        },
                    }),
                    // Fired on deliberate activation of the row — tap, click, Enter or
                    // Space — never on hover or pointer travel.
                    onSelectImmediate: () => {
                        armExactSelection(entry, sourceAgentId, readTargetSelection(entry.backendTargetKey));
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
        featureEnabled,
        params.detail,
        params.favoriteBackendTargetKeys,
        armExactSelection,
        railOffersRows,
        readTargetSelection,
        retainedSubmissionArm,
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
                            <ReportedModelStatusIcon
                                status={currentAgentReportedStatus}
                                size={CURRENT_AGENT_MARKER_SIZE}
                                testID="agent-input-chip-picker.running-agent-marker"
                            />
                        ),
                    }
                    : {}),
                accessibilityLabel: t(
                    CURRENT_AGENT_ACCESSIBILITY_LABEL_KEY[currentAgentReportedStatus],
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
    }, [
        armedTargetKey,
        clearArmedContinuation,
        currentAgentLabel,
        currentAgentReportedStatus,
        targetOptions,
    ]);

    return {
        composeAgentPickerOptions,
        agentPickerSelectedOptionId,
        armedContinuation: featureEnabled ? armed?.intent ?? null : null,
        armedContinuationLocalId: featureEnabled ? armedContinuationLocalId : null,
        armedContinuationModelLabel: featureEnabled ? armed?.modelLabel ?? null : null,
        armedContinuationSubmission: submissionArm?.submission ?? null,
        armedContinuationSubmissionIntent: submissionArm?.intent ?? null,
        clearArmedContinuation,
        clearArmedContinuationSubmissionIfCurrent,
        recordArmedContinuationSubmission,
        onAgentPickerIntent: signalAgentPickerIntent,
        onAgentPickerVisibilityChange,
    };
}
