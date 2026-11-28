import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';

import { joinWelcomeHeadlinePhrase } from './welcomeHeadlineModel';
import type { WelcomeHeadlineProps } from './welcomeHeadlineMotion';

/**
 * The first Welcome's headline on a native app: the visit's first phrase, still, over the fixed second line. The
 * rotation (`WelcomeHeadline.web.tsx`) places its parts from text measured before paint, which native text has no
 * synchronous measure for, so a swap here could not promise a still line; a phrase that does not fit shrinks once.
 */
export const WelcomeHeadline = React.memo(function WelcomeHeadline({
  headline,
  lineStyle,
  line2Style,
}: WelcomeHeadlineProps) {
  const first = headline.phrases[0];
  return (
    <View style={{ alignSelf: 'stretch', alignItems: 'center' }}>
      {first ? (
        <Text
          accessibilityRole="header"
          testID="welcome-headline-line1"
          style={lineStyle}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {joinWelcomeHeadlinePhrase(first, headline.joiner)}
        </Text>
      ) : null}
      <Text
        accessibilityRole="header"
        testID="welcome-headline-line2"
        style={line2Style}
      >
        {headline.line2}
      </Text>
    </View>
  );
});
