import * as React from 'react';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ActionOperationRows } from '@/components/inbox/actionOperations/ActionOperationLedger';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { MachineInstallablesSection } from '@/components/machines/installables/MachineInstallablesSection';
import { useMachineToolsSummary } from '@/components/machines/installables/useMachineToolsSummary';
import type { MachinePageTabBodyProps } from '@/components/machines/page/machinePageTabQuery';
import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';
import { describeMachineToolsSummary } from '@/components/machines/page/machineThisMachineSummaries';
import {
  MachineSetupPlanReview,
  MachineSetupReviewFooter,
} from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { describeMachineSetup } from '@/components/settings/machines/managed/MachineSetupSection';
import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { buildStoreListingRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useSoftwareOptions } from '@/components/store/catalog/storeSoftware';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';

import {
  readMachineSetupRecipes,
  useMachineSetup,
  type MachineSetupRecipeRow,
  type MachineSetupState,
} from './useMachineSetup';

type SetupParams = Readonly<{ id: 'setup'; page?: 'tools' }>;
const SETUP_PARAMS = Object.freeze({ id: 'setup' }) as SetupParams;
const TOOLS_PARAMS = Object.freeze({
  id: 'setup',
  page: 'tools',
}) as SetupParams;

/** Setup's own params: the Tools page when the route names it, else the tab's root. */
export function parseMachineSetupParams(
  raw: Readonly<Record<string, string | undefined>>,
): SetupParams {
  return raw.page === 'tools' ? TOOLS_PARAMS : SETUP_PARAMS;
}

/** Owners and Manage members change setup; Use members read it (MR6). */
const selectCanManage = (machine: Machine | null) =>
  machine?.isShared !== true || machine.access?.role === 'manage';

/**
 * Machine → Setup (P-M1, lab `machine/setup/over`): what this Machine is set up with — its preset, its recipes, its
 * tools — checked when the tab opens, and every change reviewed in place before it runs. The review becomes the
 * Apply's own operation rows. Tools (`page=tools`) is pushed inside the tab.
 */
export function MachineSetupTab(props: MachinePageTabBodyProps) {
  const params = props.params as unknown as SetupParams;
  const setParams = props.setParams as unknown as (next: SetupParams) => void;
  if (params.page === 'tools') {
    return (
      <View testID="machine-setup-tools">
        <MachineTabSubHead
          title={t('machineDetailPage.subPages.tools')}
          back={{
            label: t('machinePresets.setup.tab.title'),
            onPress: () => setParams(SETUP_PARAMS),
            testID: 'machine-setup-tools-back',
          }}
        />
        <MachineInstallablesSection
          serverId={props.serverId}
          machineId={props.machineId}
          machineSentenceName={props.machineName}
        />
      </View>
    );
  }
  return (
    <MachineSetupRoot {...props} onOpenTools={() => setParams(TOOLS_PARAMS)} />
  );
}

