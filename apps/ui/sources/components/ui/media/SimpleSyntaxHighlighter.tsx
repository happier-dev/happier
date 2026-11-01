import React from 'react';
import { Platform, View, type TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { tokenizeSimpleSyntaxText } from '@/components/ui/code/tokenization/simpleSyntaxTokenizer';
import { Text } from '@/components/ui/text/Text';


interface SimpleSyntaxHighlighterProps {
  code: string;
  language: string | null;
  selectable: boolean;
  wrap?: boolean;
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
}) => {
  const { theme } = useUnistyles();
  const fallback = theme.colors.text.primary ?? '#111';
  const webTextWrapStyle: TextStyle | null = Platform.OS === 'web'
    ? ({ whiteSpace: wrap ? 'pre-wrap' : 'pre', display: wrap ? 'block' : 'inline-block', overflowWrap: wrap ? 'anywhere' : undefined } as unknown as TextStyle)
    : null;

  const tokens = React.useMemo(() => tokenizeSimpleSyntaxText({ text: code, language }), [code, language]);

  return (
    <View style={{ flexShrink: 0, alignSelf: wrap ? 'stretch' : 'flex-start' }}>
      <Text
        selectable={selectable}
        style={[
          {
            fontFamily: Typography.mono().fontFamily,
            fontSize: 14,
            lineHeight: 20,
            flexShrink: 0,
          },
          webTextWrapStyle,
        ]}
      >
        {tokens.map((token, index) => (
          <Text
            key={index}
            selectable={selectable}
            style={{
              color: resolveTokenColor(theme, token.type, fallback),
              fontFamily: Typography.mono().fontFamily,
              fontWeight: token.type === 'keyword' ? '600' : '400',
            }}
          >
            {token.text}
          </Text>
        ))}
      </Text>
    </View>
  );
};
