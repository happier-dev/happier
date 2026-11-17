import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection, type CollectionAnatomy, useHappierCollection } from '@happier-dev/plugin-ui';

import { ThemeMiniaturePreview } from '@/components/settings/appearance/ThemeModePreview';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { PANE_TEXT_INSET_PX } from '@/components/ui/layout/headerBand';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import type {
  StoreThemeListingFact,
  StoreThemeListingViewProps,
} from './storeThemeViewTypes';

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
  const faceTiles = React.useMemo((): SelectionTile<string>[] => (props.faces ?? []).map(face => ({
    id: face.id, title: face.name,
    subtitle: face.id === props.tryingFaceId ? t('themeStore.tryingNow')
      : face.mode === 'dark' ? t('themeCard.dark') : t('themeCard.light'),
    preview: <ThemeMiniaturePreview miniature={face.miniature} />,
  })), [props.faces, props.tryingFaceId]);
  const id = (suffix: string) =>
    props.testID ? `${props.testID}:${suffix}` : undefined;

  return (
    <ItemList testID={props.testID} presentation="grouped">
    <View style={styles.root}>
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
        <SelectionTiles
          variant="visual"
          scroll="page"
          tileSizing="fill"
          maximumColumns={phone ? 2 : 4}
          previewAspectRatio={phone ? 1.1 : 1.6}
          options={faceTiles}
          value={props.tryingFaceId}
          onChange={next => { if (next) props.onTryFace(next); }}
          labelLines={1}
          accessibilityLabel={t('themeStore.faces')}
          testIdPrefix={id('face')}
        />
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
          {props.facesState === 'error' && props.onRetryAcquisition ? (
            <RoundButton size="small" display="secondary" title={t('common.retry')}
              onPress={props.onRetryAcquisition} loading={props.busy === 'acquire'}
              disabled={props.busy !== null} testID={id('retryAcquisition')} />
          ) : null}
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
                title={props.installLabel ?? t('themeStore.install')}
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
                {props.installedLabel ?? t('themeStore.installed')}
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
        {props.onCheckUpdates || props.onDuplicate || props.onUpdate || props.onManageSource ? (
          <View style={[styles.actions, phone ? styles.actionsPhone : null]}>
            {props.onManageSource ? <RoundButton size={phone ? 'normal' : 'small'} display="secondary"
              title={t('settingsPlugins.managePlugin')} onPress={props.onManageSource} disabled={props.busy !== null} testID={id('plugin')} /> : null}
            {props.onCheckUpdates ? <RoundButton size={phone ? 'normal' : 'small'} display="secondary"
              title={t('capabilities.store.updates.checkNow')} onPress={props.onCheckUpdates}
              loading={props.busy === 'check'} disabled={props.busy !== null} testID={id('check')} /> : null}
            {props.onUpdate && props.updateAvailable ? <RoundButton size={phone ? 'normal' : 'small'} display="secondary"
              title={t('common.update')} onPress={props.onUpdate} loading={props.busy === 'update'}
              disabled={props.busy !== null} testID={id('update')} /> : null}
            {props.onDuplicate ? <RoundButton size={phone ? 'normal' : 'small'} display="secondary"
              title={t('settingsAppearance.themeProfiles.duplicateTheme')} onPress={props.onDuplicate}
              loading={props.busy === 'duplicate'} disabled={props.busy !== null} testID={id('duplicate')} /> : null}
          </View>
        ) : null}
        {props.checkError ? <SurfaceStateCard size="line" kind="warning"
          title={t('capabilities.store.updates.checkFailed')} diagnosticCode={props.checkError} /> : null}
        <WordCrossFade
          wordKey={trying ? `trying:${props.tryingFaceId}` : 'idle'}
        >
          <Text variant="meta" style={styles.meta}>
            {props.decisionHelp ?? (trying && tryingFace
              ? t('themeStore.installConsequence', {
                  face: tryingFace.name,
                  here: props.here,
                  count: props.faces?.length ?? 1,
                })
              : props.installed
                ? t('themeStore.installedHelp')
                : t('themeStore.tryHelp', { here: props.here }))}
          </Text>
        </WordCrossFade>
        {(props.installFailures ?? []).length > 0 ? (
          <View style={styles.failures} testID={id('installFailures')}>
            <InstallFailures failures={props.installFailures!} testID={id('installFailures')} />
            <View style={styles.retry}>
              <RoundButton
                size="small"
                display="secondary"
                title={t('themeStore.retryFaces')}
                onPress={props.onRetryFaces}
                disabled={props.busy !== null}
                testID={id('retryFaces')}
              />
            </View>
          </View>
        ) : null}
      </View>

      {props.facts.length > 0 ? (
        // The facts card stands on the listing's edges like everything above it: a contained scope adds no second inset.
        <ListPresentationProvider value="page" pageInsets="contained">
          <ItemGroup testID={id('facts')} header="none">
            {props.facts.map((fact) => (
              <FactRow key={fact.key} fact={fact} />
            ))}
          </ItemGroup>
        </ListPresentationProvider>
      ) : null}
    </View>
    </ItemList>
  );
});

type InstallFailure = NonNullable<StoreThemeListingViewProps['installFailures']>[number] & Readonly<{ key: string }>;
const failureKey = (failure: InstallFailure) => failure.key;
const noOpen = () => {};
function InstallFailures(props: Readonly<{ failures: NonNullable<StoreThemeListingViewProps['installFailures']>; testID?: string }>) {
  const rows = React.useMemo(() => props.failures.map((failure, index) => ({ ...failure, key: String(index) })), [props.failures]);
  const model = useHappierCollection({ items: rows, keyOf: failureKey, openKey: null, onOpenChange: noOpen });
  const anatomy = React.useMemo<CollectionAnatomy<InstallFailure>>(() => ({
    glyph: () => null, title: failure => t('themeStore.faceFailed', { face: failure.faceName }),
    where: failure => failure.code, columnTitles: { title: t('themeStore.faces') },
    accessibilityLabel: failure => `${t('themeStore.faceFailed', { face: failure.faceName })}, ${failure.code}`,
  }), []);
  return <CoreCollectionScope renderPageScroller={passThroughScroller}>
    <Collection model={model} anatomy={anatomy} presentation="list" detail="none" scroll="page"
      minListWidth={280} minDetailWidth={280} preferredListRatio={1}
      selection={{ isItemActivatable: () => false }} testID={props.testID}
      accessibilityLabel={t('themeStore.faces')} />
  </CoreCollectionScope>;
}

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
  // One frame: every block starts on the pane's text edge, where the pane header's title starts, and ends where its
  // close glyph ends; the blocks share one step between them.
  root: {
    paddingHorizontal: PANE_TEXT_INSET_PX,
    paddingVertical: theme.space.s16,
    gap: theme.space.s16,
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
  retry: {
    flexDirection: 'row',
    paddingTop: theme.space.s4,
  },
}));
