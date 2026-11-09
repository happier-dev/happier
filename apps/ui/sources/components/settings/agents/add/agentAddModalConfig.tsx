import * as React from 'react';
import { z } from 'zod/mini';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AgentsAcpBackendsInstallFromRegistryOutputV1Schema } from '@happier-dev/protocol/acp/catalog/registry/registryInstallActionV1';
import type { AcpPlatformFitV1 } from '@happier-dev/protocol/acp/catalog/registry/acpPlatformFitV1';
import { selectAcpRegistryDistributionV1 } from '@happier-dev/protocol/acp/catalog/registry/mapAcpRegistryAgentV1';
import type {
  AcpRegistryAgentV1,
  RegistryItemPointerV1,
  RegistryItemSummaryV1,
} from '@happier-dev/protocol/registries';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  CapabilityAddModalBody,
  openCapabilityAddModalHost,
  type CapabilityAddModalConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { useAcpCatalogBackends } from '@/components/settings/acpCatalog/useAcpCatalogBackends';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { admitRegistrySummaryMark } from '@/registries/registryBrandMark';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { useRegistrySourcesSlot } from '@/registries/useRegistrySourcesSlot';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { confirmAgentInstallChange } from '../install/agentInstallChangeConfirm';
import { useAgentAdministrationCatalog } from '../collection/useAgentAdministrationCatalog';
import { buildPluginListingRoute } from '../../plugins/model/pluginsSurfaceRoutes';
import {
  AgentRegistryDetail,
  AgentBuiltInDetail,
  type AgentAddDraft,
  type AgentInstallChoice,
} from './AgentRegistryDetail';
import {
  agentAddRowKey,
  buildAgentAddRows,
  publisherName,
  findAddedAgentDefinition,
  resolveAgentMachineFits,
  type AgentAddMachine,
  type AgentAddRow,
} from './agentAddRows';

export type OpenAgentAddModalParams = Readonly<{
  /** From a command: the page's draft editor (`/settings/agents/custom/new`). */
  onCommand: () => void;
  /** Open an added agent's page (on dismiss after an add, focus returns to its row). */
  onOpenDefinition: (definitionId: string) => void;
  /** Open a built-in agent's page ("Open Claude Code"). */
  onOpenAgent: (entry: ResolvedAgentCatalogEntry) => void;
  initialModeKey?: 'browse';
  sourceId?: string;
  query?: string;
  initialSelection?: Readonly<Omit<RegistryItemPointerV1, 'version'> & { version?: string }>;
}>;

const TEST_ID = 'agents.add';
/** Where "How to publish a plugin" leads (the plugin docs' packaging and install page). */
const PUBLISH_PLUGIN_DOCS_URL = 'https://docs.happier.dev/plugins/packaging';

/**
 * Add an agent (P9 U9.4): the one capability Add modal over the agent registries. Add resolves with `then: 'stay'`,
 * so the details become that agent's per-machine install; dismissing then returns to the Agents page on its row.
 */
export function openAgentAddModal(
  params: OpenAgentAddModalParams,
): Readonly<{ close: () => void }> {
  const session: { lastAdded: string | null } = { lastAdded: null };
  return openCapabilityAddModalHost(
    AgentAddModal,
    {
      params,
      onAddedStay: (definitionId: string | null) => {
        session.lastAdded = definitionId;
      },
    },
    {
      title: t('capabilities.agentAdd.title'),
      subtitle: t('capabilities.agentAdd.subtitle'),
      testID: TEST_ID,
      onRequestClose: () => {
        if (session.lastAdded) params.onOpenDefinition(session.lastAdded);
      },
    },
  );
}

/** What the add owns per row, after the primary resolved. */
export type AgentAddState = Readonly<{
  status: 'added';
  definitionId: string;
  installOn: readonly string[];
  jobs?: readonly Readonly<{ machineId: string; jobId: string }>[];
  failures?: readonly Readonly<{ machineId: string; errorCode: string }>[];
}>;

/** Machines as the add details judge them: published OS/CPU facts, name, presence. */
export function useAgentAddMachines(): readonly AgentAddMachine[] {
  const { machines } = useReachMachines();
  return React.useMemo(
    () =>
      machines.map((machine) => ({
        machineId: machine.machineId,
        name: machine.name ?? machine.machineId,
        platform: machine.os ?? null,
        arch: machine.arch ?? null,
        offline: machine.offline,
      })),
    [machines],
  );
}

