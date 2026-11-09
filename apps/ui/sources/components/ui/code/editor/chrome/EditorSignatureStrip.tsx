import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { LanguageIntelligenceSignatureHelp } from '@happier-dev/protocol/machines/languageIntelligence';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  CODE_EDITOR_BASE_FONT_SIZE,
  CODE_EDITOR_BASE_LINE_HEIGHT,
} from '../codeEditorFontMetrics';

type SignatureHelpSignature =
  LanguageIntelligenceSignatureHelp['signatures'][number];

/**
 * The active signature's label in three runs, the active parameter set apart (LSP: a parameter label is
 * text in the signature or an offset pair). Parameters before the active one fold into an ellipsis: the
 * person has typed them, and the parameter being typed and what follows must stay in the strip's lines.
 */
export function splitSignatureLabel(help: LanguageIntelligenceSignatureHelp) {
  const signature: SignatureHelpSignature | undefined = help.signatures[help.activeSignature ?? 0] ?? help.signatures[0];
  if (!signature) return null;
  const parameter = signature.parameters?.[signature.activeParameter ?? help.activeParameter ?? 0];
  const label = signature.label;
  let range: readonly [number, number] | null = null;
  if (parameter) {
    if (typeof parameter.label === 'string') {
      const at = label.indexOf(parameter.label);
      if (at >= 0) range = [at, at + parameter.label.length];
    } else if (parameter.label[0] <= parameter.label[1] && parameter.label[1] <= label.length) range = parameter.label;
  }
  if (!range) return { before: label, active: '', after: '' };
  const open = label.indexOf('(');
  const folded = open >= 0 && open + 1 < range[0] ? `${label.slice(0, open + 1)}…, ` : label.slice(0, range[0]);
  return { before: folded, active: label.slice(range[0], range[1]), after: label.slice(range[1]) };
}

/**
 * The phone's parameter help (P7-R21): the active signature as one compact strip above the key row, the
 * parameter being typed in primary ink. It holds no state: the editor handle's signature snapshot is the
 * only source, and the engine publishes `null` when the call is edited, left or dismissed.
 */
export function EditorSignatureStrip(
  props: Readonly<{
    help: LanguageIntelligenceSignatureHelp | null;
    testID: string;
  }>,
) {
  const parts = props.help ? splitSignatureLabel(props.help) : null;
  if (!parts) return null;
  return (
    <View
      testID={props.testID}
      accessibilityRole="text"
      style={stylesheet.strip}
    >
      <Text numberOfLines={2} style={stylesheet.label} allowFontScaling={false}>
        {parts.before}
        {parts.active ? (
          <Text
            testID={`${props.testID}-active`}
            style={stylesheet.active}
            allowFontScaling={false}
          >
            {parts.active}
          </Text>
        ) : null}
        {parts.after}
      </Text>
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  strip: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.default,
  },
  label: {
    ...Typography.mono(),
    fontSize: CODE_EDITOR_BASE_FONT_SIZE,
    lineHeight: CODE_EDITOR_BASE_LINE_HEIGHT,
    color: theme.colors.text.secondary,
  },
  active: {
    ...Typography.mono('semiBold'),
    color: theme.colors.text.primary,
  },
}));
