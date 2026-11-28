import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierListDetailLayout } from '@happier-dev/plugin-ui/presentation';
import type { BotTemplateReleaseSourceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { BOTS_GLYPH } from '@/components/sessions/bots/botsGlyph';
import { openNewBotDraft } from '@/components/sessions/bots/newBotDraft';
import { useAskHappierOpener } from '@/components/sessions/bots/useAskHappierOffer';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { BotTemplateRecipientScreen } from '@/components/sessions/bots/templates/BotTemplateRecipientScreen';
import { useBundledBotTemplates } from '@/components/store/BundledBotTemplateSection';
import { useReceivedBotTemplates } from '@/components/store/catalog/useReceivedBotTemplates';
import {
  useStoreBotTemplateItem,
  type StoreBotTemplateItemRef,
} from '@/components/store/catalog/useStoreBotTemplateItem';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { CustomModalInjectedProps } from '@/modal';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';

/** A template's mark in the list: the face it will wear, at the list's identity size (lab N1). */
const ROW_MARK_PX = 28;
/** The list column (lab N1: search, the two ways in, then every template) and the details beside it. */
const LIST_MIN_WIDTH_PX = 300;
const DETAIL_MIN_WIDTH_PX = 420;
const LIST_RATIO = 0.4;

type Choice =
  | Readonly<{ kind: 'store'; key: string; item: StoreBotTemplateItemRef }>
  | Readonly<{
      kind: 'source';
      key: string;
      source: BotTemplateReleaseSourceV1;
    }>;

export type NewBotChooserProps = CustomModalInjectedProps;

/**
 * New bot: one card for every way in (lab session-orchestration N1, owner R6). Edge to edge with no title band and a
 * quiet × in the corner. Left: search, Blank bot and Ask Happier, then every template people can copy. Right: the
 * chosen template's own page, whose Make your own form creates the Bot. Nothing is created from this card itself.
 */
export function NewBotChooser(props: NewBotChooserProps) {
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const scope = useAccountSettingsScope();
  const [query, setQuery] = React.useState('');
  const [choice, setChoice] = React.useState<Choice | null>(null);
  const store = useRegistryItems(
    { kind: 'plugin', contributionFamily: 'botTemplates', query },
    true,
  );
  const received = useReceivedBotTemplates(query, true);
  const bundled = useBundledBotTemplates(query);
  const { onClose } = props;
  // The same owners the roster's New bot and Ask Happier use, mounted here so they outlive the roster that opened
  // this card: Blank bot opens the ordinary Bot draft (the composer's Send creates it), Ask Happier its guide.
  const { execute: executeAuthoring } = useMountedActionExecution(scope);
  const openAskHappier = useAskHappierOpener();
  const blank = React.useCallback(() => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) return;
    fireAndForget(
      openNewBotDraft(lifetime, executeAuthoring).then((result) => {
        if (result.kind === 'opened') onClose();
      }),
      { tag: 'NewBot.blank' },
    );
  }, [executeAuthoring, onClose]);
  const ask = React.useCallback(() => {
    fireAndForget(
      openAskHappier().then((result) => {
        if (result.kind === 'opened' || result.kind === 'authenticationRequired') onClose();
      }),
      { tag: 'NewBot.ask' },
    );
  }, [onClose, openAskHappier]);
  const close = (
    <View style={styles.close}>
      <IconButton
        testID="new-bot.close"
        iconName="x"
        variant="plain"
        accessibilityLabel={t('common.close')}
        tooltip={t('common.close')}
        onPress={onClose}
      />
    </View>
  );

  const list = (
    <ScrollView
      testID="new-bot.list"
      style={styles.fill}
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
    >
      <CompactSearchField
        testID="new-bot.search"
        value={query}
        onChangeText={setQuery}
        placeholder={t('botTemplates.newBotSearch')}
        placement="inline"
      />
      <ItemGroup surface="none">
        <Item
          testID="new-bot.blank"
          title={t('botTemplates.blankBot')}
          subtitle={t('botTemplates.blankBotHint')}
          icon={<Icon name="plus" color={theme.colors.text.secondary} />}
          showChevron={false}
          onPress={blank}
        />
        <Item
          testID="new-bot.ask"
          title={t('bots.guide.offer')}
          subtitle={t('botTemplates.askHappierHint')}
          icon={<Icon name="sparkle" color={theme.colors.text.secondary} />}
          showChevron={false}
          onPress={ask}
        />
      </ItemGroup>
      {bundled.length > 0 ? (
        <ItemGroup
          testID="new-bot.bundled"
          title={t('botTemplates.fromHappier')}
          titleLeading={<Icon name="seal-check" />}
          surface="none"
        >
          {bundled.map(({ source, identity }) => {
            const key = `bundled.${source.contributionId}`;
            return (
              <Item
                key={key}
                testID={`new-bot.template.${key}`}
                title={identity.name}
                subtitle={identity.description}
                subtitleLines={1}
                showChevron={false}
                selected={choice?.key === key}
                icon={
                  <SessionBotFace
                    facts={{ seed: source.contributionId, face: identity.face ?? null }}
                    size={ROW_MARK_PX}
                    motion={false}
                  />
                }
                onPress={() => setChoice({ kind: 'source', key, source })}
              />
            );
          })}
        </ItemGroup>
      ) : null}
      {received.items.length > 0 ? (
        <ItemGroup title={t('botTemplates.sharedWithYou')} surface="none">
          {received.items.map((item) => {
            const key = item.source.artifactId;
            return (
              <Item
                key={key}
                testID={`new-bot.template.${key}`}
                title={item.identity.name}
                subtitle={item.identity.description}
                subtitleLines={1}
                showChevron={false}
                selected={choice?.key === key}
                icon={
                  <SessionBotFace
                    facts={{ seed: key, face: item.identity.face ?? null }}
                    size={ROW_MARK_PX}
                    motion={false}
                  />
                }
                onPress={() =>
                  setChoice({ kind: 'source', key, source: item.source })
                }
              />
            );
          })}
        </ItemGroup>
      ) : null}
      <ItemGroup title={t('botTemplates.fromStore')} surface="none">
        {store.items.length === 0 && store.loading ? (
          <SurfaceStateCard
            kind="loading"
            size="line"
            title={t('common.loading')}
          />
        ) : store.items.length === 0 && store.error ? (
          <SurfaceStateCard
            kind="error"
            size="line"
            title={t('botTemplates.unavailable')}
            action={
              store.refresh
                ? {
                    label: t('common.retry'),
                    onPress: () => {
                      void store.refresh?.();
                    },
                  }
                : undefined
            }
          />
        ) : (
          store.items.map((item) => {
            const key = `plugin|${item.sourceId}|${item.itemId}`;
            return (
              <Item
                key={key}
                testID={`new-bot.template.${key}`}
                title={item.title}
                subtitle={item.description ?? undefined}
                subtitleLines={1}
                showChevron={false}
                selected={choice?.key === key}
                icon={
                  item.brandMark ? (
                    <HappierBrandMark
                      brand={item.brandMark}
                      pixelSize={ROW_MARK_PX}
                    />
                  ) : (
                    <SessionBotFace
                      facts={{ seed: item.itemId, face: null }}
                      size={ROW_MARK_PX}
                      motion={false}
                    />
                  )
                }
                onPress={() =>
                  setChoice({
                    kind: 'store',
                    key,
                    item: {
                      sourceId: item.sourceId,
                      itemId: item.itemId,
                      ...(item.version ? { version: item.version } : {}),
                    },
                  })
                }
              />
            );
          })
        )}
      </ItemGroup>
    </ScrollView>
  );

  const detail =
    choice && scope ? (
      <View style={styles.fill}>
        {phone ? (
          <View style={styles.phoneBack}>
            <IconButton
              testID="new-bot.back"
              iconName="caret-left"
              variant="plain"
              accessibilityLabel={t('common.back')}
              onPress={() => setChoice(null)}
            />
          </View>
        ) : null}
        {choice.kind === 'source' ? (
          <BotTemplateRecipientScreen
            key={choice.key}
            source={choice.source}
            serverId={scope.serverId}
          />
        ) : (
          <StoreTemplateDetail
            key={choice.key}
            item={choice.item}
            serverId={scope.serverId}
          />
        )}
      </View>
    ) : null;

  return (
    <View testID="new-bot" style={styles.root}>
      <HappierListDetailLayout
        testID="new-bot.split"
        minListWidth={LIST_MIN_WIDTH_PX}
        minDetailWidth={DETAIL_MIN_WIDTH_PX}
        preferredListRatio={LIST_RATIO}
        stackedPane={choice ? 'detail' : 'list'}
        list={list}
        detail={detail}
        idleDetail={
          <View testID="new-bot.idle" style={styles.idle}>
            <Icon name={BOTS_GLYPH} color={theme.colors.text.secondary} />
            <Text variant="body" style={styles.idleText}>
              {t('botTemplates.newBotIdle')}
            </Text>
          </View>
        }
        style={styles.fill}
        listStyle={styles.listPane}
        detailStyle={styles.detailPane}
      />
      {close}
    </View>
  );
}

