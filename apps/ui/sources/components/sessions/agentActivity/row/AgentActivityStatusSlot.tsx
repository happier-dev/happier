import type { AgentActivityStatusV1 } from '@happier-dev/protocol';
import { resolveAgentActivityTone } from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import {
    resolveAgentActivityStatusWord,
    resolveAgentActivityToneStyle,
} from '../presentation/agentActivityToneStyle';
import { AGENT_STATUS_GLYPH_PX } from './agentRowMetrics';

/**
 * The fixed leading column: one mark per status, always in the same place.
 *
 * This is the anchor of the row's scan axis. It replaces a right-aligned status pill whose
 * x-position moved with the title length, three sites that rendered the raw enum as text, and a
 * status→colour switch that reached for `accent.*` while the workflow renderer used `state.*`.
 *
 * **One glyph, one meaning.** No mark appears twice in the table below, because a shared glyph
 * makes two different situations look identical at 16px, which is exactly the size this renders at.
 */

/**
 * Status -> glyph.
 *
 * Three marks differ from the plan's table because the icon registry is a curated allowlist and
 * `circle-dashed` / `clock-countdown` are not in it. Substitutions keep one meaning per glyph:
 * `queued` takes the empty `circle` (nothing has happened yet, in the same circle family as the
 * outcomes), which frees nothing — so `unknown` takes `question`, which states ambiguity better
 * than a bare circle did. `timedOut` takes `timer`, distinct from the danger `x-circle` beside it.
 */
const STATUS_GLYPHS = {
    queued: 'circle',
    starting: 'hourglass',
    /** Only reached under reduced motion; the animated spinner is the normal running mark. */
    running: 'circle-half',
    waiting: 'warning-circle',
    blocked: 'pause-circle',
    succeeded: 'check-circle',
    failed: 'x-circle',
    timedOut: 'timer',
    cancelled: 'stop-circle',
    unknown: 'question',
} as const satisfies Record<AgentActivityStatusV1, IconName>;

export type AgentActivityStatusSlotProps = Readonly<{
    status: AgentActivityStatusV1;
    /** Glyph ink size. The spinner diameter is derived from it, never chosen separately. */
    size?: number;
    /**
     * Freeze the spinner without unmounting it. Mounted-but-offscreen list rows pass `false` so
     * overscan content does not force a browser frame on every refresh tick.
     */
    animationEnabled?: boolean;
    testID?: string;
}>;

export const AgentActivityStatusSlot = React.memo((props: AgentActivityStatusSlotProps) => {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const size = props.size ?? AGENT_STATUS_GLYPH_PX.comfortable;
    const { ink } = resolveAgentActivityToneStyle(resolveAgentActivityTone(props.status), theme);
    const spins = props.status === 'running' && !reducedMotion;

    return (
        <View
            testID={props.testID}
            // The name a read-only row would otherwise lack: an interactive row's own label already
            // carries the status word, but an info row has no label at all, and a coloured glyph is
            // not a name.
            accessibilityLabel={resolveAgentActivityStatusWord(props.status)}
        >
            {spins ? (
                <ActivitySpinner
                    // A glyph draws its circle inset in its em box; a spinner's diameter IS its box.
                    // Matching the raw numbers is the exact bug `iconMatchedSpinnerSize` exists for.
                    size={iconMatchedSpinnerSize(size)}
                    color={ink}
                    animationEnabled={props.animationEnabled}
                />
            ) : (
                <Icon name={STATUS_GLYPHS[props.status]} size={size} color={ink} />
            )}
        </View>
    );
});

AgentActivityStatusSlot.displayName = 'AgentActivityStatusSlot';
