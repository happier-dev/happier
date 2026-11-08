import * as React from 'react';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { machineSetupSourceOriginKeyV1, type MachineSetupSourceEntryV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ActionOperationRows } from '@/components/inbox/actionOperations/ActionOperationLedger';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { projectMachineSetupStepChecklist } from '@/components/inbox/actionOperations/actionOperationDetailPresentation';
import { MachineInstallablesSection } from '@/components/machines/installables/MachineInstallablesSection';
import { useMachineToolsSummary } from '@/components/machines/installables/useMachineToolsSummary';
import type { MachinePageTabBodyProps, MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
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
import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PlanChecklistCard } from '@/components/systemTasks/planChecklist';
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
import { describeMachineSetupReason } from './machineSetupReasonText';

type SetupParams = Extract<MachinePageTabParams, { id: 'setup' }>;
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
  const params = props.params as SetupParams;
  const setParams = props.setParams;
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

  const attached = setup.plan?.sources.filter(isAttachedSource) ?? NO_SOURCES;
  const attachedKeys = new Set(attached.map(machineSetupSourceOriginKeyV1));
  const attachable = presetList.filter(
    (entry) => !attachedKeys.has(presetOriginKey(entry)),
  );
  const nameOf = (source: AttachedSource) =>
    source.kind === 'bundledPreset'
      ? t('machinePresets.setup.tab.bundledPreset')
      : (presetList.find((entry) => entry.id === source.presetId)?.name ??
        t('machinePresets.setup.tab.presetUnreadable'));
  const nothingSetUp =
    setup.plan !== null && attached.length === 0 && recipes.length === 0;
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
        localize={localize}
      />
      {firstLoad ? (
        <PageLoadingRows testID="machine-setup-loading" />
      ) : (
        <>
          {attached.length > 0 || presetList.length === 0 ? (
            <ItemGroup
              title={t('machinePresets.setup.tab.presets')}
              testID="machine-setup-preset"
              description={
                attached.length > 0
                  ? t('machinePresets.setup.tab.presetsHelp', { machine })
                  : undefined
              }
              action={
                editable && attached.length > 0 && presetList.length > 0 ? (
                  <AttachPresetMenu
                    presets={attachable}
                    disabled={setup.pending !== null}
                    onChoose={(choice) => {
                      void setup.prepare({ kind: 'preset', preset: choice });
                    }}
                  />
                ) : undefined
              }
            >
              {attached.length > 0 ? (
                attached.map((source) => {
                  const sourceKey = machineSetupSourceOriginKeyV1(source);
                  const latest =
                    source.kind === 'accountPreset'
                      ? (presetList.find((entry) => entry.id === source.presetId) ?? null)
                      : null;
                  return (
                    <AttachedPresetRow
                      key={sourceKey}
                      sourceKey={sourceKey}
                      source={source}
                      name={nameOf(source)}
                      newer={
                        latest && source.kind === 'accountPreset' && latest.revision > source.presetRevision
                          ? latest
                          : null
                      }
                      editable={editable}
                      busy={setup.pending !== null}
                      onApplyAgain={(choice) => {
                        void setup.prepare({ kind: 'preset', preset: choice });
                      }}
                      onStopUsing={() => {
                        void setup.prepare({ kind: 'stop', sourceKey, name: nameOf(source) });
                      }}
                    />
                  );
                })
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
                  accessoryLayout="adaptive"
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
            ) : null}
          </ItemGroup>
          {RECIPE_KIND_GROUPS.map(({ kind, title }) => {
            const ofKind = recipes.filter((recipe) => recipe.item.kind === kind);
            return ofKind.length === 0 ? null : (
              <ItemGroup
                key={kind}
                title={t(title)}
                titleAccessory={<ManagedSectionCount count={ofKind.length} />}
                testID={`machine-setup-recipes-${kind === 'setupRecipe' ? 'setup' : 'software'}`}
              >
                {ofKind.map((recipe) => (
                  <RecipeRow
                    key={recipe.key}
                    recipe={recipe}
                    title={
                      recipe.title
                        ? localize(recipe.ref.pluginId, recipe.title)
                        : null
                    }
                    presetName={
                      setup.plan && recipe.fromPreset
                        ? nameOf(setup.plan.sources[recipe.sourceIndex] as AttachedSource)
                        : null
                    }
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
                ))}
              </ItemGroup>
            );
          })}
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

/** What they set up, by kind, in the order a person reads a Machine: its setup, then the software on it. */
const RECIPE_KIND_GROUPS = [
  { kind: 'setupRecipe', title: 'machinePresets.setup.tab.recipesSetup' },
  { kind: 'softwareRecipe', title: 'machinePresets.setup.tab.recipesSoftware' },
] as const;

/** Attention, in order: the Apply this tab started, else a failure in words with its next step, else drift. */
function MachineSetupAttention(
  props: Readonly<{
    serverId: string;
    setup: MachineSetupState;
    machineName: string;
    drifted: number;
    editable: boolean;
    canManage: boolean;
    localize: (pluginId: string, value: unknown) => string;
  }>,
) {
  const { setup, localize } = props;
  const operations = React.useMemo(
    () => (setup.operation ? [setup.operation] : []),
    [setup.operation],
  );
  const domainRef = setup.operation?.snapshot.domainRef;
  // The operation's own reviewed steps, in place; their labels carry their own fallback words.
  const steps = React.useMemo(
    () => (domainRef?.kind === 'machineSetup' ? projectMachineSetupStepChecklist(domainRef, (label) => localize('', label)) : null),
    [domainRef, localize],
  );
  const [expandedIds, setExpandedIds] = React.useState<readonly string[]>([]);
  const toggleExpanded = React.useCallback((id: string) => {
    setExpandedIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }, []);
  if (setup.operationId) {
    const operationId = setup.operationId;
    const open = () => openActionOperationDetail({ serverId: props.serverId, operationId });
    if (steps && operations.length > 0) {
      return (
        <ItemGroup surface="none" testID="machine-setup-operation" title={t('machinePresets.setup.tab.applying')}>
          <PlanChecklistCard
            testID="machine-setup-steps"
            phase="execute"
            items={steps.items}
            selectedIds={steps.selectedIds}
            executionById={steps.executionById}
            expandedIds={expandedIds}
            onToggleExpanded={toggleExpanded}
            header={<ActionOperationRows operations={operations} showDivider
              onOpenOperation={(operation) => openActionOperationDetail({ serverId: operation.serverId, operationId: operation.snapshot.operationId })} />}
          />
        </ItemGroup>
      );
    }
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
  const stopping = review.intent.kind === 'stop' ? review.intent.name : null;
  return (
    <View testID="machine-setup-review">
      <MachineTabSubHead
        title={
          stopping !== null
            ? t('machinePresets.setup.tab.reviewStopUsing', { preset: stopping })
            : removing
              ? t('machinePresets.setup.tab.reviewRemove')
              // The title names what gets applied, where: the chosen preset, or the Machine's own setup again.
              : review.intent.kind === 'preset'
                ? t('machinePresets.setup.tab.reviewApplyPreset', { preset: review.intent.preset.name, machine: props.machineName })
                : review.intent.kind === 'reapply'
                  ? t('machinePresets.setup.tab.reviewReapplyTitle', { machine: props.machineName })
                  : t('machinePresets.setup.tab.reviewTitle')
        }
        description={
          stopping !== null
            ? t('machinePresets.setup.tab.stopUsingHelp')
            : t('machinePresets.setup.tab.reviewHelp')
        }
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
                    label: stopping !== null
                      ? t('machinePresets.setup.tab.stopUsingRun')
                      : removing
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
  // A recipe that can't run here says why, in the setup owner's words, and leads to its one next step (Remove…).
  const blocked = recipe.status === 'unsupported' || recipe.status === 'unavailable' || recipe.status === 'unverifiable';
  const why = blocked ? describeMachineSetupReason(recipe.reason) : null;
  return (
    <Item
      testID={`machine-setup-recipe:${recipe.key}`}
      icon={
        <Icon
          name="wrench"
          size={ICON_SIZE.md}
          color={theme.colors.text.secondary}
        />
      }
      title={props.title ?? t('machinePresets.setup.tab.recipeUnnamed')}
      subtitle={why ? `${state} · ${source}\n${why}` : state ? `${state} · ${source}` : source}
      subtitleLines={why ? 0 : undefined}
      showChevron={false}
      accessoryLayout="adaptive"
      rightElement={
        !props.editable ? undefined : blocked && props.onRemove ? (
          <RoundButton
            testID={`machine-setup-recipe-remove:${recipe.key}`}
            size="small"
            display="secondary"
            title={t('machinePresets.setup.tab.removeRecipe')}
            disabled={props.busy}
            onPress={props.onRemove}
          />
        ) : recipe.status === 'drifted' ? (
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

type AttachedSource = Exclude<MachineSetupSourceEntryV1, { kind: 'direct' }>;
const NO_SOURCES: readonly AttachedSource[] = Object.freeze([]);
const isAttachedSource = (source: MachineSetupSourceEntryV1): source is AttachedSource => source.kind !== 'direct';
/** The origin key an Account preset has once attached, from the source owner rather than a local format. */
const presetOriginKey = (preset: ManagedMachinePresetV1) =>
  machineSetupSourceOriginKeyV1({ kind: 'accountPreset', presetId: preset.id, presetRevision: preset.revision, setup: preset.setup ?? {} });

/** One attached preset (q/machine): what it is and how current, Apply again when its preset moved on, Stop using. */
function AttachedPresetRow(
  props: Readonly<{
    sourceKey: string;
    source: AttachedSource;
    name: string;
    newer: ManagedMachinePresetV1 | null;
    editable: boolean;
    busy: boolean;
    onApplyAgain: (preset: ManagedMachinePresetV1) => void;
    onStopUsing: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { source, newer } = props;
  const facts =
    source.kind === 'accountPreset'
      ? t('machinePresets.setup.tab.presetFacts', {
          revision: source.presetRevision,
          count: source.setup.items?.length ?? 0,
        })
      : t('machinePresets.setup.itemCount', { count: source.setup.items?.length ?? 0 });
  return (
    <Item
      testID={`machine-setup-source:${props.sourceKey}`}
      accessoryLayout="adaptive"
      icon={<Icon name="stack" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
      title={props.name}
      subtitle={
        newer
          ? `${t('machinePresets.setup.tab.newerRevision', { revision: newer.revision })} · ${facts}`
          : facts
      }
      showChevron={false}
      rightElement={
        props.editable ? (
          <View style={styles.rowActions}>
            {newer ? (
              <RoundButton
                testID={`machine-setup-source-again:${props.sourceKey}`}
                size="small"
                display="secondary"
                title={t('machinePresets.setup.tab.applyAgain')}
                disabled={props.busy}
                onPress={() => props.onApplyAgain(newer)}
              />
            ) : null}
            <DropdownMenu
              testID={`machine-setup-source-menu:${props.sourceKey}`}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              matchTriggerWidth={false}
              items={[
                {
                  id: 'stop',
                  title: t('machinePresets.setup.tab.stopUsing'),
                  destructive: true,
                },
              ]}
              onSelect={() => {
                setMenuOpen(false);
                props.onStopUsing();
              }}
              trigger={({ toggle }) => (
                <RoundButton
                  testID={`machine-setup-source-more:${props.sourceKey}`}
                  size="small"
                  display="secondary"
                  title="…"
                  accessibilityLabel={t('common.more')}
                  disabled={props.busy}
                  onPress={toggle}
                />
              )}
            />
          </View>
        ) : undefined
      }
    />
  );
}

/** Attach a preset (q/attach): setup presets this Machine doesn't use yet; choosing one reviews it in place. */
function AttachPresetMenu(
  props: Readonly<{
    presets: readonly ManagedMachinePresetV1[];
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
        subtitle: describePreset(preset),
      })),
    [props.presets],
  );
  return (
    <DropdownMenu
      testID="machine-setup-attach-menu"
      open={open}
      onOpenChange={setOpen}
      items={items}
      search={items.length > 6}
      matchTriggerWidth={false}
      emptyLabel={t('machinePresets.setup.tab.attachNone')}
      onSelect={(id) => {
        setOpen(false);
        const preset = props.presets.find((entry) => entry.id === id);
        if (preset) props.onChoose(preset);
      }}
      trigger={({ toggle }) => (
        <RoundButton
          testID="machine-setup-attach-preset"
          size="small"
          display="secondary"
          title={t('machinePresets.setup.tab.attachPreset')}
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
      title={t('machinePresets.setup.tab.toolsRow')}
      subtitle={describeMachineToolsSummary(summary)}
      onPress={props.onPress}
    />
  );
}

/** A preset's one line: what it sets up, in the receipt's own words. */
function describePreset(preset: ManagedMachinePresetV1): string {
    return describeMachineSetup(preset.setup).map(fact => t('machinePresets.setup.fact', { label: fact.label, value: fact.value })).join(' · ');
}

const styles = StyleSheet.create((theme) => ({
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