/** A Store row's template: the Store's own reading of the plugin, then that template's page. */
function StoreTemplateDetail(
  props: Readonly<{ item: StoreBotTemplateItemRef; serverId: string }>,
) {
  const { read, templates, sourceOf, onlySource } = useStoreBotTemplateItem(
    props.item,
    true,
  );
  // A plugin that carries several templates opens on its first; its page names the others' plugin.
  const source =
    onlySource ?? (templates[0] ? sourceOf(templates[0].id) : null);
  if (source)
    return (
      <BotTemplateRecipientScreen
        key={JSON.stringify(source)}
        source={source}
        serverId={props.serverId}
      />
    );
  if (read.error || (!read.loading && !read.stale)) {
    return (
      <SurfaceStateCard
        kind="error"
        size="line"
        title={t('botTemplates.unavailable')}
        action={{ label: t('common.retry'), onPress: read.refresh }}
      />
    );
  }
  return (
    <SurfaceStateCard kind="loading" size="line" title={t('common.loading')} />
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
  },
  fill: {
    flex: 1,
    minHeight: 0,
  },
  // The list stands on the inset plane; the details are the paper it lifts onto (lab N1).
  listPane: {
    backgroundColor: theme.colors.surface.inset,
  },
  detailPane: {
    backgroundColor: theme.colors.surface.elevated,
  },
  listContent: {
    gap: theme.space.s8,
    padding: theme.space.s12,
  },
  close: {
    position: 'absolute',
    top: theme.space.s8,
    right: theme.space.s8,
  },
  phoneBack: {
    paddingHorizontal: theme.space.s8,
    paddingTop: theme.space.s8,
  },
  idle: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.s8,
    padding: theme.space.s24,
  },
  idleText: {
    color: theme.colors.text.secondary,
    textAlign: 'center',
    maxWidth: 280,
  },
}));
