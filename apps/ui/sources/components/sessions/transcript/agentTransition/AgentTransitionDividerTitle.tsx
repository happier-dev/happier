import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import type { AgentId } from '@/agents/registry/registryCore';
import { ICON_LABEL_OPTICAL_NUDGE_STYLE } from '@/components/ui/icons/iconOpticalAlignment';
import { TRANSCRIPT_SEPARATOR_TITLE_TEXT_STYLE } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export const AGENT_TRANSITION_DIVIDER_MARK_TEST_ID_PREFIX = 'transcript-agent-transition-divider-mark-';

/**
 * The mark's layout box: the label's own em box.
 *
 * Fixed, and never the per-Agent optical size. Agent marks differ in aspect
 * ratio and visual weight, and the registry already owns that correction — but
 * it is applied as a TRANSFORM below, which moves ink without moving layout. A
 * mark that changed the box would let the row's height and the sentence's
 * measured width depend on which Agents the boundary happened to name.
 */
const MARK_BOX_SIZE = 12;

/**
 * The seam between two runs, at the label's size.
 *
 * The sentence's own word space is ~3.2pt at 12pt, and the seam spaces are
 * dropped before layout (a trailing space at the end of an inline run is
 * collapsed away on web, so keeping them would glue the words to the marks on
 * one platform and not the other). The run is therefore spaced by layout: 5
 * between runs, which is a word space plus the air a glyph needs that a letter
 * does not, and 4 inside an Agent so its mark binds to its name more tightly
 * than the surrounding words bind to either.
 */
const RUN_GAP = 5;
const AGENT_GAP = 4;

/**
 * Stands in for each Agent's name while the sentence is resolved.
 *
 * The marks' positions are read OFF the translation rather than assumed from
 * the English word order: a locale is free to name the destination first, and a
 * hand-built sentence would then put each mark against the wrong Agent. A
 * control byte cannot appear in a translated string, so the split is exact for
 * any wording a translator writes — the same probe technique the composer's
 * send control uses to place its own mark.
 */
const FROM_PROBE = '\u0000';
const TO_PROBE = '\u0001';

export type AgentTransitionTitleAgent = Readonly<{
    /** The Agent's name, or its raw id when the catalog no longer knows it. */
    label: string;
    /** The id to draw a mark for, or `null` when there is no mark to draw. */
    markAgentId: AgentId | null;
}>;

export type AgentTransitionTitlePart =
    | Readonly<{ kind: 'prose'; text: string }>
    | Readonly<{ kind: 'agent'; agent: AgentTransitionTitleAgent }>;

/**
 * The divider's sentence, split at the two Agent names.
 *
 * A translation that dropped a placeholder would otherwise lose that Agent from
 * the label entirely, which is worse than a sentence with no marks in it — so
 * that case degrades to the plain title rather than to a half-named boundary.
 */
export function buildAgentTransitionTitleParts(params: Readonly<{
    from: AgentTransitionTitleAgent;
    to: AgentTransitionTitleAgent;
}>): readonly AgentTransitionTitlePart[] {
    const probed = t('session.agentContinuation.dividerTitle', { from: FROM_PROBE, to: TO_PROBE });
    if (!probed.includes(FROM_PROBE) || !probed.includes(TO_PROBE)) {
        return [{
            kind: 'prose',
            text: t('session.agentContinuation.dividerTitle', {
                from: params.from.label,
                to: params.to.label,
            }),
        }];
    }

    const parts: AgentTransitionTitlePart[] = [];
    let pending = '';
    const flush = (): void => {
        const text = pending.trim();
        pending = '';
        if (text.length > 0) parts.push({ kind: 'prose', text });
    };
    for (const character of probed) {
        if (character === FROM_PROBE || character === TO_PROBE) {
            flush();
            parts.push({ kind: 'agent', agent: character === FROM_PROBE ? params.from : params.to });
            continue;
        }
        pending += character;
    }
    flush();
    return parts;
}

/**
 * The divider's label, with each Agent's mark set immediately before its name.
 *
 * The mark is what identifies an Agent at a glance — the reader has just chosen
 * one by its mark in the composer's rail — so it belongs against the name it
 * introduces rather than collected at one end of the sentence, where working
 * out which logo went with which Agent is left to the reader.
 *
 * VERTICAL ALIGNMENT is the whole request, so it is not left to the line box. A
 * row centres the mark's box on the label's line box, which reserves descender
 * space the sentence mostly does not use, so a box-centred mark reads high
 * against the ink the eye actually weighs. `ICON_LABEL_OPTICAL_NUDGE_STYLE` is
 * the app's one answer to that — the same nudge the composer's Agent chip and
 * every menu row glyph carry — and it is composed with the registry's per-Agent
 * optical scale exactly as the chip composes them, so a mark here reads at the
 * weight the reader just saw in the rail. A second constant tuned by eye for
 * this one row would be a competing rule for the same problem.
 *
 * WIDTH is a hierarchy decision. The chip cannot always hold the sentence on a
 * phone, and the two Agents are the only part of it that carries information —
 * so the prose yields first and the names survive, instead of the previous
 * single run whose tail ellipsis hid the destination Agent entirely.
 */
export function AgentTransitionDividerTitle(props: Readonly<{
    testID?: string;
    parts: readonly AgentTransitionTitlePart[];
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View style={styles.run} testID={props.testID}>
            {props.parts.map((part, index) => (part.kind === 'prose'
                ? (
                    <Text
                        key={`prose-${index}`}
                        style={[styles.prose, { color: theme.colors.text.secondary }]}
                        numberOfLines={1}
                    >
                        {part.text}
                    </Text>
                )
                : (
                    <View key={`agent-${index}`} style={styles.agent}>
                        {part.agent.markAgentId ? (
                            <View style={styles.markBox}>
                                <AgentIcon
                                    agentId={part.agent.markAgentId}
                                    size={MARK_BOX_SIZE}
                                    style={{
                                        transform: [
                                            { scale: getAgentPickerIconScale(part.agent.markAgentId) },
                                            ...ICON_LABEL_OPTICAL_NUDGE_STYLE.transform,
                                        ],
                                    }}
                                    testID={`${AGENT_TRANSITION_DIVIDER_MARK_TEST_ID_PREFIX}${part.agent.markAgentId}`}
                                />
                            </View>
                        ) : null}
                        <Text
                            style={[styles.name, { color: theme.colors.text.primary }]}
                            numberOfLines={1}
                        >
                            {part.agent.label}
                        </Text>
                    </View>
                )))}
        </View>
    );
}

const styles = StyleSheet.create((_theme) => ({
    run: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        gap: RUN_GAP,
    },
    prose: {
        ...TRANSCRIPT_SEPARATOR_TITLE_TEXT_STYLE,
        minWidth: 0,
        // The prose is the part of the sentence a reader can lose and still know
        // what the boundary is, so it absorbs almost the whole deficit before an
        // Agent's name gives up a single character. Yoga weighs shrink by
        // basis × factor, so the longer clause also yields before the shorter
        // connector — one ellipsis, at the front, where the words are filler.
        flexShrink: 20,
    },
    agent: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        flexShrink: 1,
        gap: AGENT_GAP,
    },
    markBox: {
        width: MARK_BOX_SIZE,
        height: MARK_BOX_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        // A logo is never squeezed: it would stop being recognisable long before
        // it saved the row a useful pixel.
        flexShrink: 0,
    },
    name: {
        ...TRANSCRIPT_SEPARATOR_TITLE_TEXT_STYLE,
        minWidth: 0,
        flexShrink: 1,
    },
}));
