import * as React from 'react';

import {
    buildAcpConfigOptionOverridesV1FromConfigOptions,
    type ComposerAgentContinuationIntentV1,
} from '@happier-dev/protocol';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

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
 */
type ArmedAgentContinuation = Readonly<{
    backendTargetKey: string;
    intent: ComposerAgentContinuationIntentV1;
}>;

type UseInSessionAgentPickerControlsParams = Readonly<{
    sessionId: string;
    /** The Agent running this Session, as the catalog knows it. */
    currentAgentId: string | null;
    currentAgentLabel: string;
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

/** A target Agent starts at its own defaults, exactly as New Session starts it. */
const DEFAULT_TARGET_SELECTION: SessionAgentPickerSelection = {
    modelId: 'default',
    sessionModeId: null,
    configOverrides: {},
};

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
    armedContinuation: ComposerAgentContinuationIntentV1 | null;
    /**
     * The stable localId the submit path must carry for {@link armedContinuation}.
     * Non-null exactly when `armedContinuation` is.
     */
    armedContinuationLocalId: string | null;
    clearArmedContinuation: () => void;
    /**
     * The composer's Agent picker became visible or hidden. Continuation support
     * is inspected on demand, so an unopened picker asks its machine nothing.
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
    const { currentAgentId, currentAgentLabel, entries, featureEnabled, sessionId, source } = params;

    const [armed, setArmed] = React.useState<ArmedAgentContinuation | null>(null);

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

    const inspections = useSessionContinuationInspections({
        sessionId,
        machine: params.machine,
        machinePresence: source.machinePresence,
        targetAgentIds: inspectableTargetAgentIds,
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

    // The rail exists to offer a choice. When nothing in it can be chosen, the
    // composer keeps its pre-existing model picker and shows no Agent rail at all,
    // rather than a list of dead options with a reason repeated down every row. A
    // row still being asked about counts as pending, not refused, so the rail does
    // not flicker away and back while the machine answers.
    const hasSwitchableTarget = targetRows.some((row) => row.eligibility.status !== 'unavailable');

    // Whether the Agent rail is offered at all.
    //
    // A closed gate produces no rail — not a rail of rows stuck on "checking"
    // because nothing was ever asked, and not a rail of disabled rows repeating
    // one fact about the deployment down a list of Agents. Nor does a Session
    // with no other Agent, or one whose every target has been refused.
    //
    // It is resolved once, here, because two things depend on it and they must
    // not disagree: the rows the composer is given, and whether an armed choice
    // is still cancellable.
    const railOffersRows = featureEnabled
        && currentAgentId !== null
        && targetRows.length > 0
        && hasSwitchableTarget;

    // An armed choice belongs to one Session, one running Agent, one open feature
    // gate, and one live rail. If any of them changes underneath the composer the
    // intent is stale and must not silently survive — the submit path reads this
    // value and nothing else, so an arm that outlives a closing gate is the gate
    // bypassed.
    //
    // The rail belongs in that scope because selection IS arming: there is no
    // confirm step, so re-selecting the running Agent's row is the only gesture
    // that cancels, and that row only carries it while the rail is offered. An arm
    // that outlived the rail would be an arm with no way out — the send control
    // still promises "Continue with {Agent}", every ordinary send is re-routed
    // into a transition the machine now refuses, and a refusal deliberately KEEPS
    // the arm, so not even sending clears it. Leaving the Session was the only
    // escape.
    const armScopeKey = `${featureEnabled ? 'on' : 'off'}:${railOffersRows ? 'rail' : 'norail'}:${sessionId} ${source.currentBackendTargetKey ?? ''}`;
    const armScopeKeyRef = React.useRef(armScopeKey);
    if (armScopeKeyRef.current !== armScopeKey) {
        armScopeKeyRef.current = armScopeKey;
        if (armed !== null) {
            setArmed(null);
        }
    }

    const clearArmedContinuation = React.useCallback(() => {
        setArmed(null);
    }, []);

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
    const armedIdentityKey = armed === null
        ? null
        : `${armScopeKey} ${armed.backendTargetKey} ${JSON.stringify(armed.intent)}`;
    const armedLocalIdRef = React.useRef<Readonly<{ key: string; localId: string }> | null>(null);
    if (armedIdentityKey === null) {
        armedLocalIdRef.current = null;
    } else if (armedLocalIdRef.current?.key !== armedIdentityKey) {
        armedLocalIdRef.current = { key: armedIdentityKey, localId: randomUUID() };
    }
    const armedContinuationLocalId = armedLocalIdRef.current?.localId ?? null;

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
                    setArmed({
                        backendTargetKey: entry.targetKey,
                        intent: {
                            v: 1,
                            mode: 'same_session',
                            sourceAgentId: currentAgentId,
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
                        modelSummary: t('session.agentContinuation.detailDescription'),
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
                // One checkmark, on the selection — the same shape every sibling
                // model picker uses. What is *armed* is named by the send button
                // ("Continue with {Agent}") at the moment of consequence, so the
                // picker does not carry a second marker for it.
                //
                // No visible subtitle either: a second line for it wrapped and broke
                // the rail's rhythm. A checkmark is not an accessible state, so the
                // fact still moves into the accessible name rather than being lost.
                accessibilityLabel: t('session.agentContinuation.currentAgentAccessibilityLabel', {
                    agent: currentAgentLabel,
                }),
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
    }, [clearArmedContinuation, currentAgentLabel, targetOptions]);

    return {
        composeAgentPickerOptions,
        agentPickerSelectedOptionId,
        armedContinuation: armed?.intent ?? null,
        armedContinuationLocalId,
        clearArmedContinuation,
        onAgentPickerVisibilityChange: inspections.setDemand,
    };
}
