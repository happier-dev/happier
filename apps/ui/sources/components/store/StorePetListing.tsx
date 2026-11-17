import * as React from 'react';
import { Linking, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_TYPE_SCALE } from '@happier-dev/plugin-ui/presentation';

import { PetPoseGrid } from '@/components/pets/render/PetPoseGrid';
import { usePetSheetSpriteVersion } from '@/components/pets/render/usePetSheetSpriteVersion';
import { BotFacePet } from '@/components/sessions/bots/face/BotFacePet';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { PANE_TEXT_INSET_PX } from '@/components/ui/layout/headerBand';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { StorePetArt } from './catalog/storePets';

/** The listing's hero (DECISIONS-R12 spec): 148 on a page or pane, 132 on a phone; poses at 40. */
const HERO_PX = 148;
const HERO_PHONE_PX = 132;
const POSE_PX = 40;

/** Where Add stands, said once (decision 9). Each failure leaves Add disabled except Couldn't reach. */
export type StorePetListingState =
  | Readonly<{ kind: 'available' }>
  | Readonly<{ kind: 'adding' }>
  | Readonly<{ kind: 'added' }>
  | Readonly<{ kind: 'builtIn' }>
  | Readonly<{ kind: 'couldntAdd' }>
  | Readonly<{ kind: 'libraryFull'; limit: number }>
  | Readonly<{ kind: 'syncOff' }>
  | Readonly<{ kind: 'unreachable' }>;

export type StorePetListingFact = Readonly<{
  key: 'looksAround' | 'licence' | 'published';
  value: string;
  note?: string | null;
}>;

export type StorePetListingViewProps = Readonly<{
  name: string;
  /** Author · source, said once (decision 8). */
  meta: string;
  description: string | null;
  /** The catalog's name, for the outcome lines and Report. */
  sourceTitle: string;
  art: StorePetArt | null;
  state: StorePetListingState;
  facts: readonly StorePetListingFact[];
  reportUrl: string | null;
  onAdd: () => void;
  /** The Bot face chooser hand-off; absent until the chooser can take a preselected pet. */
  onUseAsFace?: () => void;
  onMakeCompanion?: () => void;
  onOpenSettingsPets: () => void;
  onOpenFeatures: () => void;
  testID?: string;
}>;

/**
 * A pet's Store listing (lab r12-pet-L, in `StoreThemeListing`'s order): identity first (kicker, name, author ·
 * source), then the pet itself on the same left edge and every pose, the description, the one primary action and
 * what it does, then the facts, and Report at the foot. Rendered in the Store's listing pane, pushed on a phone.
 */
