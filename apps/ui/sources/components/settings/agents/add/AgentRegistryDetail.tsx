import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { selectAcpRegistryDistributionV1 } from '@happier-dev/protocol/acp/catalog/registry/mapAcpRegistryAgentV1';
import { registryPluginListingSummaryV1, type RegistryItemV1 } from '@happier-dev/protocol/registries';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { areAgentRegistryChecksumsPublished } from '@/agents/registry/agentRegistryChecksums';
import { CapabilityAddDetailAction } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { CapabilityListingSections } from '@/components/capabilities/add/CapabilityListingSections';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { formatAgentNameList } from '@/components/capabilities/identity/agentNameList';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { PluginListingAddsSection, PluginListingFacts } from '@/components/settings/plugins/listing/PluginListingFacts';
import { catalogReviewStatusLabel } from '@/components/settings/plugins/model/pluginMarketplaceModel';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { projectRegistryMarketplacePage } from '@/components/settings/plugins/readPluginMarketplaceCatalog';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';

import { AgentMachinesSection } from '../detail/AgentMachinesSection';
import {
  AgentAddingProgress,
  formatMachineOs,
  machineGlyph,
} from './AgentAddingProgress';
import {
  groupAgentMachineFits,
  publisherName,
  resolveAgentMachineFits,
  type AgentAddMachine,
  type AgentAddRow,
  type AgentMachineFit,
} from './agentAddRows';
import type { AgentAddState } from './agentAddModalConfig';

/** Away machines listed one by one before they fold into a single "N machines offline" line. */
const OFFLINE_SHOWN_MAX = 3;

export type AgentInstallChoice = 'now' | 'firstUse';

/** What the footer needs from the open details: the read registry entry and the Install choice. */
export type AgentAddDraft = Readonly<{
  item: RegistryItemV1 | null;
  sourceRevision: string;
  choice: AgentInstallChoice;
}>;

const BUILD_LABELS: Readonly<Record<string, string>> = {
  'darwin-arm64': 'Apple silicon',
  'darwin-x64': 'Intel Mac',
  'linux-arm64': 'ARM64',
  'linux-x64': 'x64',
  'win32-arm64': 'ARM64',
  'win32-x64': 'x64',
};

function fitLine(
  name: string,
  machine: AgentAddMachine,
  fit: AgentMachineFit['fit'],
): string {
  if (fit.kind === 'can_run') {
    if (fit.via === 'archive' && fit.target)
      return t('capabilities.agentAdd.detail.build', {
        target: BUILD_LABELS[fit.target] ?? fit.target,
      });
    return fit.via === 'npm' ? t('capabilities.agentAdd.detail.runsVia.npm')
      : fit.via === 'uv' ? t('capabilities.agentAdd.detail.runsVia.uv')
        : fit.via === 'command' ? t('capabilities.agentAdd.detail.runsVia.command') : t('capabilities.agentAdd.detail.runsVia.archive');
  }
  if (fit.kind === 'unknown')
    return fit.reason === 'arch_unknown'
      ? t('capabilities.agentAdd.detail.archUnknown')
      : t('capabilities.agentAdd.detail.platformUnknown');
  if (fit.reason === 'archive_type_unsupported')
    return t('capabilities.agentAdd.detail.archiveUnsupported', { name });
  const os = formatMachineOs(machine.platform) ?? machine.platform ?? '';
  return t('capabilities.agentAdd.detail.noBuild', {
    name,
    platform: [os, machine.arch === 'arm64' ? 'ARM' : machine.arch]
      .filter(Boolean)
      .join(' on '),
  });
}

/**
 * A registry agent's details (lab aa D/W), in the order the questions arise: can my machines run it (and when it
 * installs), what I'm trusting, what it installs, how it signs in. After Add the same column becomes the install
 * (lab aa X): the person sees each machine's download where the machines were.
 */
