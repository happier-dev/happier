import React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { tokenizeSimpleSyntaxText } from '@/components/ui/code/tokenization/simpleSyntaxTokenizer';

interface SimpleSyntaxHighlighterProps {
  code: string;
  language: string | null;
  selectable: boolean;
}

function resolveTokenColor(theme: any, tokenType: string, fallback: string): string {
  if (tokenType === 'keyword') return theme.colors.syntaxKeyword ?? fallback;
  if (tokenType === 'string') return theme.colors.syntaxString ?? fallback;
  if (tokenType === 'number') return theme.colors.syntaxNumber ?? fallback;
  if (tokenType === 'comment') return theme.colors.syntaxComment ?? fallback;
  return theme.colors.syntaxDefault ?? fallback;
}

export const SimpleSyntaxHighlighter: React.FC<SimpleSyntaxHighlighterProps> = ({
  code,
  language,
  selectable,
}) => {
  const { theme } = useUnistyles();
  const fallback = theme.colors.text ?? '#111';

  const tokens = React.useMemo(() => tokenizeSimpleSyntaxText({ text: code, language }), [code, language]);

  return (
    <View>
      <Text
        selectable={selectable}
        style={{
          fontFamily: Typography.mono().fontFamily,
          fontSize: 14,
          lineHeight: 20,
        }}
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

