import * as React from 'react';
import { View } from 'react-native';
import {
  HappierSavedSkillCard,
  HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX,
  resolveHappierWorkStatusGlyphColor,
} from '@happier-dev/plugin-ui/presentation';

import {
  renderWorkUpdateCardSurface,
  useWorkTheme,
  WORK_HOST,
} from '@/components/work/map/WorkMapView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { savedSkillState } from '@/components/tools/renderers/system/SavedSkillResult';
import { t } from '@/text';

/** The saved-skill card's four footer states at static props, through the same state mapping the transcript uses. */
export function SavedSkillCardSpecimen() {
  const theme = useWorkTheme();
  const bot = 'Release captain';
  const states = [
    {
      id: 'live',
      state: savedSkillState('addedNow', null, false, bot),
      recovery: null,
    },
    {
      id: 'next-turn',
      state: savedSkillState('joinsNextTurn', null, false, bot),
      recovery: null,
    },
    {
      id: 'restart',
      state: savedSkillState('restart', null, false, bot),
      recovery: t('capabilities.skills.saved.restartNow'),
    },
    {
      id: 'not-attached',
      state: savedSkillState(null, null, true, bot),
      recovery: t('capabilities.skills.saved.attachAgain'),
    },
  ] as const;
  return (
    <View style={{ gap: 16 }}>
      {states.map(({ id, state, recovery }) => (
        <HappierSavedSkillCard
          key={id}
          testID={`saved-skill-specimen-${id}`}
          name="prerelease-check"
          description="Check every bumped package for prerelease versions before drafting the notes."
          savedLabel={t('capabilities.skills.saved.saved')}
          scopeLabel={t('capabilities.skills.saved.onlyUses', { name: bot })}
          status={state.word}
          statusDetail={state.detail ?? undefined}
          statusTone={state.tone}
          statusMark={
            <Icon
              name={state.icon}
              size={HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX}
              color={resolveHappierWorkStatusGlyphColor(
                state.tone,
                theme.colors,
              )}
            />
          }
          theme={theme}
          host={WORK_HOST}
          renderSurface={renderWorkUpdateCardSurface}
          mark={
            <Icon
              name="lightbulb"
              size={HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX}
              color={theme.colors.secondaryText}
            />
          }
          viewControl={
            <RoundButton
              title={t('capabilities.skills.saved.view')}
              size="small"
              display="inverted"
              onPress={() => {}}
            />
          }
          recoveryControl={
            recovery ? (
              <RoundButton
                title={recovery}
                size="small"
                display="secondary"
                onPress={() => {}}
              />
            ) : undefined
          }
        />
      ))}
    </View>
  );
}