export const StorePetListing = React.memo(function StorePetListing(
  props: StorePetListingViewProps,
) {
  const phone = useDeviceType() === 'phone';
  const { theme } = useUnistyles();
  const motionMode = useSetting('botMotion');
  const version = usePetSheetSpriteVersion(props.art?.spritesheetSource, props.art?.spriteVersionNumber);
  // A v2 sheet turns toward the pointer as a Bot's face (decision 4): the listing says so, from the decoded atlas.
  const facts = React.useMemo(() => version === 2 ? [{ key: 'looksAround' as const, value: t('settingsPets.store.yes'),
    note: t('settingsPets.store.looksAroundNote') }, ...props.facts] : props.facts, [version, props.facts]);
  const id = (suffix: string) =>
    props.testID ? `${props.testID}:${suffix}` : undefined;
  const buttonSize = phone ? 'normal' : 'small';
  const { state } = props;
  const addBlocked =
    state.kind === 'couldntAdd' || state.kind === 'libraryFull';
  return (
    <ItemList testID={props.testID} presentation="grouped">
      <View style={styles.root}>
        <View style={styles.identity}>
          <Text variant="meta" style={styles.kicker}>
            {t('settingsPets.store.kicker')}
          </Text>
          <Text variant="title" emphasis="semiBold" style={styles.name}>
            {props.name}
          </Text>
          <Text variant="meta" style={styles.meta}>
            {props.meta}
          </Text>
        </View>

        {props.art && version ? (
          <>
            <View testID={id('hero')}>
              <BotFacePet
                spritesheetSource={props.art.spritesheetSource}
                opaqueBounds={props.art.opaqueBounds}
                spriteVersionNumber={version}
                hasNeutralLookCell={props.art.hasNeutralLookCell}
                size={phone ? HERO_PHONE_PX : HERO_PX}
                mood="quiet"
                seed={props.art.seed}
                motion
                motionMode={motionMode}
                accessibilityLabel={props.name}
              />
            </View>
            <PetPoseGrid
              spritesheetSource={props.art.spritesheetSource}
              opaqueBounds={props.art.opaqueBounds}
              spriteVersionNumber={version}
              size={POSE_PX}
              testID={id('poses')}
            />
          </>
        ) : props.art ? (
          // The sheet is being read: its hero's room is held, so nothing below moves when it arrives.
          <View style={{ height: phone ? HERO_PHONE_PX : HERO_PX }} testID={id('hero')} />
        ) : null}

        {props.description ? (
          <Text variant="body" style={styles.description}>
            {props.description}
          </Text>
        ) : null}

        <View style={styles.decision}>
          {state.kind === 'syncOff' ? (
            <OutcomeLine
              glyph="info"
              tone="info"
              text={t('settingsPets.store.syncOff')}
              action={{
                label: t('settingsPets.store.openFeatures'),
                onPress: props.onOpenFeatures,
              }}
              testID={id('syncOff')}
            />
          ) : state.kind === 'added' || state.kind === 'builtIn' ? (
            <>
              <View style={styles.inline}>
                <Icon
                  name="check"
                  size={ICON_SIZE.xs}
                  color={theme.colors.text.secondary}
                />
                <Text variant="body" style={styles.meta}>
                  {t('settingsPets.store.added')}
                </Text>
              </View>
              <View
                style={[styles.actions, phone ? styles.actionsPhone : null]}
              >
                {props.onUseAsFace ? (
                  <RoundButton
                    size={buttonSize}
                    title={t('settingsPets.store.useAsFace')}
                    onPress={props.onUseAsFace}
                    testID={id('useAsFace')}
                  />
                ) : null}
                {props.onMakeCompanion ? (
                  <RoundButton
                    size={buttonSize}
                    display={props.onUseAsFace ? 'secondary' : undefined}
                    title={t('settingsPets.store.makeCompanion')}
                    onPress={props.onMakeCompanion}
                    testID={id('companion')}
                  />
                ) : null}
              </View>
            </>
          ) : (
            <>
              {state.kind === 'couldntAdd' ? (
                <OutcomeLine
                  glyph="x-circle"
                  tone="danger"
                  testID={id('couldntAdd')}
                  text={t('settingsPets.store.couldntAdd', {
                    name: props.name,
                    reason: t('settingsPets.store.checkFailed'),
                    source: props.sourceTitle,
                  })}
                />
              ) : state.kind === 'libraryFull' ? (
                <OutcomeLine
                  glyph="warning"
                  tone="warning"
                  testID={id('libraryFull')}
                  text={t('settingsPets.store.libraryFull', {
                    name: props.name,
                    limit: state.limit,
                  })}
                  action={{
                    label: t('settingsPets.store.openSettingsPets'),
                    onPress: props.onOpenSettingsPets,
                  }}
                />
              ) : state.kind === 'unreachable' ? (
                <SurfaceStateCard
                  size="line"
                  kind="warning"
                  testID={id('unreachable')}
                  title={t('settingsPets.store.unreachable', {
                    source: props.sourceTitle,
                  })}
                />
              ) : null}
              <View
                style={[styles.actions, phone ? styles.actionsPhone : null]}
              >
                <RoundButton
                  size={buttonSize}
                  title={t('settingsPets.store.add')}
                  onPress={props.onAdd}
                  loading={state.kind === 'adding'}
                  disabled={state.kind === 'adding' || addBlocked}
                  testID={id('add')}
                />
              </View>
              <Text variant="meta" style={styles.meta}>
                {t('settingsPets.store.addHelp', { name: props.name })}
              </Text>
            </>
          )}
        </View>

        {facts.length > 0 ? (
          // The facts card stands on the listing's edges like everything above it: a contained scope adds no second inset.
          <ListPresentationProvider value="page" pageInsets="contained">
          <ItemGroup testID={id('facts')} header="none">
            {facts.map((fact) => (
              <FactRow key={fact.key} fact={fact} />
            ))}
          </ItemGroup>
          </ListPresentationProvider>
        ) : null}

        {props.reportUrl ? (
          <View style={styles.inline} testID={id('report')}>
            <Icon
              name="flag"
              size={ICON_SIZE.xs}
              color={theme.colors.text.tertiary}
            />
            <Text variant="meta" style={styles.meta}>
              {t('settingsPets.store.reportPrompt')}{' '}
              <Text
                variant="meta"
                accessibilityRole="link"
                style={styles.link}
                onPress={() =>
                  fireAndForget(Linking.openURL(props.reportUrl!), {
                    tag: 'StorePetListing.report',
                  })
                }
              >
                {t('settingsPets.store.report', { source: props.sourceTitle })}
              </Text>
            </Text>
          </View>
        ) : null}
      </View>
    </ItemList>
  );
});

function OutcomeLine(
  props: Readonly<{
    glyph: 'info' | 'x-circle' | 'warning';
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
            <Text
              variant="body"
              accessibilityRole="link"
              style={styles.link}
              onPress={props.action.onPress}
            >
              {props.action.label}
            </Text>
          </>
        ) : null}
      </Text>
    </View>
  );
}

const FACT_LABEL_KEY = {
  looksAround: 'settingsPets.store.looksAround',
  licence: 'settingsPets.store.licence',
  published: 'settingsPets.store.published',
} as const;

function FactRow(props: Readonly<{ fact: StorePetListingFact }>) {
  return (
    <Item
      mode="info"
      title={t(FACT_LABEL_KEY[props.fact.key])}
      detail={props.fact.value}
      {...(props.fact.note ? { subtitle: props.fact.note } : {})}
      accessoryLayout="adaptive"
      showChevron={false}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    // The Store listing frame (StoreThemeListing, STORE-UI-1117): every block on the pane's text edge.
    paddingHorizontal: PANE_TEXT_INSET_PX,
    paddingVertical: theme.space.s16,
    gap: theme.space.s16,
  },
  identity: { gap: theme.space.s2 },
  kicker: { color: theme.colors.text.tertiary },
  name: { color: theme.colors.text.primary },
  meta: { color: theme.colors.text.secondary, flexShrink: 1 },
  description: { color: theme.colors.text.secondary },
  decision: { gap: theme.space.s8 },
  actions: { flexDirection: 'row', gap: theme.space.s8, alignItems: 'center' },
  actionsPhone: { flexDirection: 'column', alignItems: 'stretch' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  outcome: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
  },
  // The glyph sits in a box one body line high, so it centres on the first line of text.
  outcomeGlyph: {
    height: HAPPIER_TYPE_SCALE.body.lineHeight,
    justifyContent: 'center',
  },
  outcomeText: { color: theme.colors.text.primary, flexShrink: 1 },
  link: { color: theme.colors.text.primary, textDecorationLine: 'underline' },
}));
