import { DeploymentTemplateMappingCorrection } from '@/components/projects/deployments/DeploymentTemplateMappingCorrection';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { appListingCatalogFacts, appListingProse } from './catalog/storeAppListingFacts';
import * as React from 'react';
import { useStoreMachineScope } from '@/components/settings/plugins/model/useStoreMachineScope';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  CapabilityAddDetailAction,
  CapabilityListingDetail,
  type CapabilityListingConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityListingSections } from '@/components/capabilities/add/CapabilityListingSections';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { admitRegistrySummaryMark } from '@/registries/registryBrandMark';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { Modal } from '@/modal';
import { t } from '@/text';

import { catalogText, showStoreAppPreparation } from './StoreAppPreparation';
import { StoreAddToPresetButton, StorePresetEditorHandoff, type StorePresetChoice } from './presets/StoreAddToPreset';
import { storeAppPresetItem, type StorePresetDoorItem } from './presets/storePresetDoor';
import {
  useStoreAppListing,
  type StoreAppListingSelection,
  type StoreAppListingState,
} from './useStoreAppListing';

export type StoreAppListingControllerState = Readonly<{
  listing: StoreAppListingState | null;
  lifetime: ServerAccountScopeLifetime | null;
}>;

/**
 * The App listing's data leaf (STORE-EDITORIAL's one hook): mounted only once the active Registry Account
 * exists, and read only while the listing is presented.
 */
export function StoreAppListingController(
  props: Readonly<{
    selection: StoreAppListingSelection;
    children: (state: StoreAppListingControllerState) => React.ReactNode;
  }>,
): React.ReactNode {
  const lifetime = useActiveServerAccountScopeLifetime();
  const { sourceId, itemId, version } = props.selection;
  // The host keys this controller by the exact pointer; the selection stays one value for its lifetime.
  const selection = React.useMemo(
    () => ({ sourceId, itemId, ...(version ? { version } : {}) }),
    [sourceId, itemId, version],
  );
  if (!lifetime) return props.children({ listing: null, lifetime: null });
  const key = JSON.stringify([
    lifetime.scope.serverId,
    lifetime.scope.accountId,
  ]);
  return (
    <StoreAppListingRead
      key={key}
      lifetime={lifetime}
      selection={selection}
    >
      {props.children}
    </StoreAppListingRead>
  );
}

function StoreAppListingRead(
  props: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    selection: StoreAppListingSelection;
    children: (state: StoreAppListingControllerState) => React.ReactNode;
  }>,
): React.ReactNode {
  const focused = useIsFocused();
  const visible = useLayoutPresentationActive();
  const demand = React.useMemo(
    () => ({ presented: focused && visible }),
    [focused, visible],
  );
  const listing = useStoreAppListing({
    selection: props.selection,
    lifetime: props.lifetime,
    demand,
  });
  return props.children({ listing, lifetime: props.lifetime });
}

type Presented = Extract<
  StoreAppListingState,
  { kind: 'ready' | 'needs_review' }
>;

function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024
    ? `${Math.round((mb / 1024) * 10) / 10} GB`
    : `${Math.round(mb)} MB`;
}

/**
 * One App listing (lab store `h:detail`): who it is and its one action, the headline facts, what it runs and
 * can reach, then Versions and Source. A template Happier can't map yet shows what needs review instead of an
 * action that cannot succeed.
 */
