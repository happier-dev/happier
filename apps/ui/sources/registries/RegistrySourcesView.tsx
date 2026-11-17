import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS, HappierCollectionNavigationBackClosesDetailContext, HappierColumnEdgeContext } from '@happier-dev/plugin-ui/presentation';
import {
  Collection,
  useHappierCollection,
  type CollectionDetailRenderContext,
} from '@happier-dev/plugin-ui/components';
import {
  REGISTRY_FORMAT_KINDS_V1,
  type RegistryFormatV1,
  type RegistryKindV1,
  type RegistrySourceDescriptorV1,
  type RegistryRemoteSourceDescriptorV1,
} from '@happier-dev/protocol/registries';
import type { z } from 'zod/mini';
import type { RegistryDetectedSourceV1Schema } from '@happier-dev/protocol/registries';

import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { PageLeaveActions } from '@/components/ui/layout/PageLeaveActions';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { Text } from '@/components/ui/text/Text';
import { CATALOG_SURFACE_LIST_ROLE } from '@/modal/components/card/commandSurfaceCard';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { describeRegistrySourceStatus } from './describeRegistrySourceStatus';
import {
  registryFormatIcon,
  registryFormatLabel,
  registryItemCountLabel,
  registrySourceKindLabel,
  registrySourceLocation,
  registryTokenHost,
} from './registrySourcePresentation';
import { useRegistryTokenPicker } from './useRegistryTokenPicker';
import { describeRegistrySourceInputFailure, readRegistryFailureStatus } from './describeRegistrySourceStatus';
import { useRegistryItems } from './useRegistryItems';
import { useRegistrySourceMutations } from './useRegistrySourceMutations';
import { useRegistrySources } from './useRegistrySources';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';

type Detected = z.infer<typeof RegistryDetectedSourceV1Schema>;
export type RegistrySourcesViewItemFromSource = Readonly<{
  title: string;
  ref?: string;
  onOpen: () => void;
}>;

const NEW_KEY = 'registry:new';
type Row = Readonly<{ key: string; source: RegistrySourceDescriptorV1 | null }>;
const keyOf = (row: Row) => row.key;
const NEW_ROW: Row = { key: NEW_KEY, source: null };
/** A page's scroller already scrolls: the Collection's page scroll draws no scroller of its own. */
const passThroughScroller = (children: React.ReactNode) => children;

/**
 * Registries, one level in (P4 I-7, lab sa R1/R2): every source that lists this kind as a collection beside its
 * details — rename, use in Browse, refresh, the items added from it, remove — with "New registry" first, which opens
 * the add form (paste a link, live detection, name, Add registry). The same view is the body of Settings → Plugins →
 * Sources (kind "plugin").
 */
export function RegistrySourcesView(
  props: Readonly<{
    kind: RegistryKindV1;
    /** A retained management surface can withdraw acquisition without losing its draft/selection. */
    enabled?: boolean;
    initialIntent?: 'manage' | 'add';
    itemsFromSource?: (
      sourceId: string,
    ) => readonly RegistrySourcesViewItemFromSource[];
    /** A registry was added (or an existing one matched): the opener selects it. */
    onSourceAdded?: (sourceId: string) => void;
    onBack?: () => void;
    /** On a settings page the resting list is one hairline sheet under the header (a modal's list stays flat on its pane). */
    pageSheet?: boolean;
    /**
     * The host page owns the open source in its route. `value` is the route's source, `null` none (a phone's list; a
     * wide page's own default); `onChange` asks the route to open one (`null`: none). An id the Account no longer has
     * is none, and `onStale` asks the route to drop it (a link has no list behind it to pop to).
     * `navigationBackClosesDetail`: opening one pushes a route and the navigation's own Back, which the
     * route's parent resolves to the list, closes it, so the pushed detail draws no Back of its own.
     */
    selection?: Readonly<{
      value: string | null;
      onChange: (next: string | null) => void;
      onStale: () => void;
      navigationBackClosesDetail: boolean;
    }>;
    testID: string;
  }>,
): React.ReactElement {
  const sources = useRegistrySources(props.kind, props.enabled !== false);
  return <RegistrySourcesViewWithSources {...props} registry={sources} />;
}

