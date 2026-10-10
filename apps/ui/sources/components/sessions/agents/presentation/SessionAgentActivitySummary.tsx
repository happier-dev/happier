import * as React from 'react';
import { HappierWorkSummary } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';

import { useAgentActivityClockNow, useWorkRelativeTime } from './agentActivityClock';
import {
    formatAgentActivityElapsed,
    type SessionAgentActivityPresentation,
} from './sessionAgentActivityPresentation';

/**
 * One unit of Session agent work, drawn the same way everywhere (agents lab AG1).
 *
 * Deliberately a LEAF, not a card: it owns the identity block — the Agent's mark with its state in
 * the corner (a live ring while working, an amber dot while it waits on a person), the title, and
 * one line that says where it stands — and nothing else: no surface, no padding, no press
 * behaviour. The roster row, the Details overview card and a conversation's run reference each wrap
 * it in their own geometry.
 *
 * **One line, one loud fact.** The subtitle leads with the fact that matters: what the agent needs
 * from you, how long it has been working (a live clock), or how it ended — in the one work-status
 * treatment, so a timeout asks for attention and a failure reads as trouble here as on every surface.
 * The remaining facts follow quietly. Nothing is a pill: a dense roster of pills cannot be scanned.
 *
 * The leaf's anatomy is the shared `HappierWorkSummary` (`@happier-dev/plugin-ui/presentation`, the
 * owner plugin authors use too); this binding supplies core's Agent mark, activity spinner, live
 * clock, theme and text owner, and decides which fact leads.
 */

const MARK_SIZE = 30;

/** A running clock, re-rendering only itself once a second. */
const ElapsedClock = React.memo((props: Readonly<{ startedAtMs: number; testID?: string }>) => {
    const nowMs = useAgentActivityClockNow();
    return (
        <Text testID={props.testID} style={Typography.tabular()}>
            {formatAgentActivityElapsed(nowMs - props.startedAtMs)}
        </Text>
    );
});

const RelativeClock = React.memo((props: Readonly<{ atMs: number }>) => {
    const value = useWorkRelativeTime(props.atMs);
    return value;
});

export const SessionAgentActivitySummary = React.memo((props: Readonly<{
    presentation: SessionAgentActivityPresentation;
    /** Prefix for this instance's test ids, so a host keeps its existing addressing. */
    testID?: string;
    /** Dates a waiting or finished row at the trailing edge (the roster); detail hosts omit it. */
    showTime?: boolean;
    /**
     * The owner's state word at the trailing edge (Work rows, unified-work lab `session-A`): the row
     * then says where the work stands once, on the right, and the line keeps only its facts.
     */
    trailingState?: Readonly<{ word: string; tone: 'neutral' | 'attention' | 'danger' }>;
    /** Where the title's distinguishing end starts; that end stays whole when the row truncates. */
    titleTailStart?: number;
}>) => {
    const { theme } = useUnistyles();
    const workTheme = useWorkTheme();
    const { presentation, testID } = props;
    const { phase } = presentation;

    // Running is said by the ring and the clock; any other in-progress state (queued, starting,
    // blocked on a dependency) is still named, because the ring alone would claim it is working.
    const trailingState = props.trailingState ?? null;
    const lead = trailingState ? null : phase === 'attention' && presentation.attention
        ? <Text testID={testID ? `${testID}:state:label` : undefined} style={workStatusWordStyle('attention')}>{presentation.attention.label}</Text>
        : phase === 'live' && presentation.statusShownByActivity !== true
            ? <Text testID={testID ? `${testID}:state:label` : undefined}>{presentation.statusLabel}</Text>
            : null;
    const ending = trailingState ? null : (phase === 'finished' || phase === 'idle')
        ? (
            <Text
                testID={testID ? `${testID}:state:label` : undefined}
                style={workStatusWordStyle(presentation.statusTone)}
            >
                {presentation.statusLabel}
            </Text>
        )
        : phase === 'live' && presentation.startedAtMs !== null
            ? <ElapsedClock startedAtMs={presentation.startedAtMs} testID={testID ? `${testID}:elapsed` : undefined} />
            : null;
    const facts: React.ReactNode[] = [];
    if (lead) facts.push(lead);
    for (const fact of presentation.facts) facts.push(fact);
    if (ending) facts.push(ending);
    const trailingTime = props.showTime === true && phase !== 'live' && presentation.atMs !== null
        ? <RelativeClock atMs={presentation.atMs} />
        : null;

    return (
        <HappierWorkSummary
            testID={testID}
            accessibilityLabel={presentation.accessibilityLabel}
            title={presentation.title}
            titleTailStart={props.titleTailStart}
            phase={phase === 'idle' ? 'finished' : phase}
            mark={<ExecutionRunAgentMark agentId={presentation.agentId} iconName={presentation.iconName} size={MARK_SIZE} />}
            liveIndicator={<ActivitySpinner size={9} color={theme.colors.text.secondary} />}
            facts={facts}
            trailingTime={trailingTime}
            trailingState={trailingState}
            theme={workTheme}
            host={WORK_HOST}
        />
    );
});
