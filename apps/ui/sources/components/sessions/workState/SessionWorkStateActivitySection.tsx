import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { AgentActivitySurface } from '@/components/sessions/agentActivity/surface/AgentActivitySurface';
import {
    useAgentActivitySurfaceModel,
    type AgentActivitySurfaceModel,
} from '@/components/sessions/agentActivity/surface/useAgentActivitySurfaceModel';
import { useOpenSessionTarget } from '@/components/sessions/panes/open/useOpenSessionTarget';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

/**
 * Everything this session is working on right now, in the compact surface (§4.6, r4.1).
 *
 * **One model, one composition, two surfaces.** This section and the right-pane Agents roster read
 * the same unified agent-activity model AND draw it with the same `AgentActivitySurface`. Before
 * that they shared only the row: each host decided density, bleed, staleness, ordering, emptiness
 * and pressability for itself, and this is the surface that lost every one of those coin flips —
 * no silence note (so a ten-minutes-dead agent kept a live spinner), no ordering owner at all, 26px
 * of double indent, and no way to open anything, on the only agent surface a phone has.
 *
 * **It is the compact view, so it is bounded and live-only.** A terminal row here would be history
 * competing with the live line the surface exists to state, and the pane is the surface with room
 * for history. Its own overflow expands IN PLACE rather than routing away; the separate lead-in to
 * the full roster is a destination, and it resolves to the Agents pane or the agents screen through
 * the shared open decision rather than to a right pane a phone never draws.
 *
 * **It is a HOOK, not a slot — REVISED r4.2, and this is the fix for two defects at once.** The
 * section used to be mounted unconditionally by its host and answer "did I paint anything?" upward
 * from a post-commit effect. Both consequences followed from deciding presence too late:
 *
 * - the host composed a section that rendered nothing, and its divider rule — a hairline before
 *   every section after the first — drew a hairline for it, because a React element is truthy
 *   whether or not it renders anything. A goal with no live work painted a dangling hairline; a
 *   goal with tasks painted two;
 * - the host's "nothing to show" placeholder initialised to *empty* and was corrected one commit
 *   later, so a session with live work and no goal committed the placeholder and the running rows
 *   together and dropped the placeholder in the next frame.
 *
 * Returning the node — or `null` — during the host's own render makes presence knowable before the
 * host composes anything, so there is nothing to correct afterwards and nothing to report upward.
 *
 * **It runs only while the popover is open**, because both hosts (`SessionWorkStatePopover` and
 * `SessionWorkStateContent`) are themselves mounted only by an open-popover render callback. That
 * is what lets it use the roster variant — which carries the transcript enrichment and the
 * background-task records, and therefore re-derives on every streamed commit — without the composer
 * paying for that subscription while closed (R-11).
 */

/**
 * How many flat rows the compact surface shows before asking.
 *
 * The popover is capped at 520pt and already spends most of it on the goal block and the task list.
 * At `AGENT_ROW_MIN_HEIGHT_PX.readOnly` (32) six rows is 192pt — the largest set that leaves the
 * rest of the surface readable instead of turning it into a scroll tunnel.
 */
const COMPACT_ROW_LIMIT = 6;

/** The horizontal padding the popover body already applies (`useSessionWorkStateGoalController`). */
const COMPACT_HOST_CONTENT_INSET_PX = 14;

const SURFACE_TEST_ID = 'session-work-state-activity';

export type SessionWorkStateActivityOptions = Readonly<{
    sessionId: string;
    /**
     * Opens the expanded monitoring surface. Absent means there is nowhere to go, and then no
     * lead-in renders at all — a control that leads nowhere must not render (A9).
     */
    onOpenFullRoster?: () => void;
    /**
     * Dismisses the surrounding popover once this section has opened something.
     *
     * Leaving a popover anchored over the screen the reader just navigated to — or over the details
     * pane that just took their press — is what makes an overlay feel broken.
     */
    onRequestClose?: () => void;
}>;

/**
 * The live-activity section for a work-state surface, or `null` when this session has no live work.
 *
 * The `null` is the contract: a host slots the result straight into its section list and reads
 * presence off it, so "is there anything running" has one owner and one answer per render.
 */
