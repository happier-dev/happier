import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

export type HappierRowStatusTone = 'quiet' | 'warn' | 'bad';
export type HappierRowStatusAction = Readonly<{ label: string; onPress: () => unknown; testID?: string }>;
export type HappierRowStatusLineContentProps = Readonly<{
  text: string;
  tone: HappierRowStatusTone;
  busy?: boolean;
  action?: HappierRowStatusAction | null;
  testID?: string;
  /** Cards may allow two lines; rows default to one. */
  numberOfLines?: number;
}>;
export type HappierRowStatusLineHost = Readonly<{
  colors: Readonly<Record<HappierRowStatusTone, string>>;
  actionGap: number;
  renderText(input: Readonly<{ text: string; numberOfLines: number; style: Readonly<{ color: string; flexShrink: number }> }>): ReactNode;
  renderBusy(input: Readonly<{ size: number }>): ReactNode;
  renderIndicator(input: Readonly<{ size: number; color: string }>): ReactNode;
  renderAction(action: HappierRowStatusAction): ReactNode;
}>;
export type HappierRowStatusLineProps = HappierRowStatusLineContentProps & Readonly<{ host: HappierRowStatusLineHost }>;

/** Compact row metadata with an optional busy indicator and one inline recovery. */
export function HappierRowStatusLine(props: HappierRowStatusLineProps): ReactElement {
  const color = props.host.colors[props.tone];
  const line = (
    <View testID={props.action ? undefined : props.testID} style={LINE_STYLE}
      accessible={!props.action} accessibilityLabel={props.action ? undefined : props.text}>
      {props.busy ? props.host.renderBusy({ size: 12 }) : null}
      {props.tone !== 'quiet' ? props.host.renderIndicator({ size: 6, color }) : null}
      {props.host.renderText({
        text: props.text,
        numberOfLines: props.numberOfLines ?? 1,
        style: { color, flexShrink: 1 },
      })}
    </View>
  );
  if (!props.action) return line;
  return <View testID={props.testID} style={{ flexDirection: 'row', alignItems: 'center', gap: props.host.actionGap, minWidth: 0 }}>
    {line}
    {props.host.renderAction(props.action)}
  </View>;
}

const LINE_STYLE = { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1 } as const;