export function StoreAppListing(
  props: Readonly<{
    state: Presented;
    lifetime: ServerAccountScopeLifetime;
    pushed: boolean;
    onClose: () => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const { state, lifetime } = props;
  const initialMachine = useStoreMachineScope();
  const { item } = state;
  const summary = item.summary;
  const app = state.kind === 'ready' ? state.app : null;
  const name = catalogText(app?.title) ?? summary.title;
  const mark = React.useMemo(
    () =>
      admitRegistrySummaryMark(summary).brandMark ?? {
        displayName: summary.title,
      },
    [summary],
  );
  const ready = state.kind === 'ready' ? state : null;
  // The exact pin joins a preset as an App in its own new Environment; saving the preset deploys nothing.
  const templateRef = ready?.templateRef;
  const presetItem = React.useMemo((): StorePresetDoorItem | null => templateRef ? storeAppPresetItem(name, templateRef) : null, [templateRef, name]);
  const [presetHandoff, setPresetHandoff] = React.useState<StorePresetChoice | null>(null);
  const returnFromPreset = React.useCallback(() => setPresetHandoff(null), []);
  // The listing that asked owns its install sheet: once it stops being presented (a route change, Back, a
  // closed pane) the sheet is withdrawn with it, never left open over another page.
  const focused = useIsFocused();
  const visible = useLayoutPresentationActive();
  const presented = focused && visible;
  const sheetId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (presented || !sheetId.current) return;
    Modal.hide(sheetId.current);
    sheetId.current = null;
  }, [presented]);
  React.useEffect(() => () => {
    if (sheetId.current) Modal.hide(sheetId.current);
  }, []);

  const facts = React.useMemo((): FactStripFact[] => {
    const list: FactStripFact[] = [];
    if (!app) return list;
    const services = app.compose.services.length;
    if (services > 0)
      list.push({
        key: 'runs',
        label: t('capabilities.store.appPage.runsLabel'),
        value: t('capabilities.store.appPage.services', { count: services }),
      });
    const memory = app.minimumResources?.memoryBytes;
    if (memory)
      list.push({
        key: 'needs',
        label: t('capabilities.store.appPage.needsLabel'),
        value: t('capabilities.store.appPage.memory', {
          size: formatMemory(memory),
        }),
      });
    if (summary.license)
      list.push({
        key: 'licence',
        label: t('capabilities.store.appPage.licenceLabel'),
        value: summary.license,
      });
    const kept = app.volumes.filter((volume) => volume.persistent).length;
    if (kept > 0)
      list.push({
        key: 'data',
        label: t('capabilities.store.appPage.dataLabel'),
        value: t('capabilities.store.appPage.volumes', { count: kept }),
      });
    if (app.firstRunSetup)
      list.push({
        key: 'firstRun',
        label: t('capabilities.store.appPage.firstRunLabel'),
        value: t('capabilities.store.appPage.firstRunValue'),
      });
    return list;
  }, [app, summary.license]);

  // A catalog App's summary version pins its template catalog's content, not the App's own release: Versions shows
  // only a real release, never the content digest.
  const catalogSource = useRegistrySources('app').sources.find((source) => source.id === summary.sourceId);
  const catalogFacts = appListingCatalogFacts({ version: summary.version, repository: summary.links?.repository, catalog: catalogSource });
  const prose = appListingProse({ summary: summary.description, about: catalogText(app?.description) });
  const website = summary.links?.website ?? app?.documentationUrl;
  const glyph = (icon: IconName) => (
    <Icon name={icon} size={ICON_SIZE.md} color={theme.colors.text.secondary} />
  );

  const config: CapabilityListingConfig<typeof item> = {
    testID: 'store.app.listing',
    catalog: {
      itemKey: () => JSON.stringify([summary.sourceId, summary.itemId]),
    },
    detailFooter: () => ({
      primary: {
        label: t('capabilities.store.appPage.install'),
        onPress: async () => {
          if (ready) sheetId.current = showStoreAppPreparation({ ready, lifetime, name, initialMachine });
          return null;
        },
        ...(ready
          ? {}
          : {
              disabledReason: t('capabilities.store.appPage.needsReviewHint'),
            }),
      },
      ...(presetItem ? { secondary: (
        <StoreAddToPresetButton
          testID="store.app.listing.addToPreset"
          serverId={lifetime.scope.serverId}
          item={presetItem}
          name={name}
          onChoose={setPresetHandoff}
        />
      ) } : {}),
      provenance: (
        <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
          {t('capabilities.store.appPage.installNote')}
        </Text>
      ),
    }),
    renderDetail: () => (
      <View>
        <ItemGroup surface="none" header="none">
          <BareSectionContent>
            <View style={styles.head}>
              <CapabilityDetailHeader
                testID="store.app.listing.header"
                mark={
                  <HappierBrandMark
                    brand={mark}
                    pixelSize={30}
                    externallyLabelled
                  />
                }
                title={name}
                {...(prose.purpose ? { purpose: prose.purpose } : {})}
                facts={{
                  // What it is and where it comes from, on one line: App · its catalog · that catalog's version.
                  extra: [
                    t('capabilities.store.kindWord.app'),
                    summary.publisher?.name,
                    catalogFacts.sourceTitle,
                    catalogFacts.version,
                  ].filter((fact): fact is string => Boolean(fact)),
                }}
              />
              <CapabilityAddDetailAction />
              {facts.length > 0 ? (
                <View style={styles.facts}>
                  <FactStrip testID="store.app.listing.facts" facts={facts} />
                </View>
              ) : null}
              {prose.about ? (
                <Text
                  variant="reading"
                  style={{ color: theme.colors.text.primary }}
                >
                  {prose.about}
                </Text>
              ) : null}
            </View>
          </BareSectionContent>
        </ItemGroup>
        {state.kind === 'needs_review' ? (
          <ItemGroup
            testID="store.app.listing.review"
            title={t('capabilities.store.appPage.reviewTitle')}
            description={t('capabilities.store.appPage.reviewDescription')}
          >
            {state.diagnostics.map((diagnostic) => (
              <Item
                key={`${diagnostic.field}:${diagnostic.reason}`}
                mode="info"
                icon={glyph('warning-circle')}
                title={
                  <Text variant="body" style={styles.mono}>
                    {diagnostic.field}
                  </Text>
                }
                subtitle={diagnostic.reason}
              />
            ))}
          </ItemGroup>
        ) : null}
        {state.kind === 'needs_review' && state.reviewSource ? <DeploymentTemplateMappingCorrection
          source={state.reviewSource} onReview={state.correctMappings} testID="store.app.mapping" /> : null}
        {app ? (
          <ItemGroup title={t('capabilities.store.appPage.reachTitle')}>
            {app.domains.map((domain) => (
              <Item
                key={`domain:${domain.key}`}
                testID={`store.app.listing.domain.${domain.key}`}
                mode="info"
                icon={glyph('globe')}
                title={
                  domain.protocol === 'tcp'
                    ? t('capabilities.store.appPage.internalTitle', {
                        service: domain.service,
                        port: domain.containerPort,
                      })
                    : t('capabilities.store.appPage.addressTitle')
                }
                subtitle={t('capabilities.store.appPage.addressBody', {
                  service: domain.service,
                  port: domain.containerPort,
                })}
              />
            ))}
            {app.volumes.some((volume) => volume.persistent) ? (
              <Item
                mode="info"
                icon={glyph('hard-drives')}
                title={t('capabilities.store.appPage.keptTitle', {
                  count: app.volumes.filter((volume) => volume.persistent)
                    .length,
                })}
                subtitle={t('capabilities.store.appPage.keptBody', {
                  count: app.volumes.filter((volume) => volume.persistent).length,
                })}
              />
            ) : null}
            {app.generatedSecrets.length > 0 ? (
              <Item
                mode="info"
                icon={glyph('key')}
                title={t('capabilities.store.appPage.secretsTitle', {
                  count: app.generatedSecrets.length,
                })}
                subtitle={t('capabilities.store.appPage.secretsBody')}
              />
            ) : null}
            {app.firstRunSetup ? (
              <Item
                testID="store.app.listing.firstRun"
                mode="info"
                icon={glyph('user-circle')}
                title={t('capabilities.store.appPage.firstRunTitle')}
                subtitle={t('capabilities.store.appPage.firstRunBody')}
              />
            ) : null}
          </ItemGroup>
        ) : null}
        <CapabilityListingSections
          testID="store.app.listing"
          facts={{
            version: catalogFacts.version,
            versionNote: null,
            license: summary.license ?? null,
            sourceTitle: catalogFacts.sourceTitle,
            links: {
              ...(catalogFacts.repository
                ? { repository: catalogFacts.repository }
                : {}),
              ...(website ? { website } : {}),
            },
          }}
        />
      </View>
    ),
  };
  if (presetHandoff && presetItem) {
    return <StorePresetEditorHandoff choice={presetHandoff} item={presetItem} onReturn={returnFromPreset} />;
  }
  return (
    <CapabilityListingDetail
      config={config}
      item={item}
      onClose={props.onClose}
      pushed={props.pushed}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  head: { gap: theme.space.s8 },
  facts: { paddingTop: theme.space.s12 },
  mono: { ...Typography.mono() },
}));