type Execute = ReturnType<typeof useMountedActionExecution>['execute'];

/** Where the download comes from, by the distribution the mapper will choose. */
function downloadHost(
  agent: AcpRegistryAgentV1,
  fits: readonly Readonly<{ fit: AcpPlatformFitV1 }>[],
): string | null {
  const selected = selectAcpRegistryDistributionV1(agent.distributions);
  if (selected?.kind === 'npm') return 'npmjs.com';
  if (selected?.kind === 'uv') return 'pypi.org';
  const target = fits.find(
    ({ fit }) => fit.kind === 'can_run' && fit.target,
  )?.fit;
  const asset =
    target?.kind === 'can_run' && target.target
      ? agent.distributions.binary?.[target.target]
      : undefined;
  try {
    return asset ? new URL(asset.archiveUrl).host : null;
  } catch {
    return null;
  }
}

/**
 * Add agent: one confirm naming the machines installing now and on first use, then the one Action writes the
 * definition and starts each machine's job. `null` when the person declines (nothing changes).
 */
export async function addRegistryAgent(
  input: Readonly<{
    row: Pick<RegistryItemSummaryV1, 'sourceId' | 'itemId'>;
    agent: AcpRegistryAgentV1;
    machines: readonly AgentAddMachine[];
    choice: AgentInstallChoice;
    /** Explicit recovery targets this machine even while its presence is stale. */
    retryMachineId?: string;
    execute: Execute;
    confirm?: typeof confirmAgentInstallChange;
    /** The caller's original Account and admitted source/pin must survive confirmation. */
    isCurrent?: () => boolean;
  }>,
): Promise<Omit<AgentAddState, 'status'> | null> {
  if (input.isCurrent?.() === false) return null;
  const fits = resolveAgentMachineFits(
    input.agent.distributions,
    input.retryMachineId ? input.machines.filter(machine => machine.machineId === input.retryMachineId) : input.machines,
  );
  const runnable = fits
    .filter(({ fit }) => fit.kind === 'can_run')
    .map(({ machine }) => machine);
  const now =
    input.choice === 'now'
      ? runnable.filter((machine) => input.retryMachineId === machine.machineId || !machine.offline)
      : [];
  const firstUse = runnable.filter((machine) => !now.includes(machine));
  const confirmed = await (input.confirm ?? confirmAgentInstallChange)({
    name: input.agent.name,
    version: input.agent.version,
    nowMachines: now.map((machine) => machine.name),
    firstUseMachines: firstUse.map((machine) => machine.name),
    sourceHost: downloadHost(input.agent, fits),
  });
  if (!confirmed || input.isCurrent?.() === false) return null;
  const installOn = now.map((machine) => machine.machineId);
  const result = await input.execute(
    'agents.acp.backends.installFromRegistry',
    {
      fromRegistry: {
        sourceId: input.row.sourceId,
        itemId: input.row.itemId,
        version: input.agent.version,
      },
      ...(installOn.length > 0 ? { installOn } : {}),
    },
    {
      confirmed: true,
    },
  );
  if (!result.ok && result.errorCode === 'agent_install_partial') {
    const details = z.object({
      definition: z.unknown(),
      jobs: z.unknown(),
      failures: z.array(z.strictObject({
        machineId: z.string().check(z.minLength(1)),
        errorCode: z.string().check(z.minLength(1)),
      })),
    }).parse(result.details);
    const output = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse({
      definition: details.definition,
      jobs: details.jobs,
    });
    return { definitionId: output.definition.id, installOn, jobs: output.jobs, failures: details.failures };
  }
  if (!result.ok)
    throw new Error(result.error || t('capabilities.add.addFailed'));
  const output = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse(
    result.result,
  );
  return {
    definitionId: output.definition.id,
    installOn: output.jobs.map((job) => job.machineId),
    jobs: output.jobs,
    failures: [],
  };
}

type AgentAddModalProps = CustomModalInjectedProps & Readonly<{
  params: OpenAgentAddModalParams;
  onAddedStay: (definitionId: string | null) => void;
}>;

export function AgentAddModal(props: AgentAddModalProps): React.ReactElement {
  return <AgentAddController {...props}>{config => <CapabilityAddModalBody {...props} config={config} />}</AgentAddController>;
}