/** Source management inside an Add flow consumes the same descriptor read as its selector. */
export function RegistrySourcesViewWithSources(
  props: React.ComponentProps<typeof RegistrySourcesView> & Readonly<{ registry: ReturnType<typeof useRegistrySources> }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const sources = props.registry;
  const rows = React.useMemo<readonly Row[]>(
    () => [
      NEW_ROW,
      ...sources.sources.map((source) => ({ key: source.id, source })),
    ],
    [sources.sources],
  );
  // The person's own choice (a source, the add form, or "none"); until they make one the page's default stands:
  // a wide page opens the first registry the person added (else the first one) beside the list, a phone rests on
  // the list and pushes details.
  const [localChoice, setLocalChoice] = React.useState<string | null | undefined>(() =>
    props.initialIntent === 'add' ? NEW_KEY : undefined,
  );
  const phone = useDeviceType() === 'phone';
  const routed = props.selection?.value ?? undefined;
  // Retained rows describe the previous list while a mutation's revision is resolving.
  // Only the settled list can say that a newly selected source no longer exists.
  const settled = !sources.loading && (sources.hasValue || props.enabled !== false);
  const routedIsKnown = routed === NEW_KEY || sources.sources.some((source) => source.id === routed);
  const staleRoute = props.selection !== undefined && routed !== undefined && settled && !routedIsKnown;
  const choice = props.selection ? (staleRoute ? undefined : routed) : localChoice;
  const setOpenKey = props.selection ? props.selection.onChange : setLocalChoice;
  const dropStaleRoute = props.selection?.onStale;
  React.useEffect(() => {
    if (staleRoute) dropStaleRoute?.();
  }, [staleRoute, dropStaleRoute]);
  const defaultKey = React.useMemo(
    () => (sources.sources.find((source) => source.origin.kind === 'user') ?? sources.sources[0])?.id ?? null,
    [sources.sources],
  );
  const openKey = choice !== undefined ? choice : phone ? null : defaultKey;

  const model = useHappierCollection<Row>({
    items: rows,
    keyOf,
    openKey,
    onOpenChange: setOpenKey,
  });
  const mark = React.useCallback(
    (name: IconName) => (
      <Icon
        name={name}
        size={ICON_SIZE.md}
        color={theme.colors.text.secondary}
      />
    ),
    [theme.colors.text.secondary],
  );
  const anatomy = React.useMemo(
    () =>
      buildCapabilityCollectionAnatomy<Row>({
        title: (row) =>
          row.source?.title ?? t('capabilities.registries.view.newRow'),
        description: (row) =>
          row.source === null
            ? t('capabilities.registries.view.newRowBody')
            : locationUnlessTitle(row.source),
        mark: (row) =>
          mark(row.source === null ? 'plus' : registryFormatIcon(row.source)),
        facts: (row) => ({
          presentation: 'row',
          extra:
            row.source === null
              ? []
              : [
                  registrySourceKindLabel(row.source),
                  ...(row.source.enabled
                    ? []
                    : [t('capabilities.registries.format.off')]),
                ],
        }),
        accessibilityLabel: (row) =>
          row.source?.title ?? t('capabilities.registries.view.newRow'),
        testID: (row) => `${props.testID}:row:${row.key}`,
      }),
    [mark, props.testID],
  );

  const renderDetail = (
    key: string,
    context: CollectionDetailRenderContext,
  ) => {
    if (key === NEW_KEY) {
      return (
        <RegistryAddForm
          kind={props.kind}
          pushed={context.pushed}
          onCancel={() => setOpenKey(null)}
          onAdded={(sourceId) => {
            setOpenKey(sourceId);
            props.onSourceAdded?.(sourceId);
          }}
          testID={`${props.testID}:add`}
        />
      );
    }
    const source = sources.sources.find((candidate) => candidate.id === key);
    if (!source) return null;
    return (
      <RegistrySourceDetail
        key={source.id}
        kind={props.kind}
        enabled={props.enabled !== false}
        sourceLoading={sources.loading}
        source={source}
        pushed={context.pushed}
        itemsFromSource={props.itemsFromSource?.(source.id) ?? []}
        onRemoved={() => setOpenKey(null)}
        testID={`${props.testID}:detail`}
      />
    );
  };

  const resting = phone || openKey === null;
  // On a settings page the resting list is the page's sheet (page scroll), under the header; the page already scrolls.
  const pageResting = props.pageSheet === true && openKey === null;
  return (
    <CoreCollectionScope {...(pageResting ? { renderPageScroller: passThroughScroller } : {})}>
      <HappierCollectionNavigationBackClosesDetailContext.Provider value={props.selection?.navigationBackClosesDetail === true}>
      <View style={[styles.fill, resting && !pageResting ? styles.restingGutter : null]} testID={props.testID}>
        <Collection<Row>
          {...(pageResting ? { scroll: 'page' as const } : {})}
          model={model}
          anatomy={anatomy}
          accessibilityLabel={t('capabilities.registries.view.listLabel')}
          presentation="list"
          detail="auto"
          renderDetail={renderDetail}
          minListWidth={CATALOG_SURFACE_LIST_ROLE.minListWidthPx}
          minDetailWidth={CATALOG_SURFACE_LIST_ROLE.minDetailWidthPx}
          preferredListRatio={CATALOG_SURFACE_LIST_ROLE.preferredListRatio}
          loading={sources.loading && !sources.hasValue}
          testID={`${props.testID}:collection`}
          listTestID={`${props.testID}:list`}
          detailTestID={`${props.testID}:detail-pane`}
        />
      </View>
      </HappierCollectionNavigationBackClosesDetailContext.Provider>
    </CoreCollectionScope>
  );
}

