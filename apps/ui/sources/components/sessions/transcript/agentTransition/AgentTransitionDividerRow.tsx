import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { useTranscriptMachineId } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

import type { SessionAgentTransitionDividerV1 } from '@happier-dev/protocol/sessions/agentTransitionDivider';

import { getAgentCore } from '@/agents/catalog/catalog';
import { Icon } from '@/components/ui/icons/Icon';
import { TranscriptSeparatorRow } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { t } from '@/text';

import {
    AgentTransitionDividerTitle,
    buildAgentTransitionTitleParts,
    type AgentTransitionTitleAgent,
} from './AgentTransitionDividerTitle';
import { openAgentTransitionHandedOverContextModal } from './openAgentTransitionHandedOverContextModal';

/**
 * The Agent an id names, as a reader would recognize it.
 *
 * A divider is durable and its ids outlive the catalog: a Session switched to an
 * Agent that has since been removed still has to render truthfully. The raw id
 * is a worse label than a display name but a far better one than nothing, so an
 * unknown id degrades to itself rather than to "Unknown".
 *
 * The machine-qualified presentation owner decides whether a branded mark is
 * current. Passing the durable id for every slot lets that owner degrade an
 * unknown or uninstalled Agent to its neutral mark without inventing a brand.
 */
function resolveAgentSlot(agentId: string): AgentTransitionTitleAgent {
    const core = getAgentCore(agentId);
    return {
        label: core ? formatAgentLikeIdForDisplay(core.id) : agentId,
        markAgentId: agentId,
    };
}

/**
 * The boundary where this Session changed Agent.
 *
 * The divider is stored as an ordinary `type:'message'` agent event so that a
 * reader which predates the feature still shows something truthful. A reader
 * that understands the sidecar owes the user more than that prose: this is a
 * structural boundary in the conversation, and the transcript already has one
 * treatment for structural boundaries. It reuses that treatment — the same rule
 * the fork-lineage divider follows — rather than adding a second one.
 *
 * It is also the only place a reader can ask what actually crossed the boundary,
 * so the chip opens a card that rebuilds it. The chip itself stays a chip: the
 * affordance is one caret, not a second control or a banner, because the row is
 * chrome between messages and must not compete with them.
 */
export function AgentTransitionDividerRow(props: Readonly<{
    divider: SessionAgentTransitionDividerV1;
    /** Absent on hosts that render an event without Session context. */
    sessionId?: string | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const transcriptSource = useSessionTranscriptSource();
    const from = resolveAgentSlot(props.divider.fromAgentId);
    const to = resolveAgentSlot(props.divider.toAgentId);
    // The plain sentence stays the row's accessible name and the card's
    // subtitle: a screen reader is handed no marks, and neither is the modal
    // chrome, so both need the boundary said in words.
    const title = t('session.agentContinuation.dividerTitle', { from: from.label, to: to.label });
    // Rebuilt each render rather than memoized: it is one lookup and a walk over
    // one short sentence, and every input is derived fresh above, so a memo here
    // would key on values that are new objects each time and never hit.
    const titleParts = buildAgentTransitionTitleParts({ from, to });

    const sessionId = typeof props.sessionId === 'string' ? props.sessionId.trim() : '';
    // A PRIMITIVE, not the Session record. This row sits in the transcript, which is
    // rewritten on every chunk of a live turn, and the only thing it needs off the
    // Session is the machine the card will address. A whole-record subscription
    // re-rendered it once per unrelated write (MEASURED; see the sibling
    // `.subscriptionWidth` test); a string compares by value, so it now re-renders
    // exactly when the answer moves.
    const machineId = useTranscriptMachineId();
    const serverId = transcriptSource.serverId;

    // `0` is a recorded cutoff meaning "nothing was carried over" — a fact the
    // card says its own sentence for. It is never absent: the sidecar schema
    // requires a non-negative integer here, so a divider that omits it fails the
    // strict parse and never reaches this row as a divider at all.
    const cutoff = props.divider.sourceCutoffSeqInclusive;

    const handleOpen = React.useCallback(() => {
        if (!sessionId || transcriptSource.navigate === null) return;
        openAgentTransitionHandedOverContextModal({
            sessionId,
            machineId,
            serverId,
            sourceCutoffSeqInclusive: cutoff,
            // Present only on a native return, and the reason the card can show
            // that boundary's away-delta at all: the bound it came from is
            // device-local and the next departure overwrites it, so the divider
            // is the only surviving copy.
            returningAgentLastSeenSeqInclusive: props.divider.returningAgentLastSeenSeqInclusive ?? null,
            sourceAgentId: props.divider.fromAgentId,
            targetAgentId: props.divider.toAgentId,
            boundaryTitle: title,
            // Same-Session boundary, so the jump target is this transcript. The
            // fork divider pushes its PARENT Session's route because its source
            // is a different Session; here a push would stack a duplicate of the
            // screen the reader is already on. The app source navigation adapter
            // preserves that same `jumpSeq` contract by updating the route parameter.
            onJumpToCutoff: cutoff > 0
                ? () => transcriptSource.navigate?.(buildScopedSessionRouteHref({ sessionId, serverId, query: { jumpSeq: cutoff } }))
                : null,
        });
    }, [
        cutoff,
        machineId,
        props.divider.fromAgentId,
        props.divider.returningAgentLastSeenSeqInclusive,
        props.divider.toAgentId,
        transcriptSource,
        serverId,
        sessionId,
        title,
    ]);

    return (
        <TranscriptSeparatorRow
            testID="transcript-agent-transition-divider"
            chipTestID="transcript-agent-transition-divider-chip"
            iconName="arrows-left-right"
            title={title}
            titleContent={(
                <AgentTransitionDividerTitle
                    testID="transcript-agent-transition-divider-title"
                    parts={titleParts}
                    machineId={machineId}
                    serverId={serverId}
                />
            )}
            // Stated even on the inert arm: the label is a run of words and
            // marks, so the sentence has to be carried by the accessible name
            // rather than reassembled from whatever fragments a reader exposes.
            accessibilityLabel={title}
            {...(sessionId && transcriptSource.navigate !== null
                ? {
                    onPress: handleOpen,
                    accessibilityLabel: `${title}. ${t('session.agentContinuation.handedOver.open')}`,
                    rightAccessory: (
                        <View style={styles.affordance}>
                            <Icon name="caret-right" size={12} color={theme.colors.text.tertiary} />
                        </View>
                    ),
                }
                : {})}
        />
    );
}

const styles = StyleSheet.create((_theme) => ({
    affordance: {
        // Optical, not geometric: the caret's ink sits left of its box centre,
        // so it is nudged right to look centred against the chip's end padding.
        paddingLeft: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
