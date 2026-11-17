import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX, HappierWorkUpdateCard, type HappierWorkUpdateCardProps } from '../work/WorkUpdateCard.js';
import { resolveHappierWorkStatusWordColor, type HappierWorkStatusTone } from '../work/workStatus.js';
import { resolveHappierWorkHost, useHappierWorkTheme } from '../work/workTheme.js';

export type HappierSavedSkillCardProps = Readonly<{
  testID: string;
  name: string;
  description: string | null;
  /** The quiet line under the description: where the skill now lives ("Saved to your skills"). */
  savedLabel: string;
  /** Who uses it, joined to the saved line ("only Release captain uses it"). */
  scopeLabel?: string;
  /** Extra caller content under the saved line. */
  maker?: ReactNode;
  /** The state word in the footer's one state line. */
  status: string;
  /** What the state means, after the word ("Release captain uses it from its next message."). */
  statusDetail?: string;
  /** Only a state that needs the person speaks: `attention` (amber) or `danger` (rose). Healthy stays neutral. */
  statusTone?: HappierWorkStatusTone;
  /** The state's glyph, drawn in the state line's leading column. */
  statusMark?: ReactNode;
  mark?: ReactNode;
  /** The quiet View action at the head's trailing edge. */
  viewControl: ReactNode;
  /** The one repair for a state that needs the person (Restart now, Attach again), at the state line's end. */
  recoveryControl?: ReactNode;
}> & Pick<HappierWorkUpdateCardProps, 'theme' | 'host' | 'renderSurface'>;

/**
 * Narrower than this the state sentence breaks into a ragged column beside its recovery button
 * (phone cards, lab R2 `skills-cardP`), so the line wraps the button beneath the sentence, on its edge.
 */
const STATE_LINE_WRAP_WIDTH_PX = 220;

const styles = StyleSheet.create({
  // The state line keeps the head's leading column: its glyph sits under the skill's mark.
  // The line owns its repair: the sentence takes the row, and the button sits at its end or, narrow, under the sentence.
  stateLine: { flexDirection: 'row', alignItems: 'center', gap: 8, flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 28 },
  stateMark: { flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  stateBody: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 8, flexGrow: 1, flexShrink: 1, minWidth: 0 },
  stateText: { flexGrow: 1, flexShrink: 1, flexBasis: STATE_LINE_WRAP_WIDTH_PX, minWidth: 0 },
  // The description and saved line start on the title's edge, past the head's mark column.
  body: { paddingLeft: HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX + 8, gap: 2 },
});

/**
 * One saved-skill result anatomy for core and live plugin surfaces (bot-templates lab R2 `skills-card`):
 * mark · name · View; the description and one quiet saved line; a footer that always holds exactly one
 * state line, so a change of state swaps its words in place. All facts and effects are host-owned.
 */
export function HappierSavedSkillCard(props: HappierSavedSkillCardProps) {
  const theme = useHappierWorkTheme(props.theme);
  const host = resolveHappierWorkHost(props.host);
  const { Text } = host;
  const tone = props.statusTone ?? 'neutral';
  const wordColor = resolveHappierWorkStatusWordColor(tone, theme.colors);
  const savedLine = props.scopeLabel ? `${props.savedLabel} · ${props.scopeLabel}` : props.savedLabel;
  // The card itself stays quiet in every state (lab R2): only the state word and its glyph take the tone.
  return <HappierWorkUpdateCard testID={props.testID} slotTestIDPrefix="saved-skill" tone="neutral"
    title={props.name} mark={props.mark} meta={props.viewControl} theme={theme} host={host} renderSurface={props.renderSurface}
    leadingAction={<View style={styles.stateLine}>
      {props.statusMark ? <View style={styles.stateMark}>{props.statusMark}</View> : null}
      <View style={styles.stateBody}>
        <Text role="cardWord" testID="saved-skill-status" style={[styles.stateText, { color: theme.colors.secondaryText }]}>
          <Text role="cardWord" strong style={{ color: wordColor ?? theme.colors.text }}>{props.status}</Text>
          {props.statusDetail ? ` · ${props.statusDetail}` : null}
        </Text>
        {props.recoveryControl ?? null}
      </View>
    </View>}>
    <View style={styles.body}>
      {props.description ? <Text role="rowLine" style={{ color: theme.colors.secondaryText }}>{props.description}</Text> : null}
      <Text role="cardFact" testID="saved-skill-saved" style={{ color: theme.colors.mutedText }}>{savedLine}</Text>
      {props.maker}
    </View>
  </HappierWorkUpdateCard>;
}
