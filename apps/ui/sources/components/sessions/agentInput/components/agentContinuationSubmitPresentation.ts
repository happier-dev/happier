import { isBundledAgentId } from '@/agents/registry/registryCore';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { t } from '@/text';

/**
 * How the composer's send control announces an armed Agent switch.
 *
 * When another Agent is armed, pressing send does not just send — it stops the
 * current runtime and continues this Session with the chosen Agent. That is a
 * consequence worth stating on the control the reader is about to press, rather
 * than only inside a popover they have already dismissed.
 *
 * Every Agent gets its own mark, with no per-Agent exception. The reader has
 * just seen that exact mark beside the Agent's name in the rail, so it is never
 * encountered cold — and a mixed treatment would silently rank Agents as
 * recognisable or not, which reads as unfinished rather than as restraint. An
 * Agent whose mark is weak or missing is a catalog problem to fix there.
 */
export type AgentContinuationSubmitPresentation = Readonly<{
    /**
     * Always the words. The mark is presentation; this sentence is the contract,
     * and it is the only thing a screen reader gets from the control that
     * commits the switch.
     */
    accessibilityLabel: string;
    /**
     * The words as DRAWN: the sentence above with the Agent's name lifted out,
     * because the mark stands in for it.
     *
     * "Continue with Claude" beside the Claude mark says the same thing twice and
     * makes the control as wide as the longest Agent name in the catalog. Drawing
     * "Continue with" and closing it with the mark says it once, in the identity
     * the reader just picked from the rail.
     *
     * This is derived from the accessible sentence rather than written twice, so
     * the two cannot drift: one translation owns both.
     */
    label: string;
    /**
     * Which side of the words this locale's sentence puts the Agent on.
     *
     * English closes with it ("Continue with {Agent}"); Japanese opens with it
     * ("{Agent} で続ける"). The mark goes where the name went, so a pinned side
     * would read as broken grammar in half the languages the app ships.
     */
    markPlacement: 'leading' | 'trailing';
    /**
     * The Agent whose mark to draw, or null when this build's Agent registry does
     * not know the id at all.
     *
     * That is not the per-Agent ranking the rule above forbids: an unknown id has
     * no mark to draw and no catalog entry to fix. It is reachable only from a
     * target this client cannot name, and the switch is still announced in words.
     */
    markAgentId: Parameters<typeof getAgentPickerIconScale>[0] | null;
    /**
     * The mark's size, optically balanced rather than boxed.
     *
     * Agent marks differ in aspect ratio and visual weight — an asterisk, a
     * sparkle, a letter, a bracket pair — so drawing them all at one nominal size
     * makes some look oversized and others shrunken. The Agent registry already
     * owns that per-Agent correction for the picker rail, so this reuses it
     * rather than forking a second sizing path: the mark on the button reads at
     * the weight the reader just saw in the rail.
     */
    markSize: number;
}>;

/** The mark's nominal em box on the send control, before the per-Agent optical scale. */
const AGENT_MARK_NOMINAL_SIZE = 18;

/**
 * Stands in for the Agent's name while the sentence is resolved, so the mark's
 * position can be read off the translation instead of assumed.
 *
 * A control byte cannot appear in a translated string, so the split is exact for
 * any wording a translator writes.
 */
const AGENT_NAME_PROBE = '\u0000';

/**
 * The sentence split at the Agent's name, with the seam whitespace dropped.
 *
 * The gap between the words and the mark is a layout decision — a glyph next to
 * text needs its own optical seam, not whatever space the sentence happened to
 * put before the name — so the button owns it and the words arrive trimmed.
 */
function splitSentenceAtAgentName(sentence: string): Readonly<{ before: string; after: string }> {
    const at = sentence.indexOf(AGENT_NAME_PROBE);
    // Unreachable through any shipped translation: every `sendLabel` interpolates
    // its `agent` parameter. A wording that dropped it has no place to put the
    // mark, so the mark closes the sentence and no words are lost.
    if (at < 0) return { before: sentence.trim(), after: '' };
    return {
        before: sentence.slice(0, at).trim(),
        after: sentence.slice(at + AGENT_NAME_PROBE.length).trim(),
    };
}

/**
 * The Agent the composer is armed with — one decision, read by every surface
 * that shows it.
 *
 * Selection IS the selection, and it is also the arming: the moment a target Agent
 * is chosen the composer's engine chip names it, because there is no confirm step
 * left for the reader to perform. The chip disagreeing with the rail is the
 * reported defect — a picker showing a checkmark on Sonnet 4.6 while the chip
 * still read GPT 5.6 Sol — and so is the chip waiting for a keystroke, which is a
 * confirm step made of typing: the reader picks another Agent, the rail ticks it,
 * and the composer goes on naming the Agent that is running.
 *
 * This is the ONLY place the armed target is decided. `resolveArmedSubmitContinuation`
 * narrows this value rather than deriving a second one, so no two surfaces can
 * name different Agents.
 */
export function resolveArmedComposerContinuation<TTarget>(params: Readonly<{
    armedContinuationTarget: TTarget | null | undefined;
}>): TTarget | null {
    return params.armedContinuationTarget ?? null;
}

/**
 * The armed switch as the SUBMIT CONTROL is allowed to announce it.
 *
 * The same target, under one further condition: the button may name the switch
 * only while this button IS the send. On an empty composer that same control can
 * be Dictation, the microphone or Stop, and "Continue with {Agent}" on any of
 * those would promise something press does not do.
 *
 * An armed continuation itself supplies a send intent on an empty composer.
 * The send owner supplies the default prompt without editing the draft.
 *
 * Narrowing instead of re-deciding is what keeps the pair honest. The button may
 * be silent while the chip names the target — those are answers to two different
 * questions, "what runs next" and "what does this press do" — but it can never
 * name a DIFFERENT Agent than the chip.
 */