export function AgentRegistryDetail(
  props: Readonly<{
    row: AgentAddRow;
    sourceTitle: string;
    sourceRevision: string;
    machines: readonly AgentAddMachine[];
    serverId: string | null;
    added: AgentAddState | null;
    onRetryInstall: (machineId: string) => Promise<void>;
    existingDefinitionId: string | null;
    /** The machine a plugin listing installs on (the page's administration target, P9 F6). */
    targetSelection: MachineAdministrationTargetSelectionV1;
    onDraft: (draft: AgentAddDraft) => void;
    initialChoice?: AgentInstallChoice;
    onAddedPresented?: (definitionId: string | null) => void;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const sourceRevision = props.sourceRevision;
  const read = useRegistryItem({
    kind: 'agent',
    sourceId: props.row.summary.sourceId,
    itemId: props.row.summary.itemId,
    version: props.row.summary.version,
  });
  const item = !read.stale && !read.error && (read.item?.payload.kind === 'agent' || read.item?.payload.kind === 'plugin')
    ? read.item : null;
  const payload = item?.payload;
  const agent =
    payload?.kind === 'agent' ? payload.agent : null;
  const [choice, setChoice] = React.useState<AgentInstallChoice>(props.initialChoice ?? 'now');
  const { onDraft } = props;
  React.useEffect(() => {
    onDraft({ item, sourceRevision, choice });
  }, [item, sourceRevision, choice, onDraft]);
  const addedDefinitionId = props.added?.definitionId ?? null;
  const { onAddedPresented } = props;
  React.useEffect(() => {
    onAddedPresented?.(addedDefinitionId);
    return () => onAddedPresented?.(null);
  }, [addedDefinitionId, onAddedPresented]);

  const name = agent?.name ?? props.row.summary.title;
  const fits = React.useMemo(
    () =>
      agent ? resolveAgentMachineFits(agent.distributions, props.machines) : [],
    [agent, props.machines],
  );
  const nowNames = fits
    .filter(({ fit, machine }) => fit.kind === 'can_run' && !machine.offline)
    .map(({ machine }) => machine.name);
  // Online machines answer the question now; a long tail of away machines folds into one line.
  const offlineFits = fits.filter(({ machine }) => machine.offline);
  const foldedOffline = offlineFits.length > OFFLINE_SHOWN_MAX ? offlineFits.length : 0;
  const shownFits = foldedOffline > 0 ? fits.filter(({ machine }) => !machine.offline) : fits;
  const selected = agent
    ? selectAcpRegistryDistributionV1(agent.distributions)
    : null;
  const quiet = { color: theme.colors.text.secondary };

  const header = (
    <>
    <CapabilityDetailHeader
      testID={`${props.testID}.detail.header`}
      mark={
        <HappierBrandMark brand={props.row.summary.brandMark ?? { displayName: props.row.summary.title }} pixelSize={28} externallyLabelled />
      }
      title={name}
      {...(props.row.summary.description
        ? { purpose: props.row.summary.description }
        : {})}
      facts={{
        source: { kind: 'registry', label: props.sourceTitle },
        extra: [
          publisherName(props.row.summary.publisher?.name),
          agent?.version ?? props.row.summary.version,
          agent?.license ?? props.row.summary.license,
        ].filter((fact): fact is string => Boolean(fact)),
      }}
    />
    <CapabilityAddDetailAction />
    </>
  );

  if (props.added) {
    return (
      <View>
        {header}
        <AgentAddingProgress
          name={name}
          definitionId={props.added.definitionId}
          serverId={props.serverId}
          machines={fits
            .filter(({ fit }) => fit.kind === 'can_run')
            .map(({ machine }) => machine)}
          installOn={props.added.installOn}
          failures={props.added.failures}
          onRetryInstall={props.onRetryInstall}
          testID={`${props.testID}.adding`}
        />
      </View>
    );
  }

  if (item && payload?.kind === 'plugin') {
    return (
      <AgentPluginDetail
        item={item}
        sourceTitle={props.sourceTitle}
        targetSelection={props.targetSelection}
        testID={props.testID}
      />
    );
  }

  if (!agent) {
    return (
      <View>
        {header}
        {read.error ? (
          <SurfaceStateCard
            kind="error"
            layout="inline"
            title={t('capabilities.agentAdd.detail.readFailed')}
            diagnosticCode={read.error}
            action={{
              label: t('capabilities.agentAdd.detail.retry'),
              onPress: () => {
                void read.refresh();
              },
            }}
            testID={`${props.testID}.detail.readFailed`}
          />
        ) : read.loading ? (
          <SurfaceStateCard
            kind="loading"
            size="line"
            title={t('capabilities.agentAdd.detail.loading')}
          />
        ) : null}
      </View>
    );
  }

  // The one checksum line (IR-32): about the builds your machines would download, else every published build.
  const runnableTargets = fits.flatMap(({ fit }) => (fit.kind === 'can_run' && fit.target ? [fit.target] : []));
  const checksum = selected?.kind === 'archive'
    ? areAgentRegistryChecksumsPublished(agent.distributions.binary ?? {}, runnableTargets)
    : null;
  const file = (() => {
    if (selected?.kind === 'npm')
      return {
        title: t('capabilities.agentAdd.detail.installsNpm', {
          pkg: `${selected.distribution.package}@${selected.distribution.version}`,
        }),
        body: t('capabilities.agentAdd.detail.installsNpmBody'),
      };
    if (selected?.kind === 'uv')
      return {
        title: t('capabilities.agentAdd.detail.installsUv', {
          pkg: `${selected.distribution.package}==${selected.distribution.version}`,
        }),
        body: t('capabilities.agentAdd.detail.installsUvBody'),
      };
    const target = fits.find(
      ({ fit }) => fit.kind === 'can_run' && fit.target,
    )?.fit;
    const asset =
      target?.kind === 'can_run' && target.target
        ? agent.distributions.binary?.[target.target]
        : undefined;
    const fileName = asset
      ? decodeURIComponent(
          new URL(asset.archiveUrl).pathname.split('/').pop() ?? '',
        )
      : null;
    return fileName
      ? {
          title: t('capabilities.agentAdd.detail.installsArchive', {
            file: fileName,
          }),
          body: t('capabilities.agentAdd.detail.installsArchiveBody'),
        }
      : null;
  })();

  return (
    <View>
      {header}
      <ItemGroup
        title={t('capabilities.agentAdd.detail.machinesTitle')}
        description={t('capabilities.agentAdd.detail.machinesBody')}
      >
        {fits.length === 0 ? (
          <Item
            title={t('capabilities.agentAdd.detail.noMachines')}
            showChevron={false}
          />
        ) : (
          groupAgentMachineFits(shownFits, ({ machine, fit }) => fitLine(name, machine, fit)).map(({ key, machines }) => {
            const { machine, fit } = machines[0]!;
            // One reason that stops several machines is said once, with how many it stops (STORE-UI-R2 N3).
            const many = machines.length > 1;
            const systems = new Set(machines.map((entry) => formatMachineOs(entry.machine.platform)));
            return (
            <Item
              key={key}
              testID={many ? `${props.testID}.detail.machines.${key}` : `${props.testID}.detail.machine.${machine.machineId}`}
              title={many ? t('allMachines.machinesCount', { count: machines.length }) : machine.name}
              titleQualifier={systems.size === 1 ? formatMachineOs(machine.platform) : undefined}
              titleStyle={
                fit.kind !== 'can_run' || machine.offline ? quiet : undefined
              }
              subtitle={fitLine(name, machine, fit)}
              icon={
                <Icon
                  name={machineGlyph(machine.platform)}
                  size={20}
                  color={theme.colors.text.secondary}
                />
              }
              rightElement={
                fit.kind === 'cant_run' ? (
                  <CapabilityStatusChip status={{ kind: 'cantrun' }} />
                ) : (
                  <Text variant="meta" style={quiet}>
                    {fit.kind === 'unknown'
                      ? t('capabilities.agentAdd.detail.unknownFit')
                      : machine.offline
                        ? t('capabilities.agentAdd.detail.offlineNote')
                        : t('capabilities.agentAdd.detail.canRun')}
                  </Text>
                )
              }
              accessoryLayout="adaptive"
              showChevron={false}
            />
            );
          })
        )}
        {foldedOffline > 0 ? (
          <Item
            testID={`${props.testID}.detail.offlineMachines`}
            title={t('capabilities.agentAdd.detail.offlineMany', { count: foldedOffline })}
            subtitle={t('capabilities.agentAdd.detail.offlineManyBody')}
            titleStyle={quiet}
            icon={<Icon name="clock" size={20} color={theme.colors.text.secondary} />}
            showChevron={false}
          />
        ) : null}
        {fits.some(({ fit }) => fit.kind === 'can_run') ? (
          <SegmentedChoiceItem<AgentInstallChoice>
            testIDPrefix={`${props.testID}.detail.install`}
            title={t('capabilities.agentAdd.detail.installTitle')}
            subtitle={
              choice === 'firstUse'
                ? t('capabilities.agentAdd.detail.installFirstUseBody')
                : nowNames.length > 0
                  ? t('capabilities.agentAdd.detail.installNowBody', {
                      machines: nowNames.length > 3 ? t('allMachines.machinesCount', { count: nowNames.length }) : formatAgentNameList(nowNames),
                    })
                  : t('capabilities.agentAdd.detail.installNoneNow')
            }
            options={[
              {
                id: 'now',
                label: t('capabilities.agentAdd.detail.installNow'),
              },
              {
                id: 'firstUse',
                label: t('capabilities.agentAdd.detail.installFirstUse'),
              },
            ]}
            value={choice}
            onChange={setChoice}
          />
        ) : null}
      </ItemGroup>

      <ItemGroup
        title={t('capabilities.agentAdd.detail.trustTitle')}
        description={t('capabilities.agentAdd.detail.trustBody', { name })}
      >
        {checksum !== null ? (
          <Item
            testID={`${props.testID}.detail.checksum`}
            title={
              checksum
                ? t('capabilities.agentAdd.detail.checksumVerified')
                : t('capabilities.agentAdd.detail.checksumMissing')
            }
            {...(checksum
              ? {
                  subtitle: t(
                    'capabilities.agentAdd.detail.checksumVerifiedBody',
                  ),
                }
              : {})}
            icon={
              <Icon
                name="shield-check"
                size={ICON_SIZE.sm}
                color={theme.colors.text.secondary}
              />
            }
            showChevron={false}
          />
        ) : null}
        <Item
          title={t('capabilities.agentAdd.detail.checkedByRegistry')}
          subtitle={t('capabilities.agentAdd.detail.checkedByRegistryBody')}
          icon={
            <Icon
              name="check-circle"
              size={ICON_SIZE.sm}
              color={theme.colors.text.secondary}
            />
          }
          showChevron={false}
        />
      </ItemGroup>

      {file ? (
        <ItemGroup
          title={t('capabilities.agentAdd.detail.installsTitle')}
        >
          <Item
            title={file.title}
            subtitle={file.body}
            titleStyle={styles.mono}
            showChevron={false}
          />
        </ItemGroup>
      ) : null}

      <ItemGroup title={t('capabilities.agentAdd.detail.signInTitle')}>
        <Item
          title={t('capabilities.agentAdd.detail.signInBody', { name })}
          titleLines={2}
          icon={<Icon name="key" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
          showChevron={false}
        />
      </ItemGroup>
      <CapabilityListingSections
        testID={`${props.testID}.detail.listing`}
        facts={{
          version: agent?.version ?? props.row.summary.version ?? null,
          sourceTitle: props.sourceTitle,
          license: agent?.license ?? props.row.summary.license ?? null,
          links: agent?.repository ? { repository: agent.repository } : props.row.summary.links ?? null,
        }}
      />
    </View>
  );
}

/**
 * A Happier plugin that adds an agent (lab aa P, P9 F6): what it adds from its manifest, the trusted-code facts
 * (where it runs, platforms, source) and the machine it installs on. The footer's Review and install opens the
 * shipped Install & Trust review, which lists exactly what the plugin can reach.
 */
export function AgentPluginDetail(
  props: Readonly<{
    item: RegistryItemV1;
    sourceTitle: string;
    targetSelection: MachineAdministrationTargetSelectionV1;
    testID: string;
  }>,
): React.ReactElement {
  const entry = React.useMemo(
    () => props.item.payload.kind === 'plugin' ? projectRegistryMarketplacePage({ items: [{ ...props.item.summary,
      pluginListing: registryPluginListingSummaryV1(props.item.payload.listing) }], pages: [],
      sources: [props.item.payload.source] }).entries[0] ?? null : null,
    [props.item],
  );
  const payload = props.item.payload.kind === 'plugin' ? props.item.payload : null;
  const title = entry?.title ?? props.item.summary.title;
  return (
    <View>
      <CapabilityDetailHeader
        testID={`${props.testID}.detail.header`}
        mark={<PluginMark title={title} pluginId={payload?.listing.pluginId ?? null} size="page" />}
        title={title}
        {...(entry?.description ? { purpose: entry.description } : {})}
        facts={{
          source: { kind: 'registry', label: props.sourceTitle },
          extra: [
            entry?.publisher.displayName,
            entry?.version,
            entry ? catalogReviewStatusLabel(entry) : null,
          ].filter((fact): fact is string => Boolean(fact)),
        }}
        {...(payload ? { mono: `${payload.listing.distribution.packageName}@${payload.listing.distribution.version}` } : {})}
      />
      <CapabilityAddDetailAction />
      {entry ? (
        <>
          <PluginListingAddsSection
            entry={entry}
            description={t('capabilities.agentAdd.plugin.addsBody')}
            testID={`${props.testID}.detail.plugin.adds`}
          />
          <PluginListingFacts
            entry={entry}
            title={t('capabilities.agentAdd.detail.trustTitle')}
            description={t('capabilities.agentAdd.plugin.trustBody')}
            testID={`${props.testID}.detail.plugin.trust`}
          />
          <MachineAdministrationTargetSelector
            presentation="section"
            selection={props.targetSelection}
            groupTitle={t('capabilities.agentAdd.plugin.installOn')}
            testIDPrefix={`${props.testID}.detail.plugin.target`}
          />
        </>
      ) : (
        <SurfaceStateCard
          kind="unavailable"
          layout="inline"
          title={t('capabilities.agentAdd.detail.unsupportedEntry')}
          testID={`${props.testID}.detail.plugin.unavailable`}
        />
      )}
    </View>
  );
}

/**
 * An agent Happier already ships (lab aa B): say so, show it is that agent, and lead to its page (the primary is
 * Open). One quiet link offers the registry's version as a separate agent, through the registry agent's own details
 * and confirmed Add.
 */
export function AgentBuiltInDetail(
  props: Readonly<{
    row: AgentAddRow;
    entry: ResolvedAgentCatalogEntry;
    sourceTitle: string;
    /** The Account's server and the page's machine selection: the same "On your machines" the agent's own page shows. */
    serverId: string | null;
    targetSelection: MachineAdministrationTargetSelectionV1;
    onAddSeparate: () => void;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <View>
      <CapabilityDetailHeader
        testID={`${props.testID}.detail.header`}
        mark={
          <HappierBrandMark
            brand={props.row.summary.brandMark ?? { displayName: props.row.summary.title }} externallyLabelled
            pixelSize={28}
          />
        }
        title={props.row.summary.title}
        {...(props.row.summary.description
          ? { purpose: props.row.summary.description }
          : {})}
        facts={{
          source: { kind: 'registry', label: props.sourceTitle },
          extra: [
            publisherName(props.row.summary.publisher?.name),
            props.row.summary.version,
            props.row.summary.license,
          ].filter((fact): fact is string => Boolean(fact)),
        }}
      />
      <CapabilityAddDetailAction />
      <ItemGroup>
        <Item
          title={t('capabilities.agentAdd.builtIn.callout', {
            name: props.row.summary.title,
            agent: props.entry.title,
          })}
          subtitle={t('capabilities.agentAdd.builtIn.calloutBody')}
          icon={
            <AgentCatalogIdentityIcon
              entry={props.entry}
              machineId={null}
              serverId={null}
              current={false}
              color={theme.colors.text.secondary}
              size={20}
            />
          }
          showChevron={false}
        />
      </ItemGroup>
      {props.serverId ? (
        <AgentMachinesSection
          testID={`${props.testID}.detail.builtIn.machines`}
          agentTitle={props.entry.title}
          agentId={props.entry.agentId}
          pinnedVersion={null}
          serverId={props.serverId}
          targetSelection={props.targetSelection}
        />
      ) : null}
      <View style={styles.alternative}>
        <Icon name="info" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
        <View style={styles.alternativeText}>
          <TextLinkButton
            tone="strong"
            label={t('capabilities.agentAdd.builtIn.addSeparate')}
            onPress={props.onAddSeparate}
            testID={`${props.testID}.detail.addSeparate`}
          />
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {t('capabilities.agentAdd.builtIn.addSeparateBody', { agent: props.entry.title })}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  alternative: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8 },
  alternativeText: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  mono: { fontVariant: ['tabular-nums'] },
}));