export function useSessionWorkStateActivitySection(
    options: SessionWorkStateActivityOptions,
): React.ReactNode {
    const { onOpenFullRoster, onRequestClose, sessionId } = options;
    // `liveOnly` is the single difference between this surface and the pane, and it is a parameter
    // of the shared partition rather than a second filter here.
    const model = useAgentActivitySurfaceModel({ sessionId, liveOnly: true });

    if (!model.hasContent) return null;

    return (
        <SessionWorkStateActivitySection
            model={model}
            {...(onOpenFullRoster ? { onOpenFullRoster } : null)}
            {...(onRequestClose ? { onRequestClose } : null)}
        />
    );
}

type SessionWorkStateActivitySectionProps = Readonly<{
    model: AgentActivitySurfaceModel;
    onOpenFullRoster?: () => void;
    onRequestClose?: () => void;
}>;

/**
 * The painted section. It never asks whether it has content — the hook above already answered, and
 * a second opinion here is how the divider bug started.
 */
function SessionWorkStateActivitySection(
    props: SessionWorkStateActivitySectionProps,
): React.ReactElement {
    const { model, onOpenFullRoster, onRequestClose } = props;

    /**
     * Where a press goes — asked, not decided here.
     *
     * This host used to push the full-screen route unconditionally, on the reasoning that a popover
     * anchored to the composer has no pane to open a tab in. It does: a pane scope is addressed by
     * session id, exactly as a transcript file link addresses it, so the same press opens a details
     * tab on a wide layout and a full screen on a phone. That is the behaviour a reader already
     * knows from following a file link out of the transcript, and it is why an imported workflow
     * sidechain — which has no route of its own — is now openable from here at all.
     */
    const openTarget = useOpenSessionTarget({ sessionId: model.sessionId });
    // The popover dismisses itself only when something actually opened: a press that resolved
    // nowhere must leave the reader where they were rather than closing over an unchanged screen.
    const openSubagent = React.useCallback((subagent: SessionSubagent) => {
        if (openTarget({ kind: 'subagent', subagent }, { intent: 'preview' })) onRequestClose?.();
    }, [onRequestClose, openTarget]);
    const openSidechainTranscript = React.useCallback((target: Readonly<{
        sidechainId: string;
        title: string;
    }>) => {
        const opened = openTarget({
            kind: 'transcript',
            scope: { kind: 'sidechain', sessionId: model.sessionId, sidechainId: target.sidechainId },
            title: target.title,
        }, { intent: 'preview' });
        if (opened) onRequestClose?.();
    }, [model.sessionId, onRequestClose, openTarget]);

    return (
        <View style={styles.section} testID="session-work-state-activity-section">
            <Text style={styles.sectionTitle}>{t('session.workState.activity.sectionTitle')}</Text>
            <AgentActivitySurface
                testID={SURFACE_TEST_ID}
                model={model}
                hostContentInsetPx={COMPACT_HOST_CONTENT_INSET_PX}
                workingLimit={COMPACT_ROW_LIMIT}
                // One section by construction (`liveOnly`), and the title above already names it.
                showSectionHeaders={false}
                onOpenSubagent={openSubagent}
                onOpenSidechainTranscript={openSidechainTranscript}
                {...(onRequestClose ? { onNavigateAway: onRequestClose } : null)}
            />
            {onOpenFullRoster ? (
                <Pressable
                    onPress={onOpenFullRoster}
                    accessibilityRole="button"
                    accessibilityLabel={t('session.workState.activity.openFullRoster')}
                    style={styles.moreRow}
                    testID="session-work-state-activity-open-roster"
                    hitSlop={8}
                >
                    <Text style={styles.moreText}>{t('session.workState.activity.openFullRoster')}</Text>
                </Pressable>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    section: {
        // The title and the surface, nothing more. The old `gap: 10` stacked on `Item`'s own
        // padding and on the divider, which is what made these rows read as loose cards in a column
        // rather than as one list.
        gap: 6,
    },
    sectionTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    moreRow: {
        // 40pt, so the compact surface's text affordance still clears a finger.
        minHeight: 40,
        justifyContent: 'center',
    },
    moreText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.link,
    },
}));