/**
 * The source's token (P4 F4): names where it is sent before the tap, binds a private Saved Secret through
 * `registries.sources.token.set` (applied directly, D22) and offers Undo for the change just made.
 */
function RegistrySourceTokenRow(props: Readonly<{ source: RegistryRemoteSourceDescriptorV1; sourceLoading: boolean; testID: string }>) {
  const { theme } = useUnistyles();
  const { source } = props;
  const mutations = useRegistrySourceMutations();
  const picker = useRegistryTokenPicker();
  const [busy, setBusy] = React.useState(false);
  const [last, setLast] = React.useState<Readonly<{ added: boolean; previous: RegistryRemoteSourceDescriptorV1['token'] | null }> | null>(null);
  const [failed, setFailed] = React.useState(false);
  const host = registryTokenHost(source.url);
  const currentRef = source.token?.secretRef ?? null;
  const currentName = picker.nameOf(currentRef);
  const apply = React.useCallback((token: RegistryRemoteSourceDescriptorV1['token'] | null, undo: boolean) => {
    const previous = source.token ?? null;
    setBusy(true);
    setFailed(false);
    mutations.setToken({ sourceId: source.id, token })
      .then(() => setLast(undo ? null : { added: token !== null, previous }))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }, [mutations, source.id, source.token]);
  const choose = React.useCallback((event?: unknown) => picker.pick({
    anchor: resolvePressTriggerAnchor(event),
    selectedId: currentRef,
    includeNoneRow: currentRef !== null,
    onSelectId: (secretRef) => {
      if (secretRef === currentRef) return;
      apply(secretRef === null ? null : { secretRef }, false);
    },
  }), [apply, currentRef, picker]);
  const subtitle = failed ? t('capabilities.registries.detail.updateFailed')
    : last ? (last.added ? t('capabilities.registries.detail.tokenAdded') : t('capabilities.registries.detail.tokenRemoved'))
    : currentRef !== null ? t('capabilities.registries.detail.tokenSet', { name: currentName ?? t('capabilities.registries.detail.tokenTitle'), host })
    : t('capabilities.registries.detail.tokenNone', { host });
  return (
    <Item
      testID={props.testID}
      title={t('capabilities.registries.detail.tokenTitle')}
      subtitle={subtitle}
      subtitleLines={0}
      {...(failed ? { subtitleStyle: { color: theme.colors.status.error } } : {})}
      rightElement={
        <View style={styles.tokenActions}>
          {last ? (
            <RoundButton size="small" display="secondary" title={t('capabilities.registries.detail.undo')}
              disabled={busy || props.sourceLoading || !mutations.ready} onPress={() => apply(last.previous, true)} testID={`${props.testID}:undo`} />
          ) : null}
          {/* Dismissing the sheet never clears a token; removing it is this explicit action (Undo brings it back). */}
          {currentRef !== null ? (
            <RoundButton size="small" display="secondary" title={t('common.remove')}
              disabled={busy || props.sourceLoading || !mutations.ready} onPress={() => apply(null, false)} testID={`${props.testID}:remove`} />
          ) : null}
          <RoundButton size="small" display="secondary"
            title={currentRef === null ? t('capabilities.registries.detail.tokenAdd') : t('capabilities.registries.detail.tokenChange')}
            loading={busy || props.sourceLoading} disabled={busy || props.sourceLoading || !mutations.ready} onPress={choose} testID={`${props.testID}:choose`} />
        </View>
      }
    />
  );
}

