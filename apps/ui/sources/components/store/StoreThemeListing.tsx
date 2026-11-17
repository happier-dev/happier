import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection, type CollectionAnatomy, useHappierCollection } from '@happier-dev/plugin-ui';

import { THEME_MINIATURE_CARD_MIN_WIDTH, ThemeMiniaturePreview } from '@/components/settings/appearance/ThemeModePreview';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import type {
  StoreThemeListingFact,
  StoreThemeListingFace,
  StoreThemeListingViewProps,
} from './storeThemeViewTypes';

const noFaces: readonly StoreThemeListingFace[] = Object.freeze([]);
const faceKey = (face: StoreThemeListingFace) => face.id;
const passThroughScroller = (children: React.ReactNode) => children;

/**
 * A theme listing (lab C2 with finding 7): identity first (kicker, name, meta said once), then the thing
 * itself (its faces, the one being tried ringed), what Try and Install do, and four facts. While it is open
 * it alone owns Revert and Install; closed, the try bar takes them over (C2b). Rendered in the Store's
 * DetailsPaneHost overlay on wide screens and the pushed listing page on phones.
 */
export const StoreThemeListing = React.memo(function StoreThemeListing(
  props: StoreThemeListingViewProps,
) {
  const phone = useDeviceType() === 'phone';
  const { theme } = useUnistyles();
  const trying = props.tryingFaceId !== null;
  const tryingFace =
    props.faces?.find((face) => face.id === props.tryingFaceId) ?? null;
  const model = useHappierCollection<StoreThemeListingFace>({ items: props.faces ?? noFaces,
    keyOf: faceKey, openKey: null, onOpenChange: key => { if (key) props.onTryFace(key); } });
  const anatomy = React.useMemo<CollectionAnatomy<StoreThemeListingFace>>(() => ({
        glyph: () => null,
        title: face => face.name,
        columnTitles: { title: t('themeStore.faces') },
        where: face =>
          face.id === props.tryingFaceId
            ? t('themeStore.tryingNow')
            : face.mode === 'dark'
              ? t('themeCard.dark')
              : t('themeCard.light'),
        preview: face => <View style={{ aspectRatio: phone ? 1.1 : 1.6 }}><ThemeMiniaturePreview miniature={face.miniature} /></View>,
        accessibilityLabel: face => face.name,
        testID: face => `${props.testID ?? 'store-theme'}:face:${face.id}`,
  }), [phone, props.tryingFaceId, props.testID]);
  const id = (suffix: string) =>
    props.testID ? `${props.testID}:${suffix}` : undefined;

  return (
    <ItemList testID={props.testID} presentation="grouped">
    <View
      style={[styles.root, phone ? styles.rootPhone : null]}
    >
      <View style={styles.identity}>
        <Text variant="meta" style={styles.kicker}>
          {props.kicker}
        </Text>
        <Text variant="title" emphasis="semiBold" style={styles.name}>
          {props.name}
        </Text>
        <Text variant="meta" style={styles.meta}>
          {props.meta}
        </Text>
      </View>

      {props.faces && props.faces.length > 0 ? (
        <CoreCollectionScope renderPageScroller={passThroughScroller}>
        <Collection<StoreThemeListingFace>
          model={model}
          anatomy={anatomy}
          presentation="grid"
          minCardWidth={THEME_MINIATURE_CARD_MIN_WIDTH}
          detail="none"
          scroll="page"
          minListWidth={280}
          minDetailWidth={280}
          preferredListRatio={1}
          selection={{ single: { value: props.tryingFaceId, onValueChange: next => { if (next) props.onTryFace(next); } } }}
          accessibilityLabel={t('themeStore.faces')}
          testID={id('faces')}
        />
        </CoreCollectionScope>
      ) : (
        <View
          style={[styles.facesPending, { aspectRatio: phone ? 2.2 : 3.2 }]}
          testID={id('faces')}
        >
          <Text variant="meta" style={styles.meta}>
            {props.facesState === 'error'
              ? t('themeStore.facesFailed')
              : t('themeStore.facesLoading')}
          </Text>
          {props.facesError ? <Text variant="meta" style={styles.meta}>{props.facesError}</Text> : null}
        </View>
      )}

      {props.description ? (
        <Text variant="body" style={styles.description}>
          {props.description}
        </Text>
      ) : null}

      <View style={styles.decision}>
        <View style={[styles.actions, phone ? styles.actionsPhone : null]}>
          {trying ? (
            <>
              <RoundButton
                size={phone ? 'normal' : 'small'}
                display="secondary"
                title={t('themeStore.revert')}
                onPress={props.onRevert}
                loading={props.busy === 'revert'}
                disabled={props.busy !== null}
                testID={id('revert')}
              />
              <RoundButton
                size={phone ? 'normal' : 'small'}
                title={t('themeStore.install')}
                onPress={props.onInstall}
                loading={props.busy === 'install'}
                disabled={props.busy !== null}
                testID={id('install')}
              />
            </>
          ) : props.installed ? (
            <View style={styles.installed}>
              <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
              <Text variant="body" style={styles.meta}>
                {t('themeStore.installed')}
              </Text>
            </View>
          ) : (
            <RoundButton
              size={phone ? 'normal' : 'small'}
              title={t('themeStore.tryOn', { here: props.here })}
              onPress={() => {
                const face = props.preferredFaceId ?? props.faces?.[0]?.id;
                if (face) props.onTryFace(face);
              }}
              loading={props.busy === 'try'}
              disabled={props.busy !== null || !props.faces?.length}
              testID={id('try')}
            />
          )}
          {props.onUninstall ? (
            <RoundButton
              size={phone ? 'normal' : 'small'}
              display="secondary"
              title={t('settingsPlugins.uninstall')}
              onPress={props.onUninstall}
              loading={props.busy === 'uninstall'}
              disabled={props.busy !== null}
              testID={id('uninstall')}
            />
          ) : null}
        </View>
        <WordCrossFade
          wordKey={trying ? `trying:${props.tryingFaceId}` : 'idle'}
        >
          <Text variant="meta" style={styles.meta}>
            {trying && tryingFace
              ? t('themeStore.installConsequence', {
                  face: tryingFace.name,
                  here: props.here,
                  count: props.faces?.length ?? 1,
                })
              : props.installed
                ? t('themeStore.installedHelp')
                : t('themeStore.tryHelp', { here: props.here })}
          </Text>
        </WordCrossFade>
        {(props.installFailures ?? []).length > 0 ? (
          <View style={styles.failures} testID={id('installFailures')}>
            {(props.installFailures ?? []).map((failure) => (
              <Text
                key={failure.faceName}
                variant="meta"
                style={styles.failure}
              >
                {t('themeStore.faceFailed', { face: failure.faceName })}
                <Text
                  variant="meta"
                  style={styles.failureCode}
                >{`  ${failure.code}`}</Text>
              </Text>
            ))}
            <View style={styles.retry}>
              <RoundButton
                size="small"
                display="secondary"
                title={t('themeStore.retryFaces')}
                onPress={props.onRetryFaces}
                testID={id('retryFaces')}
              />
            </View>
          </View>
        ) : null}
      </View>

      {props.facts.length > 0 ? (
        <ItemGroup testID={id('facts')}>
          {props.facts.map((fact) => (
            <FactRow key={fact.key} fact={fact} />
          ))}
        </ItemGroup>
      ) : null}
    </View>
    </ItemList>
  );
});

