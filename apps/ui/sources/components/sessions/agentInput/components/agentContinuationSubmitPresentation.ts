import { isAgentId } from '@/agents/registry/registryCore';
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

/** Matches the arrow mark this replaces, before the per-Agent optical scale. */
const AGENT_MARK_NOMINAL_SIZE = 18;

export function resolveAgentContinuationSubmitPresentation(input: Readonly<{
    agentId: string;
    agentLabel: string;
}>): AgentContinuationSubmitPresentation {
    const accessibilityLabel = t('session.agentContinuation.sendLabel', { agent: input.agentLabel });
    if (!isAgentId(input.agentId)) {
        return { accessibilityLabel, markAgentId: null, markSize: AGENT_MARK_NOMINAL_SIZE };
    }
    return {
        accessibilityLabel,
        markAgentId: input.agentId,
        markSize: Math.round(AGENT_MARK_NOMINAL_SIZE * getAgentPickerIconScale(input.agentId)),
    };
}
