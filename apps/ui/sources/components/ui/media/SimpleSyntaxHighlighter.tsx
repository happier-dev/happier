import React from 'react';
import { Platform, View, type TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { tokenizeSimpleSyntaxText } from '@/components/ui/code/tokenization/simpleSyntaxTokenizer';
import { Text } from '@/components/ui/text/Text';
import { TextSpan } from '@/components/ui/text/TextSpan';
import { useGlassBackedInk } from '@/components/ui/glass/glassBackedInk';
import { FindHighlightedText, sliceFindRanges } from '@/components/ui/text/FindHighlightedText';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';


interface SimpleSyntaxHighlighterProps {
  code: string;
  language: string | null;
  selectable: boolean;
  /**
   * When true, long lines soft-wrap (`pre-wrap` + `break-word` on web) instead
   * of preserving single-line `pre` layout for horizontal scroll containers.
   * Used by wrapping code blocks (e.g. onboarding command cards, spec §2 /
   * F-W13-1) where the full content must be readable without scrolling.
   */
  wrap?: boolean;
  findRanges?: readonly FindTextRange[];
  /** Defaults to the code-block size (14/20); compact surfaces such as hover cards pass a smaller pair. */
  fontSize?: number;
  lineHeight?: number;
}

function resolveTokenColor(theme: any, tokenType: string, fallback: string): string {
  if (tokenType === 'keyword') return theme.colors.syntax.keyword ?? fallback;
  if (tokenType === 'string') return theme.colors.syntax.string ?? fallback;
  if (tokenType === 'number') return theme.colors.syntax.number ?? fallback;
  if (tokenType === 'comment') return theme.colors.syntax.comment ?? fallback;
  return theme.colors.syntax.default ?? fallback;
}

export const SimpleSyntaxHighlighter: React.FC<SimpleSyntaxHighlighterProps> = ({
  code,
  language,
  selectable,
  wrap = false,
  findRanges,
  fontSize = 14,
  lineHeight = 20,
}) => {
  const { theme } = useUnistyles();
  // Tokens are spans of the line's one app Text: resolve their ink here, once, as that Text resolves its own.
  const ink = useGlassBackedInk();
  const fallback = theme.colors.text.primary ?? '#111';
  const webTextWrapStyle: TextStyle | null = Platform.OS === 'web'
    ? wrap
      ? ({ whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as unknown as TextStyle)
      : ({ whiteSpace: 'pre', display: 'inline-block' } as unknown as TextStyle)
    : null;

  const tokens = React.useMemo(() => tokenizeSimpleSyntaxText({ text: code, language }), [code, language]);
  let offset = 0;

  return (
    <View style={wrap ? { width: '100%' } : { flexShrink: 0, alignSelf: 'flex-start' }}>
      <Text
        selectable={selectable}
        style={[
          {
            fontFamily: Typography.mono().fontFamily,
            fontSize,
            lineHeight,
          },
          wrap ? null : { flexShrink: 0 },
          webTextWrapStyle,
        ]}
      >
        {tokens.map((token, index) => {
          const ranges = sliceFindRanges(findRanges, offset, token.text.length);
          offset += token.text.length;
          return (
          <TextSpan
            key={index}
            style={{
              color: ink(resolveTokenColor(theme, token.type, fallback)),
              fontWeight: token.type === 'keyword' ? '600' : '400',
            }}
          >
            {ranges?.length ? <FindHighlightedText text={token.text} ranges={ranges} selectable={selectable} /> : token.text}
          </TextSpan>
        ); })}
      </Text>
    </View>
  );
};