/** Reuse the selected-read, plugin handoff and setup/receipt controller in every listing host. */
export function AgentAddController(props: AgentAddModalProps & Readonly<{
  children: (config: CapabilityAddModalConfig<AgentAddRow>, resolving: boolean) => React.ReactNode;
}>): React.ReactNode {
  const { params, onAddedStay } = props;
  const router = useRouter();
  const { theme } = useUnistyles();
  const scope = useAccountSettingsScope();
  const execution = useMountedActionExecution(scope);
  const { execute } = execution;
  const openingBinding = React.useRef(execution.binding);
  if (!openingBinding.current && execution.binding) openingBinding.current = execution.binding;
  const current = Boolean(openingBinding.current && openingBinding.current === execution.binding && execution.ready);
  const machines = useAgentAddMachines();
  const { agentEntries, targetSelection } = useAgentAdministrationCatalog({
    loadProjection: false,
  });
  const { backends: definitions } = useAcpCatalogBackends();
  const { sources: allSources } = useRegistrySources('agent');
  const sourceTitle = React.useCallback(
    (sourceId: string) =>
      allSources.find((source) => source.id === sourceId)?.title ?? t('capabilities.store.unnamedCatalog'),
    [allSources],
  );
  const [query, setQuery] = React.useState(params.query ?? '');
  const [catalogDemanded, setCatalogDemanded] = React.useState(true);
  const [seedRequested, setSeedRequested] = React.useState(params.initialSelection !== undefined);
  const discardSeed = React.useCallback(() => setSeedRequested(false), []);
  const slot = useRegistrySourcesSlot('agent', {
    ...((params.initialSelection?.sourceId ?? params.sourceId)
      ? { initialSelection: params.initialSelection?.sourceId ?? params.sourceId } : {}),
    onSelectionChange: discardSeed,
    testID: `${TEST_ID}.registries`,
  });
  const changeQuery = React.useCallback((next: string) => { setQuery(next); setSeedRequested(false); }, []);
  const selectedFormat =
    slot.selection === 'all'
      ? null
      : (allSources.find((source) => source.id === slot.selection)?.format ?? null);
  const acpSourceId =
    allSources.find((source) => source.format === 'acp-registry')?.id ?? null;
  // The ready-to-add count the empty plugin source leads with (lab aa H); read only while that state shows.
  const pluginSourceSelected = selectedFormat === 'happier-npm';
  const acpCatalog = useRegistryItems(
    { kind: 'agent', ...(acpSourceId ? { sourceIds: [acpSourceId] } : {}) },
    current && catalogDemanded && !seedRequested && pluginSourceSelected && acpSourceId !== null,
  );
  const catalog = useRegistryItems({
    kind: 'agent',
    ...(slot.sourceIds ? { sourceIds: slot.sourceIds } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
  }, current && catalogDemanded && !seedRequested);
  const seed = params.initialSelection;
  const seedRead = useRegistryItem({ kind: 'agent', sourceId: seed?.sourceId ?? '', itemId: seed?.itemId ?? '',
    ...(seed ? { version: seed.version } : {}) }, current && catalogDemanded && seedRequested);
  const items = React.useMemo(() => !current ? [] : seedRequested
    ? seedRead.item ? [admitRegistrySummaryMark(seedRead.item.summary)] : []
    : catalog.items, [current, seedRequested, seedRead.item, catalog.items]);

  const [drafts, setDrafts] = React.useState<
    ReadonlyMap<string, AgentAddDraft>
  >(() => new Map());
  // Built-in rows whose registry version the person chose to add as a separate agent (F5): they show the registry
  // agent's own details and its confirmed Add.
  const [separate, setSeparate] = React.useState<ReadonlySet<string>>(() => new Set());
  const [adds, setAdds] = React.useState<ReadonlyMap<string, AgentAddState>>(
    () => new Map(),
  );
  const draftSetters = React.useRef(
    new Map<string, (draft: AgentAddDraft) => void>(),
  );
  const draftSetter = React.useCallback((key: string) => {
    let setter = draftSetters.current.get(key);
    if (!setter) {
      setter = (draft: AgentAddDraft) =>
        setDrafts((previous) => {
          const current = previous.get(key);
          if (
            current &&
            current.item === draft.item &&
            current.sourceRevision === draft.sourceRevision &&
            current.choice === draft.choice
          )
            return previous;
          return new Map(previous).set(key, draft);
        });
      draftSetters.current.set(key, setter);
    }
    return setter;
  }, []);

  const { rows, groups } = React.useMemo(
    () =>
      buildAgentAddRows({
        items,
        catalogEntries: agentEntries,
        definitions,
        machines,
      }),
    [agentEntries, items, definitions, machines],
  );

  // A queued press/confirmation consumes the current admitted row and original Account,
  // never a payload left in this modal's draft map by an earlier source lifetime.
  const readCurrent = seedRequested ? !seedRead.stale : !catalog.stale;
  const live = React.useRef({ current, readCurrent, catalogDemanded, isCurrent: execution.isCurrent, rows, drafts, sourceRevision: catalog.sourceRevision });
  live.current = { current, readCurrent, catalogDemanded, isCurrent: execution.isCurrent, rows, drafts, sourceRevision: catalog.sourceRevision };
  const rowCurrent = React.useCallback((row: AgentAddRow) => {
    const state = live.current;
    return state.current && state.readCurrent && state.catalogDemanded && state.isCurrent() && state.rows.some(candidate => candidate.key === row.key
      && candidate.summary.version === row.summary.version);
  }, []);
  const currentDraft = React.useCallback((row: AgentAddRow) => {
    if (!rowCurrent(row)) return null;
    const state = live.current;
    const draft = state.drafts.get(row.key);
    const summary = draft?.item?.summary;
    return draft && summary && draft.sourceRevision === state.sourceRevision
      && summary.sourceId === row.summary.sourceId && summary.itemId === row.summary.itemId
      && (!row.summary.version || summary.version === row.summary.version) ? draft : null;
  }, [rowCurrent]);

  const anatomy = React.useMemo(
    () =>
      buildCapabilityCollectionAnatomy<AgentAddRow>({
        title: (row) => row.summary.title,
        description: (row) => row.summary.description?.trim() || null,
        mark: (row) => (
          <HappierBrandMark brand={row.summary.brandMark ?? { displayName: row.summary.title }} pixelSize={20} externallyLabelled />
        ),
        whereSummary: (row) => {
          const status = adds.has(row.key)
            ? { kind: 'added' as const }
            : row.status;
          if (!status) return null;
          const label =
            status.kind === 'builtIn'
              ? t('capabilities.agentAdd.status.builtIn')
              : status.kind === 'added'
                ? t('capabilities.agentAdd.status.added')
                : status.kind === 'cantRun'
                  ? t('capabilities.agentAdd.status.cantRun')
                  : status.kind === 'unknown'
                    ? t('capabilities.agentAdd.status.unknown')
                    : t('capabilities.agentAdd.status.cantAddYet');
          return (
            <View
              style={styles.where}
              testID={`${TEST_ID}.row.${row.summary.itemId}.where`}
            >
              {status.kind === 'added' ? (
                <Icon
                  name="check"
                  size={ICON_SIZE.xs}
                  color={theme.colors.text.secondary}
                />
              ) : null}
              <Text
                variant="meta"
                numberOfLines={1}
                style={{ color: theme.colors.text.secondary }}
              >
                {label}
              </Text>
            </View>
          );
        },
        facts: (row) => ({
          presentation: 'row',
          extra: [
            publisherName(row.summary.publisher?.name),
            row.summary.version,
            distributionLabel(row.summary.agentDistribution?.kind),
            row.summary.license,
          ].filter((fact): fact is string => Boolean(fact)),
        }),
        accessibilityLabel: (row) => row.summary.title,
        testID: (row) => `${TEST_ID}.row.${row.summary.itemId}`,
      }),
    [adds, theme.colors.text.secondary],
  );

  const config = React.useMemo(
    (): CapabilityAddModalConfig<AgentAddRow> => ({
      title: t('capabilities.agentAdd.title'),
      subtitle: t('capabilities.agentAdd.subtitle'),
      testID: TEST_ID,
      initialModeKey: 'browse',
      onCatalogDemandChange: setCatalogDemanded,
      ...(seedRequested && seed ? { initialItemKey: agentAddRowKey(seed) } : {}),
      modes: [
        {
          key: 'browse',
          label: t('capabilities.agentAdd.modes.browse'),
          icon: 'magnifying-glass',
          kind: 'catalog',
        },
        {
          key: 'command',
          label: t('capabilities.agentAdd.modes.command'),
          icon: 'terminal',
          kind: 'handoff',
          onSelect: params.onCommand,
        },
      ],
      sources: slot.sources,
      catalog: {
        query,
        onQueryChange: changeQuery,
        searchPlaceholder: t('capabilities.agentAdd.searchPlaceholder'),
        items: rows,
        groups: groups.map((group) => ({
          key: group.key,
          title: group.pick
            ? t('capabilities.agentAdd.groupPicks')
            : sourceTitle(group.sourceId),
          trailing: String(group.itemKeys.length),
          itemKeys: group.itemKeys,
        })),
        itemKey: (row) => row.key,
        anatomy,
        loading: (seedRequested ? seedRead.loading : catalog.loading) && rows.length === 0,
        ...(!seedRequested && catalog.hasNextPage
          ? { loadMore: { label: t('common.more'), loading: false, onPress: catalog.nextPage } } : {}),
        sourceFailures: seedRequested ? seedRead.error && seed ? [{ sourceId: seed.sourceId,
          message: `${sourceTitle(seed.sourceId)} · ${seedRead.error}`, onRetry: seedRead.refresh }] : [] : catalog.sourceFailures.map((failure) => ({
          ...failure,
          message: `${sourceTitle(failure.sourceId)} · ${failure.message}`,
        })),
        empty: (
          <AgentCatalogEmpty
            query={query}
            pluginSource={pluginSourceSelected}
            {...(pluginSourceSelected && acpCatalog.items.length > 0
              ? { registryAgentCount: acpCatalog.items.length }
              : {})}
            onClear={() => changeQuery('')}
            {...(acpSourceId
              ? {
                  onBrowseRegistry: () => {
                    changeQuery('');
                    slot.setSelection(acpSourceId);
                  },
                }
              : {})}
          />
        ),
        footer: (
          <View style={styles.note} testID={`${TEST_ID}.trustNote`}>
            <Icon name="shield-check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text variant="meta" style={styles.noteText}>
              {selectedFormat === 'happier-npm'
                ? t('capabilities.agentAdd.plugin.listTrustNote')
                : t('capabilities.agentAdd.trustNote')}
            </Text>
          </View>
        ),
      },
      renderDetail: (row, ctx) => {
        const added = ctx.added ? adds.get(row.key) : null;
        return row.status?.kind === 'builtIn' && !separate.has(row.key) ? (
          <AgentBuiltInDetail
            key={row.key}
            row={row}
            entry={row.status.entry}
            sourceTitle={sourceTitle(row.summary.sourceId)}
            serverId={scope?.serverId ?? null}
            targetSelection={targetSelection}
            onAddSeparate={() => setSeparate((previous) => new Set(previous).add(row.key))}
            testID={TEST_ID}
          />
        ) : (
          <AgentRegistryDetail
            key={row.key}
            row={row}
            sourceTitle={sourceTitle(row.summary.sourceId)}
            sourceRevision={catalog.sourceRevision}
            machines={machines}
            serverId={scope?.serverId ?? null}
            added={added && 'definitionId' in added ? added : null}
            onRetryInstall={async (machineId) => {
              const draft = currentDraft(row);
              if (draft?.item?.payload.kind !== 'agent') return;
              const retried = await addRegistryAgent({ row: row.summary, agent: draft.item.payload.agent,
                machines, choice: 'now', retryMachineId: machineId, execute,
                isCurrent: () => currentDraft(row) === draft });
              if (!retried) return;
              setAdds(previous => {
                const current = previous.get(row.key);
                if (!current || !('definitionId' in current)) return previous;
                return new Map(previous).set(row.key, { ...current,
                  jobs: [...(current.jobs ?? []).filter(job => job.machineId !== machineId), ...(retried.jobs ?? [])],
                  failures: [...(current.failures ?? []).filter(failure => failure.machineId !== machineId), ...(retried.failures ?? [])],
                });
              });
            }}
            existingDefinitionId={
              row.status?.kind === 'added' ? row.status.definitionId : null
            }
            targetSelection={targetSelection}
            onDraft={draftSetter(row.key)}
            initialChoice={drafts.get(row.key)?.choice}
            onAddedPresented={onAddedStay}
            testID={TEST_ID}
          />
        );
      },
      detailFooter: (row) => {
        const note = (
          <View style={styles.note}>
            <Icon
              name="lock"
              size={ICON_SIZE.xs}
              color={theme.colors.text.secondary}
            />
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {t('capabilities.agentAdd.footerNote')}
            </Text>
          </View>
        );
        if (row.status?.kind === 'builtIn' && !separate.has(row.key)) {
          const entry = row.status.entry;
          return {
            primary: {
              label: t('capabilities.agentAdd.openAgent', {
                name: entry.title,
              }),
              onPress: async () => rowCurrent(row) ? ({
                itemId: `agent:${entry.agentId}`,
                then: 'close' as const,
              }) : null,
            },
          };
        }
        const existing = findAddedAgentDefinition(definitions, row.summary);
        if (existing && !adds.has(row.key)) {
          return {
            primary: {
              label: t('capabilities.agentAdd.openAgent', {
                name: existing.title ?? existing.name,
              }),
              onPress: async () => rowCurrent(row) ? ({
                itemId: `definition:${existing.id}`,
                then: 'close' as const,
              }) : null,
            },
          };
        }
        const draft = currentDraft(row);
        if (draft?.item?.payload.kind === 'plugin') {
          const { listing } = draft.item.payload;
          return {
            provenance: (
              <View style={styles.note}>
                <Icon name="shield" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                <Text variant="meta" style={styles.noteText}>
                  {t('capabilities.agentAdd.plugin.footerNote')}
                </Text>
              </View>
            ),
            primary: {
              label: t('capabilities.agentAdd.plugin.reviewAndInstall'),
              ...(row.summary.problem ? { disabledReason: t('capabilities.agentAdd.detail.unsupportedEntry') } : {}),
              onPress: async () => {
                if (row.summary.problem || currentDraft(row) !== draft) return null;
                props.onClose();
                router.push(buildPluginListingRoute('settings', { sourceId: row.summary.sourceId,
                  itemId: row.summary.itemId, pluginId: listing.pluginId, version: listing.distribution.version }));
                return null;
              },
            },
          };
        }
        const agent = draft?.item?.payload.kind === 'agent' ? draft.item.payload.agent : null;
        const fits = agent
          ? resolveAgentMachineFits(agent.distributions, machines)
          : [];
        const disabledReason = row.summary.problem
          ? t('capabilities.agentAdd.detail.unsupportedEntry')
          : !agent
            ? t('capabilities.agentAdd.detail.loading')
            : machines.length > 0 &&
                !fits.some(({ fit }) => fit.kind === 'can_run')
              ? t('capabilities.agentAdd.detail.noRunnableMachine')
              : undefined;
        const addedResult = adds.get(row.key);
        const addedState = addedResult && 'definitionId' in addedResult ? addedResult : null;
        return {
          provenance: note,
          ...(addedState
            ? {
                afterAdd: {
                  open: {
                    label: t('capabilities.agentAdd.openAgent', {
                      name: agent?.name ?? row.summary.title,
                    }),
                    onPress: () => { if (rowCurrent(row)) params.onOpenDefinition(addedState.definitionId); },
                  },
                },
              }
            : {}),
          primary: {
            label: t('capabilities.agentAdd.addAgent'),
            ...(disabledReason ? { disabledReason } : {}),
            onPress: async () => {
              if (!agent || !draft || currentDraft(row) !== draft) return null;
              const added = await addRegistryAgent({
                row: row.summary,
                agent,
                machines,
                choice: draft.choice,
                execute,
                isCurrent: () => currentDraft(row) === draft,
              });
              if (!added) return null;
              setAdds((previous) =>
                new Map(previous).set(row.key, { status: 'added', ...added }),
              );
              return { itemId: added.definitionId, then: 'stay' as const };
            },
          },
        };
      },
      onAdded: ({ itemId }) => {
        if (itemId.startsWith('definition:'))
          params.onOpenDefinition(itemId.slice('definition:'.length));
        if (itemId.startsWith('agent:')) {
          const entry = agentEntries.find(
            (candidate) => candidate.agentId === itemId.slice('agent:'.length),
          );
          if (entry) params.onOpenAgent(entry);
        }
      },
    }),
    [
      adds,
      agentEntries,
      anatomy,
      catalog.loading,
      catalog.hasNextPage,
      catalog.nextPage,
      catalog.sourceFailures,
      definitions,
      draftSetter,
      currentDraft,
      rowCurrent,
      drafts,
      execute,
      groups,
      machines,
      onAddedStay,
      params,
      query,
      changeQuery,
      seed,
      seedRequested,
      seedRead.loading,
      seedRead.error,
      seedRead.refresh,
      props.onClose,
      router,
      rows,
      acpSourceId,
      scope,
      selectedFormat,
      separate,
      slot,
      sourceTitle,
      targetSelection,
      theme.colors.text.secondary,
    ],
  );

  return props.children(config, !current || config.catalog.loading);
}

/**
 * The catalog with nothing in it. A search that matched nothing offers Clear. An empty Happier plugin source (P9 F6,
 * lab aa H) says what a plugin agent is and why the list is empty, then leads to the ACP Registry and to publishing.
 */
export function AgentCatalogEmpty(
  props: Readonly<{
    query: string;
    pluginSource: boolean;
    onClear: () => void;
    onBrowseRegistry?: () => void;
    /** The agents the ACP Registry offers, said under the actions as the other way forward. */
    registryAgentCount?: number;
  }>,
) {
  const { theme } = useUnistyles();
  const query = props.query.trim();
  if (!query && props.pluginSource) {
    // Two ways forward side by side (the lab's primary and outlined button), then what the registry has: the
    // `action` slot is the empty state's own seam for an action that is not one button.
    return (
      <View style={styles.pluginsEmpty}>
        <EmptyState
          layout="centered"
          size="page"
          scene="noPlugins"
          title={t('capabilities.agentAdd.pluginsEmpty.title')}
          subtitle={t('capabilities.agentAdd.pluginsEmpty.body')}
          action={
            <View style={styles.emptyActions}>
              <View style={styles.emptyButtons}>
                {props.onBrowseRegistry ? (
                  <RoundButton
                    size="normal"
                    title={t('capabilities.agentAdd.pluginsEmpty.browseRegistry')}
                    action={async () => props.onBrowseRegistry?.()}
                    testID={`${TEST_ID}.empty.browseRegistry`}
                  />
                ) : null}
                <RoundButton
                  size="normal"
                  display="secondary"
                  title={t('capabilities.agentAdd.pluginsEmpty.publish')}
                  trailing={<Icon name="arrow-square-out" size={ICON_SIZE.xs} color={theme.colors.text.primary} />}
                  action={async () => openExternalUrl(PUBLISH_PLUGIN_DOCS_URL)}
                  testID={`${TEST_ID}.empty.publish`}
                />
              </View>
              {props.registryAgentCount !== undefined && props.onBrowseRegistry ? (
                <Text variant="meta" style={{ color: theme.colors.text.tertiary }} testID={`${TEST_ID}.empty.registryCount`}>
                  {t('capabilities.agentAdd.pluginsEmpty.registryReady', { count: props.registryAgentCount })}
                </Text>
              ) : null}
            </View>
          }
          testID={`${TEST_ID}.empty.plugins`}
        />
      </View>
    );
  }
  return (
    <View style={styles.empty}>
      <Text variant="body" style={{ color: theme.colors.text.secondary }}>
        {query
          ? t('capabilities.agentAdd.noMatch', { query })
          : t('capabilities.agentAdd.nothingHere')}
      </Text>
      {query ? (
        <RoundButton
          size="small"
          display="inverted"
          title={t('capabilities.agentAdd.clear')}
          onPress={props.onClear}
          testID={`${TEST_ID}.empty.clear`}
        />
      ) : null}
    </View>
  );
}

export { agentAddRowKey };

/** The list's one-word answer to "what does it download" (lab aa L: npm package / Binary download). */
function distributionLabel(kind: 'npm' | 'uv' | 'archive' | undefined): string | null {
  if (kind === 'npm') return t('capabilities.agentAdd.distribution.npm');
  if (kind === 'uv') return t('capabilities.agentAdd.distribution.uv');
  if (kind === 'archive') return t('capabilities.agentAdd.distribution.archive');
  return null;
}



const styles = StyleSheet.create((theme) => ({
  where: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
  note: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  noteText: { flex: 1, minWidth: 0, color: theme.colors.text.secondary },
  // The plugin source's empty state is centred in the body the list leaves, as the lab draws it.
  pluginsEmpty: { flex: 1, justifyContent: 'center' },
  emptyActions: { alignItems: 'center', gap: theme.space.s12 },
  emptyButtons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: theme.space.s8 },
  empty: {
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s32,
  },
}));
