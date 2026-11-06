import * as React from 'react';

import { useSetting, useSettingsSelector } from '@/sync/domains/state/storage';

import { BotFace, type BotFaceProps } from './BotFace';
import type { BotFaceMood } from './botFaceGeometry';
import { resolveBotFaceIdentity, type BotFaceStyle } from './botFaceIdentity';
import type { SessionBotFaceFacts } from './sessionBotFaceFacts';

/**
 * A Bot Session's face at an identity surface: its saved style or the Account's Bots default, its identity, the mood
 * the surface already decided (`botActivity`, or the completion moment) and the surface's not-live dimming.
 */
export const SessionBotFace = React.memo(function SessionBotFace(
  props: Readonly<{
    facts: SessionBotFaceFacts;
    size: number;
    mood?: BotFaceMood;
    /** A surface's own rendition (Home's moons are flat Planets); never written back as the Bot's choice. */
    style?: BotFaceStyle;
    monochrome?: boolean;
    visible?: boolean;
    motion?: BotFaceProps['motion'];
    marker?: React.ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }>,
) {
  const explicitStyle = props.style ?? props.facts.face?.style;
  const style = useSettingsSelector(settings => explicitStyle ?? settings.botFaceStyle,
    explicitStyle ? [] : ['botFaceStyle']);
  const motionMode = useSetting('botMotion');
  const { seed, face } = props.facts;
  const identity = React.useMemo(
    () => resolveBotFaceIdentity(seed, face),
    [seed, face?.body, face?.palette, face?.shape],
  );
  return (
    <BotFace
      identity={identity}
      style={style}
      size={props.size}
      mood={props.mood && props.mood !== 'quiet' ? props.mood : props.facts.restingMood ?? 'quiet'}
      monochrome={props.monochrome}
      visible={props.visible}
      motion={props.motion}
      marker={props.marker}
      motionMode={motionMode}
      completedAt={props.facts.completedAt}
      failedAt={props.facts.failedAt}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
    />
  );
});
