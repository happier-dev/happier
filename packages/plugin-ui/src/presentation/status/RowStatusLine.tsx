import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

export type HappierRowStatusTone = 'quiet' | 'warn' | 'bad';
export type HappierRowStatusAction = Readonly<{ label: string; onPress: () => unknown; testID?: string }>;
export type HappierRowStatusLineContentProps = Readonly<{
  text: string;
  tone: HappierRowStatusTone;
  /**
   * A quiet mono lead before the outcome (the command a run executes: `yarn lint · Exited with code 1`). It
   * gives way first, so the outcome, the part that changes and the part a failure is read from, stays whole.
   */
  lead?: string | null;
  /**
   * Quiet words between the lead and the outcome that say where the row's subject comes from
   * (`from Acme web setup`). Always quiet, so a failed outcome's tone never reads as the context's.
   */
  context?: string | null;
  /** The row's own mark already shows this state (a run glyph); the line keeps its tone without a dot. */
  marked?: boolean;
  busy?: boolean;
  action?: HappierRowStatusAction | null;
  testID?: string;
  /** Cards may allow two lines; rows default to one. */
  numberOfLines?: number;
}>;
export type HappierRowStatusLineHost = Readonly<{
  colors: Readonly<Record<HappierRowStatusTone, string>>;
  actionGap: number;
  renderText(input: Readonly<{ text: string; numberOfLines: number; mono?: boolean;
    style: Readonly<{ color: string; flexShrink: number; maxWidth?: '100%' }> }>): ReactNode;
  renderBusy(input: Readonly<{ size: number }>): ReactNode;
  renderIndicator(input: Readonly<{ size: number; color: string }>): ReactNode;
  renderAction(action: HappierRowStatusAction): ReactNode;
}>;
export type HappierRowStatusLineProps = HappierRowStatusLineContentProps & Readonly<{ host: HappierRowStatusLineHost }>;

/** Compact row metadata with an optional busy indicator and one inline recovery. */
export function HappierRowStatusLine(props: HappierRowStatusLineProps): ReactElement {
  const color = props.host.colors[props.tone];
  const lead = props.lead || null;
  const context = props.context || null;
  const label = [lead, context, props.text].filter(Boolean).join(' · ');
  const quiet = props.host.colors.quiet;
  const line = (
    <View testID={props.action ? undefined : props.testID} style={LINE_STYLE}
      accessible={!props.action} accessibilityLabel={props.action ? undefined : label}>
      {props.busy ? props.host.renderBusy({ size: 12 }) : null}
      {props.tone !== 'quiet' && !props.marked ? props.host.renderIndicator({ size: 6, color }) : null}
      {lead ? props.host.renderText({ text: lead, numberOfLines: 1, mono: true,
        style: { color: props.host.colors.quiet, flexShrink: 1, maxWidth: '100%' } }) : null}
      {lead && (context || props.text) ? props.host.renderText({ text: ' · ', numberOfLines: 1,
        style: { color: quiet, flexShrink: 0 } }) : null}
      {context ? props.host.renderText({ text: context, numberOfLines: 1, style: { color: quiet, flexShrink: 1, maxWidth: '100%' } }) : null}
      {context && props.text ? props.host.renderText({ text: ' · ', numberOfLines: 1,
        style: { color: quiet, flexShrink: 0 } }) : null}
      {props.text ? props.host.renderText({
        text: props.text,
        numberOfLines: props.numberOfLines ?? 1,
        style: lead || context ? { color, flexShrink: 1, maxWidth: '100%' } : { color, flexShrink: 1 },
      }) : null}
    </View>
  );
  if (!props.action) return line;
  return <View testID={props.testID} style={{ flexDirection: 'row', alignItems: 'center', gap: props.host.actionGap, minWidth: 0 }}>
    {line}
    {props.host.renderAction(props.action)}
  </View>;
}

// A narrow row wraps whole parts onto the next line instead of collapsing the command and its context to a
// glyph to keep the outcome on one line (design review 2026-11-17, L6 at 390): every part stays readable.
const LINE_STYLE = { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2, minWidth: 0, flexShrink: 1 } as const;
