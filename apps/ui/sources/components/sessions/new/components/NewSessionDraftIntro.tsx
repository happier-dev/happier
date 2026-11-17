import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';

import type { NewSessionDraftIntroV1 } from '../newSessionDraftSeed';

/**
 * A seeded draft's first screen (lab r12-create-N, round 3): the shipped centred EmptyState with the draft's built-in
 * scene, its title and description, and its suggestions as the action area. A suggestion fills the composer; it never
 * sends. The intro is the draft's own fact (`NewSessionDraftSeedV1.intro`); this view only draws it.
 */
export const NewSessionDraftIntro = React.memo(function NewSessionDraftIntro(
  props: Readonly<{
    intro: NewSessionDraftIntroV1;
    onSuggestion: (text: string) => void;
  }>,
) {
  const { intro, onSuggestion } = props;
  return (
    <EmptyState
      testID="new-session.intro"
      layout="centered"
      scene={intro.scene}
      title={intro.title}
      subtitle={intro.body}
      action={
        intro.suggestions.length > 0 ? (
          <View
            style={styles.suggestions}
            testID="new-session.intro.suggestions"
          >
            {intro.suggestions.map((suggestion) => (
              <RoundButton
                key={suggestion}
                size="small"
                display="secondary"
                title={suggestion}
                onPress={() => onSuggestion(suggestion)}
                testID={`new-session.intro.suggestion:${suggestion}`}
              />
            ))}
          </View>
        ) : undefined
      }
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  suggestions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.space.s8,
  },
}));
