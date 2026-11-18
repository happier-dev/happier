import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_TYPE_SCALE } from '@happier-dev/plugin-ui/presentation';
import type { PetAccountReferenceV1 } from '@happier-dev/protocol/pets/selection';

import { BotFaceWearButton } from '@/components/sessions/bots/BotFaceWearButton';
import { RoundButton, type RoundButtonSize } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import type { PetAddOutcomeState } from './petAddOutcome';

type PetAddOutcomeProps = Readonly<{
  state: PetAddOutcomeState;
  name: string;
  /** Where the pet stays when it isn't added: the catalog, or the Machine that made it. */
  sourceTitle: string;
  wearPet?: PetAccountReferenceV1;
  onMakeCompanion?: () => void;
  onUndo?: () => void;
  onOpenSettingsPets: () => void;
  onOpenFeatures: () => void;
  size?: RoundButtonSize;
  testID?: string;
}>;

/**
 * An Add's aftermath, the same in the Store listing and in a Session's pet card (R12 decisions 7 and 9, §16): the outcome
 * said once, then after Add, Use as a Bot's face… (primary), Make it my companion and Undo (tertiary, only for a pet this
 * Add created). The listing shows both parts together; the card says the line where its check line was and puts the
 * actions under its poses. Each host keeps its own Add (the listing's button, the card's Keep).
 */
export function PetAddOutcome(props: PetAddOutcomeProps) {
  return (
    <>
      <PetAddOutcomeLine {...props} />
      <PetAddOutcomeActions {...props} />
    </>
  );
}

/** The outcome, said once: in your pets, added just now, Undone, or the refusal in the listing's words. */
export function PetAddOutcomeLine(props: PetAddOutcomeProps) {
  const { theme } = useUnistyles();
  const { state } = props;
  const id = (suffix: string) => (props.testID ? `${props.testID}:${suffix}` : undefined);
  switch (state.kind) {
    case 'syncOff':
      return (
        <OutcomeLine glyph="info" tone="info" text={t('settingsPets.store.syncOff')} testID={id('syncOff')}
          action={{ label: t('settingsPets.store.openFeatures'), onPress: props.onOpenFeatures }} />
      );
    case 'removed':
      return (
        <OutcomeLine glyph="arrow-counter-clockwise" tone="info" testID={id('removed')}
          text={t('settingsPets.store.removed', { name: props.name, source: props.sourceTitle })} />
      );
    case 'couldntAdd':
      return (
        <OutcomeLine glyph="x-circle" tone="danger" testID={id('couldntAdd')}
          text={state.reason === 'sheetCheck'
            ? t('settingsPets.store.couldntAdd', { name: props.name, reason: t('settingsPets.store.checkFailed'), source: props.sourceTitle })
            : t('petShare.offerCouldNotAdd', { name: props.name })} />
      );
    case 'libraryFull':
      return (
        <OutcomeLine glyph="warning" tone="warning" testID={id('libraryFull')}
          text={t('settingsPets.store.libraryFull', { name: props.name, limit: state.limit })}
          action={{ label: t('settingsPets.store.openSettingsPets'), onPress: props.onOpenSettingsPets }} />
      );
    case 'unreachable':
      return (
        <SurfaceStateCard size="line" kind="warning" testID={id('unreachable')}
          title={t('settingsPets.store.unreachable', { source: props.sourceTitle })} />
      );
    case 'added':
    case 'addedNow':
      return (
        <>
          <View style={styles.inline} testID={id('added')}>
            <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text variant="body" style={styles.meta}>
              {t(state.kind === 'addedNow' ? 'settingsPets.store.addedNow' : 'settingsPets.store.added')}
            </Text>
          </View>
          {state.kind === 'addedNow' && state.undo === 'failed' ? (
            <OutcomeLine glyph="x-circle" tone="danger" testID={id('undoFailed')}
              text={t('settingsPets.store.undoFailed', { name: props.name })} />
          ) : null}
        </>
      );
  }
}

/** After Add: Use as a Bot's face… (primary), Make it my companion, then Undo for a pet this Add created. */
export function PetAddOutcomeActions(props: PetAddOutcomeProps) {
  const phone = useDeviceType() === 'phone';
  const { state } = props;
  if (state.kind !== 'added' && state.kind !== 'addedNow') return null;
  const id = (suffix: string) => (props.testID ? `${props.testID}:${suffix}` : undefined);
  return (
    <View style={[styles.actions, phone ? styles.actionsPhone : null]}>
      {props.wearPet ? (
        <BotFaceWearButton size={props.size} pet={props.wearPet} name={props.name} testID={id('useAsFace')} />
      ) : null}
      {props.onMakeCompanion ? (
        <RoundButton
          size={props.size}
          display={props.wearPet ? 'secondary' : undefined}
          title={t('settingsPets.store.makeCompanion')}
          onPress={props.onMakeCompanion}
          testID={id('companion')}
        />
      ) : null}
      {state.kind === 'addedNow' && props.onUndo ? (
        // Tertiary, after the next steps (lab r12-create-A): Undo removes the pet this Add created.
        <RoundButton
          size={props.size}
          display="inverted"
          title={t('common.undo')}
          onPress={props.onUndo}
          loading={state.undo === 'running'}
          disabled={state.undo === 'running'}
          testID={id('undo')}
        />
      ) : null}
    </View>
  );
}

function OutcomeLine(
  props: Readonly<{
    glyph: 'info' | 'x-circle' | 'warning' | 'arrow-counter-clockwise';
    tone: 'info' | 'danger' | 'warning';
    text: string;
    action?: Readonly<{ label: string; onPress: () => void }>;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const colour =
    props.tone === 'danger'
      ? theme.colors.state.danger.foreground
      : props.tone === 'warning'
        ? theme.colors.state.warning.foreground
        : theme.colors.text.secondary;
  return (
    <View style={styles.outcome} testID={props.testID}>
      <View style={styles.outcomeGlyph}>
        <Icon name={props.glyph} size={ICON_SIZE.xs} color={colour} />
      </View>
      <Text variant="body" style={styles.outcomeText}>
        {props.text}
        {props.action ? (
          <>
            {' '}
            <Text variant="body" accessibilityRole="link" style={styles.link} onPress={props.action.onPress}>
              {props.action.label}
            </Text>
          </>
        ) : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  meta: { color: theme.colors.text.secondary, flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8, alignItems: 'center' },
  actionsPhone: { flexDirection: 'column', alignItems: 'stretch' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  outcome: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8 },
  // The glyph sits in a box one body line high, so it centres on the first line of text.
  outcomeGlyph: { height: HAPPIER_TYPE_SCALE.body.lineHeight, justifyContent: 'center' },
  outcomeText: { color: theme.colors.text.primary, flexShrink: 1 },
  link: { color: theme.colors.text.primary, textDecorationLine: 'underline' },
}));