export function resolveArmedSubmitContinuation<TTarget>(params: Readonly<{
    armedContinuationTarget: TTarget | null | undefined;
    /**
     * True when some other action — Dictation, the microphone, Stop — currently
     * owns the submit control, so pressing it would not take the switch.
     *
     * The caller owns which actions those are, because that differs by composer;
     * this asks only whether the button is still the send.
     */
    otherActionHoldsSubmit: boolean;
}>): TTarget | null {
    const armed = resolveArmedComposerContinuation(params);
    if (!armed) return null;
    if (params.otherActionHoldsSubmit) return null;
    return armed;
}

export function resolveAgentContinuationSubmitPresentation(input: Readonly<{
    agentId: string;
    agentLabel: string;
    hasIdentityMark?: boolean;
}>): AgentContinuationSubmitPresentation {
    const accessibilityLabel = t('session.agentContinuation.sendLabel', { agent: input.agentLabel });
    if (!isBundledAgentId(input.agentId) && input.hasIdentityMark !== true) {
        // No mark to stand in for the name, so the words keep carrying it. This is
        // the one case where the drawn sentence and the spoken one are the same
        // string — an unknown id has no glyph to substitute.
        return {
            accessibilityLabel,
            label: accessibilityLabel,
            markPlacement: 'trailing',
            markAgentId: null,
            markSize: AGENT_MARK_NOMINAL_SIZE,
        };
    }
    const { before, after } = splitSentenceAtAgentName(
        t('session.agentContinuation.sendLabel', { agent: AGENT_NAME_PROBE }),
    );
    return {
        accessibilityLabel,
        // Every shipped translation names the Agent at one end of this sentence —
        // `agentContinuationSubmitPresentation.test.ts` holds all eleven to that —
        // so exactly one side carries words and joining them cannot reorder them.
        label: [before, after].filter((part) => part.length > 0).join(' '),
        markPlacement: before.length === 0 ? 'leading' : 'trailing',
        markAgentId: isBundledAgentId(input.agentId) ? input.agentId : null,
        markSize: isBundledAgentId(input.agentId)
            ? Math.round(AGENT_MARK_NOMINAL_SIZE * getAgentPickerIconScale(input.agentId))
            : AGENT_MARK_NOMINAL_SIZE,
    };
}

/**
 * A route or model change for the SAME Agent, armed for the next message (D15): either a new source
 * to run through, or only another model from the source it already runs through.
 */
export type ArmedRouteContinuation = Readonly<{ sourceLabel: string; modelLabel?: never } | { modelLabel: string; sourceLabel?: never }>;

/** The words that name what an armed route continuation changes: the new source, or the new model. */
export function readArmedRouteContinuationLabel(armed: ArmedRouteContinuation): string {
    return armed.sourceLabel ?? armed.modelLabel;
}

/**
 * The send control for an armed route or model change (D15).
 *
 * The Agent does not change, so there is no mark to stand in for anything: the
 * words name the source the Session continues through ("Continue via …"), or, when
 * that source stays and only the model changes, the model it continues with
 * ("Continue with …"). The drawn and spoken sentences are one string.
 */
export function resolveRouteContinuationSubmitPresentation(input: ArmedRouteContinuation): AgentContinuationSubmitPresentation {
    const sentence = input.sourceLabel !== undefined
        ? t('session.agentContinuation.routeSendLabel', { source: input.sourceLabel })
        // The same "Continue with …" sentence an Agent switch uses, naming the model that continues.
        : t('session.agentContinuation.sendLabel', { agent: input.modelLabel });
    return {
        accessibilityLabel: sentence,
        label: sentence,
        markPlacement: 'trailing',
        markAgentId: null,
        markSize: AGENT_MARK_NOMINAL_SIZE,
    };
}

/**
 * What the send control announces, when anything is armed: an Agent switch or a
 * route/model change for the running Agent. One decision for both, through the
 * same narrowing, so the button can never announce one while the other applies.
 *
 * An armed Agent wins: its transition carries its own model selection, so a
 * pending route change for the Agent being left would not apply anyway.
 */
export function resolveArmedSubmitPresentation(params: Readonly<{
    armedContinuationTarget: Readonly<{ agentId: string; label: string }> | null | undefined;
    armedRouteContinuation: ArmedRouteContinuation | null | undefined;
    otherActionHoldsSubmit: boolean;
    hasIdentityMark: boolean;
}>): Readonly<
    | { kind: 'agent'; presentation: AgentContinuationSubmitPresentation }
    | { kind: 'route'; presentation: AgentContinuationSubmitPresentation }
> | null {
    const agent = resolveArmedSubmitContinuation({
        armedContinuationTarget: params.armedContinuationTarget,
        otherActionHoldsSubmit: params.otherActionHoldsSubmit,
    });
    if (agent) {
        return {
            kind: 'agent',
            presentation: resolveAgentContinuationSubmitPresentation({
                agentId: agent.agentId,
                agentLabel: agent.label,
                hasIdentityMark: params.hasIdentityMark,
            }),
        };
    }
    const route = resolveArmedSubmitContinuation({
        armedContinuationTarget: params.armedRouteContinuation,
        otherActionHoldsSubmit: params.otherActionHoldsSubmit,
    });
    return route ? { kind: 'route', presentation: resolveRouteContinuationSubmitPresentation(route) } : null;
}