function MachineSetupRoot(
  props: MachinePageTabBodyProps & Readonly<{ onOpenTools: () => void }>,
) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const presented = useLayoutPresentationActive();
  const setup = useMachineSetup({
    serverId: props.serverId,
    machineId: props.machineId,
    active: presented,
    online: props.online,
  });
  const canManage = useServerScopedMachine(
    props.serverId,
    props.machineId,
    selectCanManage,
  );
  const editable = canManage && props.online !== false;
  const projection = useAppShellPluginUiDeclarationProjection();
  const localize = usePluginLocalizedTextResolver({ projection });
  const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
  const presets = useMachinePresets(serverIds);
  const presetList = React.useMemo(
    () =>
      (presets.presetsByServerId[props.serverId] ?? []).filter(
        (preset) => preset.setup && preset.archivedAt === undefined,
      ),
    [presets.presetsByServerId, props.serverId],
  );
  const recipes = React.useMemo(
    () => readMachineSetupRecipes(setup.plan, setup.observation),
    [setup.plan, setup.observation],
  );
  const drifted = recipes.filter(
    (recipe) => recipe.status === 'drifted',
  ).length;
  const machine = props.machineName;

  if (setup.review) {
    return <MachineSetupReviewInPlace setup={setup} machineName={machine} />;
  }

  const presetSource =
    setup.plan?.sources.find((source) => source.kind !== 'direct') ?? null;
  const preset =
    presetSource?.kind === 'accountPreset'
      ? (presetList.find((entry) => entry.id === presetSource.presetId) ?? null)
      : null;
  const nothingSetUp =
    setup.plan !== null && presetSource === null && recipes.length === 0;
  const firstLoad = setup.plan === null && setup.failure?.during !== 'check';

  const freshness = (
    <SurfaceFreshnessLine
      testID="machine-setup-freshness"
      presentation="chip"
      asOf={setup.checkedAt}
      busy={setup.checking}
      reason={setup.checking ? t('machinePresets.setup.tab.checking') : ''}
      {...(setup.checking || props.online === false
        ? {}
        : {
            action: {
              label: t('machinePresets.setup.tab.checkAgain'),
              onPress: () => {
                void setup.check();
              },
              testID: 'machine-setup-check-again',
            },
          })}
    />
  );
  return (
    <View testID="machine-setup">
      <ItemGroup
        surface="none"
        testID="machine-setup-lede"
        actionLayout="adaptive"
        description={
          nothingSetUp
            ? t('machinePresets.setup.tab.ledeEmpty', { machine })
            : t('machinePresets.setup.tab.lede', { machine })
        }
        action={freshness}
      >
        {null}
      </ItemGroup>
      <MachineSetupAttention
        serverId={props.serverId}
        setup={setup}
        machineName={machine}
        drifted={drifted}
        editable={editable}
        canManage={canManage}
      />
      {firstLoad ? (
        <PageLoadingRows testID="machine-setup-loading" />
      ) : (
        <>
          {presetSource || presetList.length === 0 ? (
            <ItemGroup
              title={t('machinePresets.setup.tab.preset')}
              testID="machine-setup-preset"
            >
              {presetSource ? (
                <Item
                  testID="machine-setup-preset-row"
                  icon={<Icon name="shield" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                  title={
                    preset?.name ??
                    (presetSource.kind === 'bundledPreset'
                      ? t('machinePresets.setup.tab.bundledPreset')
                      : t('machinePresets.setup.tab.presetUnreadable'))
                  }
                  subtitle={
                    presetSource.kind === 'accountPreset'
                      ? t('machinePresets.setup.tab.presetFacts', {
                          revision: presetSource.presetRevision,
                          count: presetSource.setup.items?.length ?? 0,
                        })
                      : t('machinePresets.setup.itemCount', {
                          count: presetSource.setup.items?.length ?? 0,
                        })
                  }
                  showChevron={false}
                  rightElement={
                    editable && presetList.length > 0 ? (
                      <PresetMenu
                        presets={presetList}
                        currentId={preset?.id ?? null}
                        label={t('machinePresets.setup.tab.changePreset')}
                        disabled={setup.pending !== null}
                        onChoose={(choice) => {
                          void setup.prepare({
                            kind: 'preset',
                            preset: choice,
                          });
                        }}
                      />
                    ) : undefined
                  }
                />
              ) : (
                <Item
                  testID="machine-setup-preset-none"
                  title={t('machinePresets.setup.tab.noPreset')}
                  subtitle={t('machinePresets.setup.tab.noPresetHelp')}
                  icon={<Icon name="plus" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                  onPress={editable ? () => router.push(`/settings/machines/presets/new?serverId=${encodeURIComponent(props.serverId)}` as never) : undefined}
                  showChevron={editable}
                />
              )}
            </ItemGroup>
          ) : (
            <ItemGroup
              title={t('machinePresets.setup.tab.startFromPreset')}
              testID="machine-setup-presets"
            >
              {presetList.map((entry, index) => (
                <Item
                  key={entry.id}
                  testID={`machine-setup-preset:${entry.id}`}
                  title={entry.name}
                  subtitle={describePreset(entry)}
                  showChevron={false}
                  rightElement={
                    editable ? (
                      <RoundButton
                        testID={`machine-setup-preset-review:${entry.id}`}
                        size="small"
                        display={index === 0 ? 'default' : 'secondary'}
                        title={t('machinePresets.setup.review.reviewRun')}
                        disabled={setup.pending !== null}
                        onPress={() => {
                          void setup.prepare({ kind: 'preset', preset: entry });
                        }}
                      />
                    ) : undefined
                  }
                />
              ))}
            </ItemGroup>
          )}
          <ItemGroup
            title={t('machinePresets.setup.tab.recipes')}
            testID="machine-setup-recipes"
            description={t('machinePresets.setup.tab.recipesHelp')}
            action={
              editable ? (
                <AddRecipeMenu
                  serverId={props.serverId}
                  machineId={props.machineId}
                  active={presented}
                />
              ) : undefined
            }
          >
            {recipes.length === 0 ? (
              <Item
                testID="machine-setup-recipes-none"
                title={t('machinePresets.setup.tab.noRecipes')}
                subtitle={t('machinePresets.setup.tab.noRecipesHelp')}
                showChevron={false}
              />
            ) : (
              recipes.map((recipe) => (
                <RecipeRow
                  key={recipe.key}
                  recipe={recipe}
                  title={
                    recipe.title
                      ? localize(recipe.ref.pluginId, recipe.title)
                      : null
                  }
                  presetName={preset?.name ?? null}
                  editable={editable}
                  busy={setup.pending !== null}
                  onReapply={() => {
                    void setup.prepare({ kind: 'reapply' });
                  }}
                  onRemove={
                    recipe.removable
                      ? () => {
                          void setup.prepare({
                            kind: 'remove',
                            item: recipe.item,
                          });
                        }
                      : undefined
                  }
                />
              ))
            )}
          </ItemGroup>
        </>
      )}
      <ItemGroup
        title={t('machinePresets.setup.tab.tools')}
        description={t('machinePresets.setup.tab.toolsHelp')}
        testID="machine-setup-tools-section"
      >
        <ToolsRow
          serverId={props.serverId}
          machineId={props.machineId}
          onPress={props.onOpenTools}
        />
      </ItemGroup>
    </View>
  );
}

/** Attention, in order: the Apply this tab started, else a failure in words with its next step, else drift. */
function MachineSetupAttention(
  props: Readonly<{
    serverId: string;
    setup: MachineSetupState;
    machineName: string;
    drifted: number;
    editable: boolean;
    canManage: boolean;
  }>,
) {
  const { setup } = props;
  const operations = React.useMemo(
    () => (setup.operation ? [setup.operation] : []),
    [setup.operation],
  );
  if (setup.operationId) {
    const operationId = setup.operationId;
    const open = () => openActionOperationDetail({ serverId: props.serverId, operationId });
    return (
      <ItemGroup testID="machine-setup-operation" title={t('machinePresets.setup.tab.applying')}>
        {operations.length > 0 ? (
          <ActionOperationRows operations={operations}
            onOpenOperation={(operation) => openActionOperationDetail({ serverId: operation.serverId, operationId: operation.snapshot.operationId })} />
        ) : (
          // Its rows arrive with the operation's first push; until then the started run opens its own output.
          <Item testID="machine-setup-operation-started" title={t('machinePresets.setup.tab.started', { machine: props.machineName })}
            subtitle={t('machinePresets.setup.tab.startedHelp')} onPress={open} />
        )}
      </ItemGroup>
    );
  }
  if (setup.failure) {
    const failure = setup.failure.failure ?? {
      ok: false as const,
      errorCode: setup.failure.code,
      error: setup.failure.code,
    };
    const presented = presentActionFailureOutcome(failure);
    const title =
      setup.failure.during === 'check'
        ? t('machinePresets.setup.review.planFailed', {
            machine: props.machineName,
          })
        : setup.failure.during === 'review'
          ? t('machinePresets.setup.review.planFailed', {
              machine: props.machineName,
            })
          : t('machinePresets.setup.applyFailed', {
              machine: props.machineName,
            });
    return (
      <ItemGroup surface="none" testID="machine-setup-failure">
        <SurfaceStateCard
          testID="machine-setup-error"
          kind="error"
          size="line"
          title={title}
          reason={presented.reason ?? undefined}
          diagnosticCode={presented.code ?? setup.failure.code}
          action={{
            label: t('common.retry'),
            onPress: () => {
              void setup.check();
            },
          }}
        />
      </ItemGroup>
    );
  }
  if (props.drifted > 0) {
    return (
      <AttentionBanner
        testID="machine-setup-drift"
        tone="warning"
        title={t('machinePresets.setup.tab.drifted', { count: props.drifted })}
        description={t('machinePresets.setup.tab.driftedHelp')}
        action={
          props.editable
            ? {
                label: t('machinePresets.setup.tab.reviewReapply'),
                onPress: () => {
                  void setup.prepare({ kind: 'reapply' });
                },
              }
            : null
        }
      />
    );
  }
  if (!props.canManage) {
    return (
      <ItemGroup
        surface="none"
        description={t('machinePresets.setup.tab.readOnly')}
        testID="machine-setup-read-only"
      >
        {null}
      </ItemGroup>
    );
  }
  return null;
}

/** The review replaces the sections in place (MR3): the shared review card, then its closing row. */
function MachineSetupReviewInPlace(
  props: Readonly<{ setup: MachineSetupState; machineName: string }>,
) {
  const { setup } = props;
  const review = setup.review!;
  const nameOf = React.useCallback(
    () => props.machineName,
    [props.machineName],
  );
  const removing = review.intent.kind === 'remove';
  return (
    <View testID="machine-setup-review">
      <MachineTabSubHead
        title={
          removing
            ? t('machinePresets.setup.tab.reviewRemove')
            : t('machinePresets.setup.tab.reviewTitle')
        }
        description={t('machinePresets.setup.tab.reviewHelp')}
        back={{
          label: t('machinePresets.setup.tab.title'),
          onPress: setup.cancelReview,
          testID: 'machine-setup-review-back',
        }}
      />
      {review.prepared ? (
        <MachineSetupPlanReview
          testID="machine-setup-plan-review"
          prepared={review.prepared}
          nameOf={nameOf}
          disabled={setup.pending !== null}
          onChangeRemoval={(_machineId, removeItemKeys) => {
            void setup.prepare(review.intent, removeItemKeys);
          }}
        />
      ) : (
        <PageLoadingRows testID="machine-setup-review-loading" />
      )}
      {setup.approvalId ? (
        <AttentionBanner
          testID="machine-setup-approval"
          tone="neutral"
          title={t('approvals.title')}
          description={t('approvals.status.open')}
        />
      ) : null}
      <ItemGroup surface="none">
        <BareSectionContent>
          <MachineSetupReviewFooter
            onCancel={setup.cancelReview}
            cancelTestID="machine-setup-review-cancel"
            primary={
              setup.approvalId
                ? undefined
                : {
                    testID: 'machine-setup-apply',
                    label: removing
                      ? t('machinePresets.setup.tab.removeRun')
                      : t('machinePresets.setup.applyRun', {
                          machine: props.machineName,
                        }),
                    loading: setup.pending !== null,
                    disabled: !review.prepared || setup.pending !== null,
                    onPress: () => {
                      void setup.apply();
                    },
                  }
            }
          />
        </BareSectionContent>
      </ItemGroup>
    </View>
  );
}

function RecipeRow(
  props: Readonly<{
    recipe: MachineSetupRecipeRow;
    title: string | null;
    presetName: string | null;
    editable: boolean;
    busy: boolean;
    onReapply: () => void;
    onRemove?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { recipe } = props;
  const source = recipe.fromPreset
    ? props.presetName
      ? t('machinePresets.setup.tab.fromPreset', { preset: props.presetName })
      : t('machinePresets.setup.tab.fromAPreset')
    : t('machinePresets.setup.tab.addedHere');
  const state =
    recipe.status === 'drifted'
      ? t('machinePresets.setup.tab.recipeDrifted')
      : recipe.status === 'unsupported'
        ? t('machinePresets.setup.tab.recipeUnsupported')
        : recipe.status === 'unavailable' || recipe.status === 'unverifiable'
          ? t('machinePresets.setup.tab.recipeUnchecked')
          : null;
  return (
    <Item
      testID={`machine-setup-recipe:${recipe.key}`}
      icon={
        <Icon
          name="package"
          size={ICON_SIZE.md}
          color={theme.colors.text.secondary}
        />
      }
      title={props.title ?? t('machinePresets.setup.tab.recipeUnnamed')}
      subtitle={state ? `${state} · ${source}` : source}
      showChevron={false}
      rightElement={
        !props.editable ? undefined : recipe.status === 'drifted' ? (
          <RoundButton
            testID={`machine-setup-recipe-reapply:${recipe.key}`}
            size="small"
            display="secondary"
            title={t('machinePresets.setup.tab.reapply')}
            disabled={props.busy}
            onPress={props.onReapply}
          />
        ) : props.onRemove ? (
          <DropdownMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            matchTriggerWidth={false}
            items={[
              {
                id: 'remove',
                title: t('machinePresets.setup.tab.removeRecipe'),
                destructive: true,
              },
            ]}
            onSelect={() => {
              setMenuOpen(false);
              props.onRemove?.();
            }}
            trigger={({ toggle }) => (
              <RoundButton
                testID={`machine-setup-recipe-more:${recipe.key}`}
                size="small"
                display="secondary"
                title="…"
                accessibilityLabel={t('common.more')}
                disabled={props.busy}
                onPress={toggle}
              />
            )}
          />
        ) : undefined
      }
    />
  );
}

function PresetMenu(
  props: Readonly<{
    presets: readonly ManagedMachinePresetV1[];
    currentId: string | null;
    label: string;
    disabled: boolean;
    onChoose: (preset: ManagedMachinePresetV1) => void;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo(
    () =>
      props.presets.map((preset) => ({
        id: preset.id,
        title: preset.name,
        subtitle:
          preset.id === props.currentId
            ? t('machinePresets.setup.tab.updateToLatest', {
                revision: preset.revision,
              })
            : describePreset(preset),
        checked: preset.id === props.currentId,
      })),
    [props.presets, props.currentId],
  );
  return (
    <DropdownMenu
      testID="machine-setup-preset-menu"
      open={open}
      onOpenChange={setOpen}
      items={items}
      search={items.length > 6}
      matchTriggerWidth={false}
      selectedId={props.currentId}
      onSelect={(id) => {
        setOpen(false);
        const preset = props.presets.find((entry) => entry.id === id);
        if (preset) props.onChoose(preset);
      }}
      trigger={({ toggle }) => (
        <RoundButton
          testID="machine-setup-change-preset"
          size="small"
          display="secondary"
          title={props.label}
          disabled={props.disabled}
          onPress={toggle}
        />
      )}
    />
  );
}

/**
 * Add recipe: the Machine's own Software choices (the `machines.setup.software.available` option source, read only
 * while the menu is open); choosing one opens its Store listing with this Machine chosen, which owns its options and
 * the same review.
 */
function AddRecipeMenu(
  props: Readonly<{ serverId: string; machineId: string; active: boolean }>,
) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  const homeId = getServerProfileById(props.serverId)?.serverIdentityId ?? null;
  const target = React.useMemo(
    () =>
      binding && homeId
        ? {
            scope: binding.scope,
            machine: { serverIdentityId: homeId, machineId: props.machineId },
          }
        : null,
    [binding, homeId, props.machineId],
  );
  const demand = React.useMemo(
    () => ({ presented: open && props.active }),
    [open, props.active],
  );
  const software = useSoftwareOptions(target, demand);
  const options = software.state.options;
  const items = React.useMemo(
    () =>
      options.map((option, index) => ({
        id: String(index),
        title: option.label,
        ...(option.description ? { subtitle: option.description } : {}),
        ...(option.disabled ? { disabled: true } : {}),
      })),
    [options],
  );
  return (
    <DropdownMenu
      testID="machine-setup-add-recipe-menu"
      open={open}
      onOpenChange={setOpen}
      items={items}
      search
      matchTriggerWidth={false}
      emptyLabel={
        software.state.status === 'loading'
          ? t('machinePresets.setup.tab.recipesLoading')
          : t('machinePresets.setup.tab.recipesEmpty')
      }
      onSelect={(id) => {
        setOpen(false);
        const option = options[Number(id)];
        if (!option || !target) return;
        router.push(
          buildStoreListingRoute({
            type: 'software',
            value: option.value,
            target,
          } as never) as never,
        );
      }}
      trigger={({ toggle }) => (
        <RoundButton
          testID="machine-setup-add-recipe"
          size="small"
          display="secondary"
          title={t('machinePresets.setup.tab.addRecipe')}
          onPress={toggle}
        />
      )}
    />
  );
}

function ToolsRow(
  props: Readonly<{ serverId: string; machineId: string; onPress: () => void }>,
) {
  const { theme } = useUnistyles();
  const summary = useMachineToolsSummary({
    serverId: props.serverId,
    machineId: props.machineId,
  });
  return (
    <Item
      testID="machine-setup-tools-row"
      icon={
        <Icon
          name="cube"
          size={ICON_SIZE.md}
          color={theme.colors.text.secondary}
        />
      }
      title={t('machineDetailPage.subPages.tools')}
      subtitle={describeMachineToolsSummary(summary)}
      onPress={props.onPress}
    />
  );
}

/** A preset's one line: what it sets up, in the receipt's own words. */
function describePreset(preset: ManagedMachinePresetV1): string {
    return describeMachineSetup(preset.setup).map(fact => t('machinePresets.setup.fact', { label: fact.label, value: fact.value })).join(' · ');
}
