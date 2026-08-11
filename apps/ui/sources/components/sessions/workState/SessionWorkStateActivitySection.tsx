import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { AgentActivitySurface } from '@/components/sessions/agentActivity/surface/AgentActivitySurface';
import {
    useAgentActivitySurfaceModel,
    type AgentActivitySurfaceModel,
} from '@/components/sessions/agentActivity/surface/useAgentActivitySurfaceModel';
import { resolveSessionSubagentFullRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentFullRoute';
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
 * for history. Overflow expands IN PLACE rather than routing away: the right pane is structurally
 * hidden on every phone, so an affordance that only routed there would be a dead control.
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
     * Dismisses the surrounding popover before this section routes away.
     *
     * A press here pushes a full-screen route rather than opening a details tab, because a popover
     * anchored to the composer has no pane scope to open one in — and leaving it anchored over the
     * screen the reader just navigated to is what makes an overlay feel broken.
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
    const router = useRouter();

    /**
     * Where a press goes, which is the one thing this host still owns.
     *
     * The full-screen route, on every device: the pane upgrades a press to a details tab because it
     * has a pane scope, and this surface is drawn inside a popover that has none. It is the same
     * destination — the subagent's own transcript — reached the way a phone already reaches it,
     * which matters because this popover is the ONLY agent surface a phone has.
     */
    const openSubagent = React.useCallback((subagent: SessionSubagent) => {
        const route = resolveSessionSubagentFullRoute({ sessionId: model.sessionId, subagent });
        if (!route) return;
        onRequestClose?.();
        router.push(route as never);
    }, [model.sessionId, onRequestClose, router]);

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