/**
 * One details column: the body scrolls, the footer (its one primary, or the way out) stays. It is a pane, not a
 * page, so its header draws its own title and never takes the settings page's back control or navigation title
 * (the page header above already carries both).
 */
function DetailFrame(
  props: Readonly<{
    children: React.ReactNode;
    footer?: React.ReactNode;
    pushed?: boolean;
  }>,
) {
  return (
    <NavigationTitleChromeProvider showsTitle={false}>
    <NavigationBackChromeProvider control={null}>
      <View style={styles.fill}>
        <ScrollView
          style={styles.fill}
          contentContainerStyle={[
            styles.body,
            props.pushed ? styles.bodyPushed : null,
          ]}
        >
          {/* The body pads its content by the page's text inset, so the identity header's title sits on the edge of the sections under it. */}
          {props.pushed ? props.children : (
            <HappierColumnEdgeContext.Provider value={HAPPIER_PAGE_METRICS.pageTextInsetPx}>{props.children}</HappierColumnEdgeContext.Provider>
          )}
        </ScrollView>
        {props.footer ? <View style={[styles.footer, props.pushed ? styles.footerPushed : null]}>{props.footer}</View> : null}
      </View>
    </NavigationBackChromeProvider>
    </NavigationTitleChromeProvider>
  );
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function RegistrySourceDetail(
  props: Readonly<{
    kind: RegistryKindV1;
    enabled: boolean;
    sourceLoading: boolean;
    source: RegistrySourceDescriptorV1;
    pushed: boolean;
    itemsFromSource: readonly RegistrySourcesViewItemFromSource[];
    onRemoved: () => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { source } = props;
  const mutations = useRegistrySourceMutations();
  const [name, setName] = React.useState(source.title);
  const lifetime = useActiveServerAccountScopeLifetime();
  const noticeKey = `registry-source:${JSON.stringify(lifetime?.scope)}:${source.id}`;
  React.useEffect(() => {
    const retirement = lifetime?.onRetire(() => retirePresentationNotice(noticeKey));
    return () => { retirement?.dispose(); retirePresentationNotice(noticeKey); };
  }, [lifetime, noticeKey]);
  const [busy, setBusy] = React.useState<'remove' | 'enable' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // The page of this source answers count, status and "Checked HH:MM"; it reads only while the source is on.
  const items = useRegistryItems(
    { kind: props.kind, sourceIds: [source.id] },
    props.enabled && source.enabled,
  );
  const page =
    items.pages.find((candidate) => candidate.sourceId === source.id) ?? null;
  // Unknown is not zero: a source that failed to answer has no count.
  const count =
    page === null || page.status.state !== 'ok'
      ? undefined
      : (page.total ??
        (page.nextCursor === null ? page.items.length : undefined));
  const status = page?.status ?? null;
  const failure =
    status !== null && status.state !== 'ok'
      ? describeRegistrySourceStatus(status)
      : null;
  const editable = source.origin.kind === 'user';
  const purpose =
    source.origin.kind === 'built_in'
      ? t('capabilities.registries.detail.builtInPurpose')
      : source.origin.kind === 'plugin'
        ? t('capabilities.registries.detail.pluginPurpose', {
            plugin: source.origin.pluginId,
          })
        : t('capabilities.registries.detail.userPurpose', { kind: props.kind });

  const commitName = React.useCallback(() => {
    const next = name.trim();
    if (!editable || next === '' || next === source.title) return;
    setError(null);
    mutations
      .update({ sourceId: source.id, title: next })
      .then(() => { if (!lifetime?.isCurrent()) return; publishPresentationNotice({ key: noticeKey, message: next, severity: 'info',
        undo: { label: t('bots.undo'), run: () => {
          if (!lifetime.isCurrent()) return;
          void mutations.update({ sourceId: source.id, title: source.title }).then(result => {
            if (!lifetime.isCurrent()) return;
            setName(result.source.title);
            retirePresentationNotice(noticeKey);
          }).catch(() => { if (lifetime.isCurrent()) publishPresentationNotice({ key: noticeKey,
            message: t('capabilities.registries.detail.updateFailed'), severity: 'error' }); });
        } } }); })
      .catch(() => setError(t('capabilities.registries.detail.updateFailed')));
  }, [editable, mutations, name, source.id, source.title, lifetime, noticeKey]);
  const setEnabled = React.useCallback(
    (enabled: boolean) => {
      setBusy('enable');
      setError(null);
      mutations
        .update({ sourceId: source.id, enabled })
        .then(() => { if (!lifetime?.isCurrent()) return; publishPresentationNotice({ key: noticeKey, message: source.title, severity: 'info',
          undo: { label: t('bots.undo'), run: () => {
            if (!lifetime.isCurrent()) return;
            void mutations.update({ sourceId: source.id, enabled: source.enabled }).then(() => {
              if (lifetime.isCurrent()) retirePresentationNotice(noticeKey);
            }).catch(() => { if (lifetime.isCurrent()) publishPresentationNotice({ key: noticeKey,
              message: t('capabilities.registries.detail.updateFailed'), severity: 'error' }); });
          } } }); })
        .catch(() => setError(t('capabilities.registries.detail.updateFailed')))
        .finally(() => setBusy(null));
    },
    [mutations, source.id, source.enabled, source.title, lifetime, noticeKey],
  );
  const remove = React.useCallback(() => {
    setBusy('remove');
    setError(null);
    mutations
      .delete(source.id)
      .then(() => props.onRemoved())
      .catch((failure: unknown) => {
        // A declined confirmation is the person's answer, not a failure.
        const code = (failure as { code?: string } | null)?.code;
        if (code === 'approval_denied' || code === 'approval_canceled')
          return;
        setError(t('capabilities.registries.detail.removeFailed'));
      })
      .finally(() => setBusy(null));
  }, [mutations, props, source.id]);

  const checked =
    status?.state === 'ok'
      ? t('capabilities.registries.detail.checked', {
          time: formatClock(status.fetchedAt),
        })
      : null;
  // The count already leads the header's facts; the refresh line says only when it was read.
  const refreshLine = checked ?? t('capabilities.registries.detail.notChecked');

  return (
    <DetailFrame
      pushed={props.pushed}
      footer={
        editable ? (
          <PageLeaveActions
            testID={`${props.testID}:leave`}
            actions={[
              {
                label: t('capabilities.registries.detail.remove'),
                icon: 'trash',
                display: 'bordered',
                busy: busy === 'remove',
                disabled: !mutations.ready,
                onPress: remove,
                testID: `${props.testID}:remove`,
              },
            ]}
            footnote={t('capabilities.registries.detail.removeNote', {
              kind: props.kind,
            })}
          />
        ) : undefined
      }
    >
      <CapabilityDetailHeader
        testID={`${props.testID}:header`}
        mark={
          <Icon
            name={registryFormatIcon(source)}
            size={ICON_SIZE.lg}
            color={theme.colors.text.primary}
          />
        }
        title={source.title}
        purpose={purpose}
        facts={{
          extra: [
            registrySourceKindLabel(source),
            ...(count === undefined
              ? []
              : [registryItemCountLabel(props.kind, count)!]),
          ],
        }}
      />
      {error ? (
        <Text
          variant="meta"
          style={{ color: theme.colors.status.error }}
          testID={`${props.testID}:error`}
        >
          {error}
        </Text>
      ) : null}
      {editable ? (
        <ItemGroup
          title={t('capabilities.registries.detail.nameTitle')}
          description={t('capabilities.registries.detail.nameBody')}
        >
          <SectionContentRow>
            <FieldTextInput
              testID={`${props.testID}:name`}
              value={name}
              editable={mutations.ready}
              onChangeText={setName}
              onBlur={commitName}
              onSubmitEditing={commitName}
              returnKeyType="done"
              accessibilityLabel={t('capabilities.registries.detail.nameTitle')}
            />
          </SectionContentRow>
        </ItemGroup>
      ) : null}
      <ItemGroup title={t('capabilities.registries.detail.sourceTitle')}>
        <Item
          title={registrySourceLocation(source)}
          titleStyle={styles.mono}
          subtitle={
            !('packageContent' in source) && source.ref
              ? t('capabilities.registries.detail.refOn', { ref: source.ref })
              : undefined
          }
        />
        <Item
          testID={`${props.testID}:refresh`}
          title={t('capabilities.registries.detail.refresh')}
          subtitle={failure ?? refreshLine}
          subtitleLines={0}
          {...(failure
            ? { subtitleStyle: { color: theme.colors.state.warning.textForeground } }
            : {})}
          rightElement={
            <RoundButton
              size="small"
              display="secondary"
              title={t('capabilities.registries.detail.refreshNow')}
              leading={
                <Icon
                  name="arrows-clockwise"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.primary}
                />
              }
              loading={items.loading && source.enabled}
              disabled={!source.enabled}
              onPress={() => void items.refresh()}
              testID={`${props.testID}:refresh-now`}
            />
          }
        />
        {editable && !('packageContent' in source) ? (
          <RegistrySourceTokenRow source={source} sourceLoading={props.sourceLoading} testID={`${props.testID}:token`} />
        ) : null}
        <Item
          title={t('capabilities.registries.detail.useTitle')}
          subtitle={t('capabilities.registries.detail.useBody', {
            kind: props.kind,
          })}
          subtitleLines={0}
          rightElement={
            <Switch
              testID={`${props.testID}:enabled`}
              value={source.enabled}
              disabled={busy === 'enable' || !mutations.ready}
              onValueChange={setEnabled}
            />
          }
        />
      </ItemGroup>
      {props.itemsFromSource.length > 0 ? (
        <ItemGroup
          title={t('capabilities.registries.detail.fromItTitle', {
            kind: props.kind,
          })}
        >
          {props.itemsFromSource.map((item, index) => (
            <Item
              key={`${item.title}:${index}`}
              testID={`${props.testID}:from:${index}`}
              title={item.title}
              subtitle={
                item.ref
                  ? t('capabilities.registries.detail.fromItRow', {
                      ref: item.ref,
                    })
                  : t('capabilities.registries.detail.fromItRowNoRef')
              }
              showChevron
              onPress={item.onOpen}
            />
          ))}
        </ItemGroup>
      ) : null}
    </DetailFrame>
  );
}

/** The formats this kind can be browsed from, each with its words ("What you can add"). */
function addableFormats(kind: RegistryKindV1): readonly RegistryFormatV1[] {
  return (
    [
      'git',
      'claude-marketplace',
      'mcp-registry',
      'acp-registry',
      'happier-catalog',
    ] as const
  ).filter((format) => REGISTRY_FORMAT_KINDS_V1[format].includes(kind));
}
function formatOption(
  format: RegistryFormatV1,
  kind: RegistryKindV1,
): Readonly<{ title: string; body: string }> {
  switch (format) {
    case 'claude-marketplace':
      return {
        title: t('capabilities.registries.add.marketplaceTitle'),
        body: t('capabilities.registries.add.marketplaceBody'),
      };
    case 'mcp-registry':
      return {
        title: t('capabilities.registries.add.mcpRegistryTitle'),
        body: t('capabilities.registries.add.mcpRegistryBody'),
      };
    case 'acp-registry':
      return {
        title: t('capabilities.registries.add.acpRegistryTitle'),
        body: t('capabilities.registries.add.acpRegistryBody'),
      };
    case 'happier-catalog':
      return {
        title: t('capabilities.registries.add.catalogTitle'),
        body: t('capabilities.registries.add.catalogBody'),
      };
    default:
      return {
        title: t('capabilities.registries.add.gitTitle'),
        body: t('capabilities.registries.add.gitBody', { kind }),
      };
  }
}
function unsupportedCopy(
  reason: Extract<Detected, { unsupported: string }>['unsupported'],
  formats: string,
): string {
  switch (reason) {
    case 'organisation':
      return t('capabilities.registries.add.organisation');
    case 'unreachable':
      return t('capabilities.registries.add.unreachable');
    default:
      return t('capabilities.registries.add.unknownFormat', { formats });
  }
}
function looksLikeLink(value: string): boolean {
  return /^https?:\/\/[^\s/]+\.[^\s/]+/.test(value.trim());
}

/** Typing settles before the link is checked (one detect per pause, never per keystroke). */
const DETECT_SETTLE_MS = 400;

function RegistryAddForm(
  props: Readonly<{
    kind: RegistryKindV1;
    pushed: boolean;
    onCancel: () => void;
    onAdded: (sourceId: string) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const mutations = useRegistrySourceMutations();
  const [link, setLink] = React.useState('');
  const [name, setName] = React.useState('');
  const [nameTouched, setNameTouched] = React.useState(false);
  const [detection, setDetection] = React.useState<
    | Readonly<{ state: 'idle' }>
    | Readonly<{ state: 'checking'; url: string }>
    | Readonly<{ state: 'done'; url: string; detected: Detected }>
    | Readonly<{ state: 'failed'; url: string; failure: unknown }>
  >({ state: 'idle' });
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [token, setToken] = React.useState<string | null>(null);
  const picker = useRegistryTokenPicker();

  React.useEffect(() => {
    const url = link.trim();
    if (!looksLikeLink(url)) {
      setDetection({ state: 'idle' });
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      setDetection({ state: 'checking', url });
      mutations
        .detect({ url })
        .then((result) => {
          if (!current) return;
          setDetection({ state: 'done', url, detected: result.detected });
          if ('title' in result.detected && !nameTouched)
            setName(result.detected.title);
        })
        .catch((failure: unknown) => {
          if (current) setDetection({ state: 'failed', url, failure });
        });
    }, DETECT_SETTLE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // The name follows detection until the person types one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, mutations.detect]);

  const formats = addableFormats(props.kind);
  const supportedFormatTitles = formats.map(format => formatOption(format, props.kind).title).join(', ');
  const currentDetection = detection.state !== 'idle' && detection.url === link.trim() ? detection : null;
  const detected = currentDetection?.state === 'done' ? currentDetection.detected : null;
  const supported =
    detected !== null &&
    'format' in detected &&
    detected.kinds.includes(props.kind)
      ? detected
      : null;
  // A registry that asks for a token is not an error: the token row asks for it, and the add detects again with it.
  const needsToken =
    detected !== null &&
    'unsupported' in detected &&
    detected.unsupported === 'needs_token';
  const fieldError =
    currentDetection?.state === 'failed'
      ? describeRegistrySourceInputFailure(currentDetection.failure)
      : detected !== null && 'unsupported' in detected && !needsToken
        ? unsupportedCopy(detected.unsupported, supportedFormatTitles)
        : detected !== null && supported === null && !needsToken
          ? t('capabilities.registries.add.unknownFormat', { formats: supportedFormatTitles })
          : null;
  const canAdd = supported !== null || (needsToken && token !== null);

  const submit = React.useCallback(async () => {
    if (!canAdd) return;
    setAdding(true);
    setError(null);
    try {
      const result = await mutations.create({
        url: link.trim(),
        ...(name.trim() ? { title: name.trim() } : {}),
        kinds: [props.kind],
        ...(needsToken && token !== null ? { token: { secretRef: token } } : {}),
      });
      props.onAdded(result.source.id);
    } catch (failure) {
      const rejected =
        readRegistryFailureStatus((failure as { result?: { details?: unknown } } | null)?.result?.details)?.state === 'auth_failed';
      setError(t(rejected ? 'capabilities.registries.add.tokenRejected' : 'capabilities.registries.add.failed'));
    } finally {
      setAdding(false);
    }
  }, [canAdd, link, mutations, name, needsToken, props, token]);

  return (
    <DetailFrame
      pushed={props.pushed}
      footer={
        <View style={styles.formFooter}>
          {error ? (
            <Text
              variant="meta"
              style={[styles.footerStart, { color: theme.colors.status.error }]}
            >
              {error}
            </Text>
          ) : (
            <View style={styles.footerStart} />
          )}
          <RoundButton
            size="normal"
            display="inverted"
            title={t('capabilities.registries.add.cancel')}
            onPress={props.onCancel}
            testID={`${props.testID}:cancel`}
          />
          <RoundButton
            size="normal"
            title={t('capabilities.registries.add.submit')}
            loading={adding}
            disabled={!canAdd}
            onPress={() => void submit()}
            testID={`${props.testID}:submit`}
          />
        </View>
      }
    >
      <View style={styles.formHead}>
        <Text variant="title" emphasis="semiBold" style={{ color: theme.colors.text.primary }}>
          {t('capabilities.registries.add.title')}
        </Text>
        <Text variant="reading" style={{ color: theme.colors.text.secondary }}>
          {t('capabilities.registries.add.purpose', { kind: props.kind })}
        </Text>
      </View>
      <ItemGroup>
        <Item
          title={t('capabilities.registries.add.link')}
          accessoryLayout="stacked"
          rightElement={
            <View style={styles.stack}>
              <FieldTextInput
                testID={`${props.testID}:link`}
                value={link}
                onChangeText={setLink}
                placeholder={t('capabilities.registries.add.linkPlaceholder')}
                accessibilityLabel={t('capabilities.registries.add.link')}
                autoCapitalize="none"
                autoFocus
                monospace
                inputMode="url"
                error={fieldError}
              />
              {currentDetection?.state === 'checking' ? (
                <Text
                  variant="meta"
                  style={{ color: theme.colors.text.secondary }}
                  testID={`${props.testID}:checking`}
                >
                  {t('capabilities.registries.add.checking')}
                </Text>
              ) : null}
            </View>
          }
        />
        {needsToken ? (
          <Item
            testID={`${props.testID}:token`}
            title={t('capabilities.registries.detail.tokenTitle')}
            subtitle={
              token === null
                ? t('capabilities.registries.add.needsToken', { host: registryTokenHost(link.trim()) })
                : t('capabilities.registries.detail.tokenSet', {
                    name: picker.nameOf(token) ?? t('capabilities.registries.detail.tokenTitle'),
                    host: registryTokenHost(link.trim()),
                  })
            }
            subtitleLines={0}
            rightElement={
              <RoundButton
                size="small"
                display="secondary"
                title={token === null ? t('capabilities.registries.detail.tokenAdd') : t('capabilities.registries.detail.tokenChange')}
                onPress={(event) =>
                  picker.pick({ anchor: resolvePressTriggerAnchor(event), selectedId: token, includeNoneRow: false, onSelectId: (secretRef) => setToken(secretRef) })
                }
                testID={`${props.testID}:token:choose`}
              />
            }
          />
        ) : null}
        {supported !== null ? (
          <Item
            testID={`${props.testID}:detected`}
            icon={
              <Icon
                name={registryFormatIcon({ id: '', format: supported.format })}
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            }
            title={supported.title}
            subtitle={[
              registryFormatLabel(supported.format),
              supported.itemCount === undefined
                ? t('capabilities.registries.add.foundNoCount')
                : t('capabilities.registries.add.found', {
                    kind: props.kind,
                    count: supported.itemCount,
                  }),
            ].join(' · ')}
            rightElement={
              <Icon
                name="check"
                size={ICON_SIZE.sm}
                color={theme.colors.text.primary}
              />
            }
          />
        ) : null}
      </ItemGroup>
      {supported !== null ? (
        <ItemGroup>
          <Item
            title={t('capabilities.registries.add.name')}
            accessoryLayout="stacked"
            rightElement={
              <FieldTextInput
                testID={`${props.testID}:name`}
                value={name}
                onChangeText={(next) => {
                  setNameTouched(true);
                  setName(next);
                }}
                accessibilityLabel={t('capabilities.registries.add.name')}
              />
            }
          />
        </ItemGroup>
      ) : (
        <ItemGroup title={t('capabilities.registries.add.whatYouCanAdd')}>
          {formats.map((format) => {
            const option = formatOption(format, props.kind);
            return (
              <Item
                key={format}
                icon={
                  <Icon
                    name={registryFormatIcon({ id: '', format })}
                    size={ICON_SIZE.md}
                    color={theme.colors.text.secondary}
                  />
                }
                title={option.title}
                subtitle={option.body}
              />
            );
          })}
        </ItemGroup>
      )}
    </DetailFrame>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  tokenActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  body: {
    paddingHorizontal: theme.space.s32,
    paddingTop: theme.space.s24,
    paddingBottom: theme.space.s24,
    gap: theme.space.s8,
  },
  // The resting list (a phone, or no detail open) sits on the page edges, so the page gives it its gutter; a
  // phone's pushed detail inside takes the same one.
  restingGutter: { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
  bodyPushed: {
    paddingHorizontal: 0,
    paddingTop: theme.space.s8,
  },
  // On a phone the footer's content sits on the sheets' edge above it.
  footerPushed: { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
  footer: {
    paddingHorizontal: theme.space.s24,
    paddingVertical: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  formFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  footerStart: { flex: 1, minWidth: 0 },
  formHead: { gap: theme.space.s8, paddingBottom: theme.space.s8 },
  stack: { gap: theme.space.s8, alignSelf: 'stretch' },
  mono: { ...Typography.mono() },
}));

/** A built-in whose link is its name ("skills.sh") gets no second line repeating it. */
function locationUnlessTitle(source: RegistrySourceDescriptorV1): string | null {
  const location = registrySourceLocation(source);
  return location === source.title ? null : location;
}
