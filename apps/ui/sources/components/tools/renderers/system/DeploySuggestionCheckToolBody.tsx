import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploySuggestionRecommendationV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

import {
  DeploySuggestionCardTiles,
  deploySuggestionCardId,
  deploySuggestionCardIndex,
  useDeploySuggestionCards,
} from '@/components/projects/starters/auto/DeploySuggestionCards';
import type { TranscriptDeploySuggestionCheck } from '@/components/sessions/transcript/references/transcriptDeploySuggestionReference';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { ToolSectionView } from '../../shell/presentation/ToolSectionView';

/** The card the person chose, with the catalog it was checked against: what Use this setup hands to the dialog. */
export type DeploySuggestionChoice = Readonly<{
  recommendation: DeploySuggestionRecommendationV1;
  catalog: TranscriptDeploySuggestionCheck['catalog'];
}>;

/**
 * A Session agent's checked suggestion in the transcript (deploy auto-mode U10, F7): the same cards the Describe your
 * app step shows (lab autoRecs), the recommended one chosen, and Use this setup, which opens Deploy an app with the
 * chosen card applied. The cards stay readable without the action (a host that can't open the dialog passes none).
 */
export const DeploySuggestionCheckToolBody = React.memo(
  function DeploySuggestionCheckToolBody(
    props: Readonly<{
      check: TranscriptDeploySuggestionCheck;
      onUse: ((choice: DeploySuggestionChoice) => void) | null;
    }>,
  ) {
    const phone = useDeviceType() === 'phone';
    const { recommendations, catalog } = props.check;
    const cards = useDeploySuggestionCards(recommendations, catalog);
    const [chosen, setChosen] = React.useState(() => deploySuggestionCardId(0));
    const recommendation =
      recommendations[deploySuggestionCardIndex(chosen) ?? -1] ?? null;
    const { onUse } = props;
    return (
      <ToolSectionView>
        <View testID="deploy-suggestion-check" style={styles.body}>
          <DeploySuggestionCardTiles
            testIdPrefix="deploy-suggestion-check.card"
            cards={cards}
            value={chosen}
            onChange={setChosen}
            phone={phone}
          />
          {onUse ? (
            <View style={styles.actions}>
              <RoundButton
                testID="deploy-suggestion-check.use"
                size="small"
                title={t('newApp.auto.useSetup')}
                disabled={recommendation === null}
                onPress={() => {
                  if (recommendation) onUse({ recommendation, catalog });
                }}
              />
            </View>
          ) : null}
        </View>
      </ToolSectionView>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s12 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
}));
