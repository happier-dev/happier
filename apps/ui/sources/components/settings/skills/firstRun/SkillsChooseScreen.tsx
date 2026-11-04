import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { isReadOnlySkillProvenanceV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useSkillsLibrary, type SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';

import { SKILLS_COLLECTION_ROUTE, skillSource } from '../skillsCollectionModel';
import { useSkillPlaces } from '../useSkillPlaces';
import { useSkillsFirstRun, type SkillsFirstRun } from './useSkillsFirstRun';
import { useSkillSourceNames } from '../useSkillSourceNames';


function formatDay(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(ms);
}

/**
 * `/settings/skills/choose` (P6 §4.7, lab sp F/Fp): the first-run checklist. Off skills used recently come
 * first and are ticked; one bulk Turn on puts every ticked skill on everywhere; Not now dismisses the moment
 * on this device. Nothing turns on until the person presses it.
 */
export const SkillsChooseScreen = React.memo(function SkillsChooseScreen() {
  const library = useSkillsLibrary();
  const firstRun = useSkillsFirstRun(library.items);
  return <SkillsChoosePage library={library} firstRun={firstRun} />;
});

/** The checklist over its library and first-run owner (the dev specimen supplies fixtures). */
export const SkillsChoosePage = React.memo(function SkillsChoosePage(
  props: Readonly<{ library: SkillsLibrary; firstRun: SkillsFirstRun }>,
) {
  const { library, firstRun } = props;
  const pluginUiProjection = useAppShellPluginUiDeclarationProjection();
  const sourceNameFor = useSkillSourceNames();
  const router = useRouter();
  const { theme } = useUnistyles();
  // A skill added from a machine names that machine, as the rail and homepage do.
  const { names } = useSkillPlaces();
  const selected = React.useMemo(
    () => new Set(firstRun.selectedIds),
    [firstRun.selectedIds],
  );
  const allSelected =
    firstRun.items.length > 0 &&
    firstRun.selectedCount === firstRun.items.length;

  const home = React.useCallback(() => {
    const result = runGuardedNavigation(() =>
      router.push(SKILLS_COLLECTION_ROUTE as never),
    );
    if (result !== true)
      fireAndForget(result, { tag: 'SkillsChooseScreen.home' });
  }, [router]);
  const turnOn = React.useCallback(async () => {
    // Success lands on the homepage, where the newly on skills travel out to the machines once.
    if (await firstRun.turnOn()) home();
  }, [firstRun.turnOn, home]);
  const notNow = React.useCallback(() => {
    firstRun.notNow();
    home();
  }, [firstRun.notNow, home]);
  const selectAll = React.useCallback(() => {
    for (const item of firstRun.items)
      firstRun.setSelected(item.skillId, !allSelected);
  }, [allSelected, firstRun.items, firstRun.setSelected]);

  const total = library.items.filter(
    (item) => !isReadOnlySkillProvenanceV1(item.provenance),
  ).length;
  const migratedNames = firstRun.migrated.map((item) => item.name).join(', ');

  return (
    <View style={styles.page}>
      <ItemList keyboardShouldPersistTaps="handled" pageColumn="wide">
        <PageHeader
          testID="skills.choose.header"
          title={firstRun.eligible ? t('capabilities.skills.home.firstHeadline') : t('capabilities.skills.home.choose')}
          alwaysShowTitle
          description={
            firstRun.firstVisit
              ? t('capabilities.skillsUpdates.choose.purpose', {
                  total,
                  off: firstRun.firstVisit.off,
                })
              : t('capabilities.skillsUpdates.choose.purposeIdle')
          }
        />
        {library.status === 'loading' &&
        library.items.length === 0 ? null : !firstRun.eligible ? (
          <SurfaceStateCard
            testID="skills.choose.nothingWaits"
            size="page"
            kind="empty"
            scene="inboxZero"
            title={t('capabilities.skillsUpdates.updates.nothingToChoose')}
            reason={t('capabilities.skillsUpdates.choose.nothingWaits')}
            // Nothing to decide here, so the way back is a plain bordered button under the words, not an invitation.
            actionFooter={
              <RoundButton
                testID="skills.choose.nothingWaits.back"
                display="secondary"
                title={t('capabilities.skills.allSkills')}
                style={styles.backAction}
                onPress={home}
              />
            }
          />
        ) : (
          <>
            {firstRun.migrated.length > 0 ? (
              <ItemGroup>
                <Item
                  testID="skills.choose.migrated"
                  title={t('capabilities.skillsUpdates.choose.migratedTitle', { count: firstRun.migrated.length })}
                  subtitle={t('capabilities.skillsUpdates.choose.migratedBody', { names: migratedNames })}
                  subtitleLines={3}
                  icon={<Icon name="check" size={18} color={theme.colors.text.secondary} />}
                  showChevron={false}
                />
              </ItemGroup>
            ) : null}
            <ItemGroup
              title={t('capabilities.skillsUpdates.choose.listTitle')}
              action={
                <TextLinkButton
                  testID="skills.choose.selectAll"
                  label={
                    allSelected
                      ? t('capabilities.skillsUpdates.choose.selectNone')
                      : t('capabilities.skillsUpdates.choose.selectAll')
                  }
                  onPress={selectAll}
                />
              }
            >
              {firstRun.items.map((item) => {
                const checked = selected.has(item.skillId);
                return (
                  <CapabilityRow
                    key={item.skillId}
                    testID={`skills.choose.${item.skillId}`}
                    title={item.name}
                    description={item.description}
                    // What the row will be once Turn on runs: Everywhere when ticked, else it stays Off.
                    whereSummary={
                      checked
                        ? t('capabilities.where.everywhere')
                        : t('capabilities.skills.off')
                    }
                    facts={{
                      presentation: 'row',
                      source: skillSource(item, names.machineName, pluginUiProjection?.installedPackagesById, sourceNameFor(item)),
                      trust: item.trust,
                      cost: { tokensWhenUsed: item.cost.bodyTokens },
                      ...(item.lastUsedAt !== undefined
                        ? {
                            extra: [
                              t('capabilities.skillsUpdates.choose.usedOn', {
                                date: formatDay(item.lastUsedAt),
                              }),
                            ],
                          }
                        : {}),
                    }}
                    checked={checked}
                    onPress={() => firstRun.setSelected(item.skillId, !checked)}
                  />
                );
              })}
            </ItemGroup>
          </>
        )}
      </ItemList>
      {firstRun.eligible ? (
        <PagePinnedBar testID="skills.choose.bar" style={styles.barInset}>
          <PageContentColumn>
          <View style={styles.barRow}>
          <Text variant="body" style={styles.count}>
            {t('capabilities.skillsUpdates.choose.selected', {
              count: firstRun.selectedCount,
            })}
          </Text>
          {firstRun.errorCode ? (
            <SurfaceStateCard
              testID="skills.choose.error"
              size="line"
              kind="error"
              title={t('capabilities.skillsUpdates.choose.failed')}
              diagnosticCode={firstRun.errorCode}
            />
          ) : null}
          <View style={styles.grow} />
          <TextLinkButton
            testID="skills.choose.notNow"
            label={t('capabilities.skillsUpdates.updates.notNow')}
            onPress={notNow}
          />
          <RoundButton
            testID="skills.choose.turnOn"
            size="small"
            title={t('capabilities.skillsUpdates.choose.turnOn', {
              count: firstRun.selectedCount,
            })}
            disabled={firstRun.selectedCount === 0 || firstRun.pending}
            loading={firstRun.pending}
            onPress={() => void turnOn()}
          />
          </View>
          </PageContentColumn>
        </PagePinnedBar>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, backgroundColor: theme.colors.surface.base },
  // The column carries the page gutter, as the list above it does.
  barInset: { paddingHorizontal: 0 },
  barRow: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s16, paddingHorizontal: theme.space.s16 },
  count: { color: theme.colors.text.primary, fontVariant: ['tabular-nums'] },
  grow: { flex: 1 },
  // The way back sits a step under the state's words.
  backAction: { marginTop: theme.space.s16 },
}));