const FACT_LABEL_KEY = {
  includes: 'themeStore.factIncludes',
  changes: 'themeStore.factChanges',
  worksOn: 'themeStore.factWorksOn',
  licence: 'themeStore.factLicence',
} as const;

function FactRow(props: Readonly<{ fact: StoreThemeListingFact }>) {
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
    paddingHorizontal: theme.space.s24,
    paddingVertical: theme.space.s16,
    gap: theme.space.s16,
  },
  rootPhone: {
    paddingHorizontal: theme.space.s16,
  },
  identity: {
    gap: theme.space.s2,
  },
  kicker: {
    color: theme.colors.text.tertiary,
  },
  name: {
    color: theme.colors.text.primary,
  },
  meta: {
    color: theme.colors.text.secondary,
  },
  description: {
    color: theme.colors.text.secondary,
  },
  facesPending: {
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.inset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  decision: {
    gap: theme.space.s8,
  },
  actions: {
    flexDirection: 'row',
    gap: theme.space.s8,
    alignItems: 'center',
  },
  actionsPhone: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  installed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  failures: {
    gap: theme.space.s4,
  },
  failure: {
    color: theme.colors.state.danger.textForeground,
  },
  failureCode: {
    color: theme.colors.text.tertiary,
    ...Typography.mono(),
  },
  retry: {
    flexDirection: 'row',
    paddingTop: theme.space.s4,
  },
}));
