import { Children, type ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierStyleProp } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';

export type HappierApprovalPromptTextRender = (input: Readonly<{
  role: 'title' | 'subtitle';
  text: string;
  style: HappierStyleProp;
  numberOfLines?: number;
}>) => ReactNode;

export type HappierApprovalPromptChromeProps = Readonly<{
  title: string;
  subtitle?: string | null;
  titleNumberOfLines?: number;
  subtitleNumberOfLines?: number;
  icon?: ReactNode;
  headerAccessory?: ReactNode;
  chrome?: 'card' | 'inline';
  /** Portable form of the incumbent host View's role vocabulary. */
  accessibilityRole?: 'none' | 'button' | 'togglebutton' | 'link' | 'search' | 'image' | 'keyboardkey'
    | 'text' | 'adjustable' | 'imagebutton' | 'header' | 'summary' | 'alert' | 'checkbox' | 'combobox'
    | 'menu' | 'menubar' | 'menuitem' | 'progressbar' | 'radio' | 'radiogroup' | 'scrollbar' | 'spinbutton'
    | 'switch' | 'tab' | 'tabbar' | 'tablist' | 'timer' | 'list' | 'toolbar';
  children?: ReactNode;
  footer?: ReactNode;
  testID?: string;
  colors: Readonly<{ border: string; surface: string; title: string; subtitle: string }>;
  renderText?: HappierApprovalPromptTextRender;
}>;

const HORIZONTAL_PADDING = 12;
const ICON_SIZE = 18;
const ICON_TEXT_GAP = 6;
const TEXT_COLUMN_START = HORIZONTAL_PADDING + ICON_SIZE + ICON_TEXT_GAP;

const renderDefaultText: HappierApprovalPromptTextRender = (input) => (
  <HappierText style={input.style} numberOfLines={input.numberOfLines}>{input.text}</HappierText>
);

/** One decision-request anatomy. Facts, consent and the decision lifecycle belong to the caller. */
export function HappierApprovalPromptChrome(props: HappierApprovalPromptChromeProps) {
  const renderText = props.renderText ?? renderDefaultText;
  const inline = props.chrome === 'inline';
  const hasBody = Children.toArray(props.children).length > 0;
  return (
    <View testID={props.testID} accessibilityRole={props.accessibilityRole} style={{
      borderRadius: inline ? 0 : 12,
      borderWidth: inline ? 0 : 1,
      borderColor: inline ? 'transparent' : props.colors.border,
      backgroundColor: inline ? 'transparent' : props.colors.surface,
      overflow: 'hidden',
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: ICON_TEXT_GAP,
        paddingHorizontal: HORIZONTAL_PADDING, paddingTop: 12, paddingBottom: 8 }}>
        <View style={{ width: ICON_SIZE, height: ICON_SIZE, alignItems: 'center', justifyContent: 'center' }}>{props.icon}</View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {renderText({ role: 'title', text: props.title, numberOfLines: props.titleNumberOfLines,
            style: { fontSize: 13, fontWeight: '700', color: props.colors.title } })}
          {props.subtitle ? renderText({ role: 'subtitle', text: props.subtitle, numberOfLines: props.subtitleNumberOfLines,
            style: { fontSize: 12, color: props.colors.subtitle } }) : null}
        </View>
        {props.headerAccessory}
      </View>
      {hasBody ? <View style={{ paddingLeft: TEXT_COLUMN_START, paddingRight: HORIZONTAL_PADDING, paddingBottom: 10, gap: 10 }}>{props.children}</View> : null}
      {props.footer ? <View style={{ paddingLeft: TEXT_COLUMN_START, paddingRight: HORIZONTAL_PADDING, paddingBottom: 12 }}>{props.footer}</View> : null}
    </View>
  );
}
