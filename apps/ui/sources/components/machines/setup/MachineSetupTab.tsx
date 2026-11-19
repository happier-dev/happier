import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import * as React from 'react';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { machineSetupSourceApplyOriginKeyV1, type MachineSetupSourceApplyV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { machineSetupSourceOriginKeyV1, type MachineSetupSourceEntryV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
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
import type { OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { machineSetupPresetSource, readMachineSetupPresetChoices, type MachineSetupPresetChoice } from '@/components/settings/machines/managed/machineSetupPresetChoices';
import { machineSetupSourceName } from '@/components/machines/setup/machineSetupSourceName';
import { showMachineSavePreset } from '@/components/machines/setup/MachineSavePresetModal';
import { machinePresetCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { machineSetupItemReadRow } from '@/components/settings/machines/managed/MachineSetupSection';
import { machineSetupItemPresentation } from '@/components/settings/machines/managed/machineSetupItems';
import { buildStoreListingRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useMachineSetupRecipeOptions, useSoftwareOptions } from '@/components/store/catalog/storeSoftware';
import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { Item } from '@/components/ui/lists/Item';
import { MachineOfflineNotice } from '@/components/machines/page/MachineOfflineNotice';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';

import {
  readMachineSetupApps,
  findMachineSetupPresetMissingAddress,
  readOpenedMachineSetupSources,
  readMachineSetupRecipes,
  type MachineSetupOpenedSourceV1,
  type MachineSetupPresetUpdateV1,
  useMachineSetup,
  type MachineSetupRecipeRow,
  type MachineSetupState,
} from './useMachineSetup';
import { describeMachineSetupReason } from './machineSetupReasonText';
import { MachineSetupRunProgress } from './MachineSetupRunRegion';
import { MachineSignInsSection } from './MachineSignInsSection';

type SetupParams = Extract<MachinePageTabParams, { id: 'setup' }>;
const SETUP_PARAMS = Object.freeze({ id: 'setup' }) as SetupParams;
const NO_PRESETS: readonly OpenedManagedMachinePresetV1[] = Object.freeze([]);
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
const selectCanManage = canManageMachine;

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
  const canManage = useServerScopedMachine(
    props.serverId,
    props.machineId,
    selectCanManage,
  );
  const setup = useMachineSetup({
    serverId: props.serverId,
    machineId: props.machineId,
    active: presented,
    online: props.online,
    canCheck: canManage,
  });
  const saveScope = useServerCredentialAccountScopeBinding(props.serverId).binding?.scope ?? null;
  const homeId = getServerProfileById(props.serverId)?.serverIdentityId ?? null;
  const editable = canManage && props.online !== false;
  const projection = useAppShellPluginUiDeclarationProjection();
  const localize = usePluginLocalizedTextResolver({ projection });
  const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
  const presets = useMachinePresets(serverIds);
  const presetList = React.useMemo(
    () =>
      readMachineSetupPresetChoices(presets.presetsByServerId[props.serverId] ?? [], projection, localize),
    [presets.presetsByServerId, props.serverId, projection, localize],
  );
  const openedSources = React.useMemo(
    () => readOpenedMachineSetupSources(setup.sourcePresentations),
    [setup.sourcePresentations],
  );
  const recipes = React.useMemo(
    () => readMachineSetupRecipes(setup.plan, openedSources, setup.observation),
    [openedSources, setup.plan, setup.observation],
  );
  const attached = React.useMemo(
    () => readAttachedMachineSetupSources(setup.plan?.sources ?? NO_SOURCES, openedSources),
    [openedSources, setup.plan?.sources],
  );
  const recipeTarget = React.useMemo(() => saveScope ? { scope: saveScope, machine: null } : null, [saveScope]);
  const recipeOptions = useMachineSetupRecipeOptions(recipeTarget, { presented: presented && recipes.length > 0 });
  const recipeOffers = recipeOptions.state.status === 'ready' ? recipeOptions.state.options : null;
  const drifted = recipes.filter(
    (recipe) => recipe.status === 'drifted',
  ).length;
  const machine = props.machineName;

  if (setup.review) {
    return <MachineSetupReviewInPlace setup={setup} machineName={machine} />;
  }

  const attachedKeys = new Set(attached.map((source) => source.sourceKey));
  const attachable = presetList.filter(
    (entry) => !attachedKeys.has(presetOriginKey(entry)),
  );
  const nameOf = (source: AttachedSetupSource) => {
    if (!source.opened) return t('machinePresets.setup.tab.presetUnreadable');
    return source.opened.source.kind === 'accountPreset'
      ? source.opened.presetName ?? t('machinePresets.setup.tab.presetUnreadable')
      : source.opened.source.kind === 'bundledPreset' ? machineSetupSourceName(source.opened.source, presetList)
        : t('machinePresets.setup.tab.presetUnreadable');
  };
  const nothingSetUp =
    setup.plan !== null && attached.length === 0 && recipes.length === 0;
  const firstLoad = setup.plan === null && setup.failure?.during !== 'check';
  const apps = readMachineSetupApps(openedSources);
  const allSourcesOpened = setup.plan !== null
    && setup.sourcePresentations !== null
    && setup.sourcePresentations.length === setup.plan.sources.length
    && setup.sourcePresentations.every((source) => source.kind === 'opened');
  const capturable = allSourcesOpened
    && openedSources.some(({ source }) => describeMachineSetup(source.setup).length > 0);
  const presetCatalog = presets.presetsByServerId[props.serverId] ?? NO_PRESETS;
  const toolsSection = (
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
  );
  // Nothing can be read for these two: one line says why, in place of sections that would claim an empty setup.
  const offlineUnread = setup.plan === null && props.online === false;
  if (!canManage || offlineUnread) {
    return (
      <View testID="machine-setup">
        {canManage ? (
          // The page header says it is offline; this says what that means for its setup (one notice per tab).
          <MachineOfflineNotice testID="machine-setup-offline" title={t('machinePresets.setup.tab.offlineReason')} />
        ) : (
          <ItemGroup
            surface="none"
            description={t('machinePresets.setup.tab.readOnly')}
            testID="machine-setup-read-only"
          >
            {null}
          </ItemGroup>
        )}
        {toolsSection}
      </View>
    );
  }

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
        // "Nothing is set up" only while that is true: a Machine with a setup run (live or retained) has had
        // something set up, so the empty intro would be a false status there and is left out.
        {...(nothingSetUp && setup.operationId !== null ? {} : {
          description: nothingSetUp
            ? t('machinePresets.setup.tab.ledeEmpty', { machine })
            : t('machinePresets.setup.tab.lede', { machine }),
        })}
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
        localize={localize}
        presets={presetList}
      />
      <MachineSignInsSection
        serverId={props.serverId}
        machineId={props.machineId}
        machineName={machine}
        presented={presented}
        editable={editable}
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
                  const sourceKey = source.sourceKey;
                  const opened = source.opened;
                  const openedSource = opened?.source;
                  // The setup owner decides whether an attached preset's setup changed or went away; the row only says so.
                  const update = openedSource?.kind === 'accountPreset'
                    ? setup.presetUpdates.find((entry) => entry.presetId === openedSource.presetId) ?? null
                    : null;
                  return (
                    <AttachedPresetRow
                      key={sourceKey}
                      sourceKey={sourceKey}
                      source={openedSource && openedSource.kind !== 'direct' ? openedSource : null}
                      name={nameOf(source)}
                      update={update}
                      editable={editable}
                      busy={setup.pending !== null}
                      onReviewUpdate={(change) => {
                        void setup.prepare({ kind: 'presetUpdate', presetId: change.presetId,
                          presetRevision: change.presetRevision, setupRevision: change.setupRevision, name: nameOf(source) });
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
                      // Natural width when the row stacks it under the words on a phone.
                      <View style={styles.naturalWidth}>
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
                      </View>
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
                    presentation={machineSetupItemPresentation(recipe.item, recipeOffers)}
                    presetName={recipe.presetName}
                    editable={editable}
                    busy={setup.pending !== null}
                    onRetry={() => {
                      void setup.check();
                    }}
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
          {apps.length > 0 ? (
            <ItemGroup
              title={t('machinePresets.setup.tab.recipesApps')}
              titleAccessory={<ManagedSectionCount count={apps.length} />}
              testID="machine-setup-recipes-apps"
            >
              {apps.map((app) => {
                const read = machineSetupItemReadRow(app.item, machineSetupItemPresentation(app.item, null));
                return (
                  <Item
                    key={app.key}
                    {...read}
                    subtitle={joinHappierFacts(
                      app.source.kind === 'direct'
                        ? null
                        : t('machinePresets.setup.tab.fromPreset', {
                            preset: app.source.kind === 'accountPreset'
                              ? app.presetName ?? t('machinePresets.setup.tab.presetUnreadable')
                              : machineSetupSourceName(app.source, presetList),
                          }),
                      read.subtitle,
                    )}
                    subtitleLines={0}
                    mode="info"
                    showChevron={false}
                  />
                );
              })}
            </ItemGroup>
          ) : null}
          {capturable && saveScope && homeId ? (
            <ItemGroup testID="machine-setup-save">
              <Item
                testID="machine-setup-save-preset"
                icon={<Icon name="stack" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                title={t('machinePresets.setup.tab.saveAsPreset')}
                subtitle={t('machinePresets.setup.tab.saveAsPresetHelp')}
                onPress={() => {
                  showMachineSavePreset({
                    serverId: props.serverId,
                    homeId,
                    scope: saveScope,
                    machineName: machine,
                    sources: openedSources.map(({ source }) => source),
                    presets: presetCatalog,
                    onSaved: (presetId) => router.push(machinePresetCollectionHref({ serverId: props.serverId, presetId }) as never),
                  });
                }}
              />
            </ItemGroup>
          ) : null}
        </>
      )}
      {toolsSection}
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
    localize: (pluginId: string, value: unknown) => string;
    presets: readonly MachineSetupPresetChoice[];
  }>,
) {
  const { setup, localize } = props;
  const router = useRouter();
  if (setup.operationId) {
    return (
      <MachineSetupRunProgress serverId={props.serverId} setup={setup} machineName={props.machineName} localize={localize}
        onRetry={props.editable && setup.operation ? () => { void setup.prepare({ kind: 'reapply' }); } : null} />
    );
  }
  if (setup.failure) {
    const failure = setup.failure.failure ?? {
      ok: false as const,
      errorCode: setup.failure.code,
      error: setup.failure.code,
    };
    const presented = presentActionFailureOutcome(failure);
    // A saved App with no address can't be fixed by checking again: its preset's setup editor holds the address field.
    const details = setup.failure.failure?.details;
    const addressKey = setup.failure.code === 'template_domain_required' && details && typeof details === 'object'
      && 'key' in details && typeof details.key === 'string' ? details.key : null;
    const addressPresetId = addressKey && props.editable
      ? findMachineSetupPresetMissingAddress(setup.observation?.attachedPresets, props.presets, addressKey) : null;
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
          diagnosticDetail={presented.technicalDetails.map(line => `${line.label}: ${line.value}`).join('\n')}
          action={addressPresetId ? {
            label: t('machinePresets.editSetup'),
            onPress: () => router.push(`${machinePresetCollectionHref({ serverId: props.serverId, presetId: addressPresetId })}&edit=true` as never),
          } : {
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
              : review.intent.kind === 'preset' || (review.intent.kind === 'presetUpdate' && review.intent.name)
                ? t('machinePresets.setup.tab.reviewApplyPreset', { preset: review.intent.kind === 'preset' ? review.intent.preset.name : review.intent.name!, machine: props.machineName })
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
            prepared={review.prepared}
            nameOf={nameOf}
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
    presentation: ReturnType<typeof machineSetupItemPresentation>;
    presetName: string | null;
    editable: boolean;
    busy: boolean;
    onRetry: () => void;
    onReapply: () => void;
    onRemove?: () => void;
  }>,
) {
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
  const unchecked = recipe.status === 'unavailable' || recipe.status === 'unverifiable';
  const blocked = recipe.status === 'unsupported' || unchecked;
  const reason = blocked ? describeMachineSetupReason(recipe.reason) : null;
  const why = reason && recipe.requiredFact ? `${reason} (${recipe.requiredFact})` : reason;
  return (
    <Item
      testID={`machine-setup-recipe:${recipe.key}`}
      {...machineSetupItemReadRow(recipe.item, props.presentation)}
      subtitle={why ? `${state} · ${source}\n${why}` : state ? `${state} · ${source}` : source}
      subtitleLines={why ? 0 : undefined}
      showChevron={false}
      accessoryLayout="adaptive"
      rightElement={
        !props.editable ? undefined : unchecked ? (
          <RoundButton
            testID={`machine-setup-recipe-retry:${recipe.key}`}
            size="small"
            display="secondary"
            title={t('common.retry')}
            disabled={props.busy}
            onPress={props.onRetry}
          />
        ) : recipe.status === 'unsupported' && props.onRemove ? (
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
type AttachedSetupSource = Readonly<{
  sourceKey: string;
  opened: MachineSetupOpenedSourceV1 | null;
}>;
const NO_SOURCES: readonly MachineSetupSourceApplyV1[number][] = Object.freeze([]);
function readAttachedMachineSetupSources(
  sources: readonly MachineSetupSourceApplyV1[number][],
  opened: readonly MachineSetupOpenedSourceV1[],
): readonly AttachedSetupSource[] {
  const openedByIndex = new Map(opened.map((source) => [source.sourceIndex, source]));
  return sources.flatMap((source, sourceIndex) =>
    source.kind === 'direct'
      ? []
      : [{
          sourceKey: machineSetupSourceApplyOriginKeyV1(source),
          opened: openedByIndex.get(sourceIndex) ?? null,
        }],
  );
}
/** The origin key an Account preset has once attached, from the source owner rather than a local format. */
const presetOriginKey = (preset: MachineSetupPresetChoice) =>
  machineSetupSourceOriginKeyV1(machineSetupPresetSource(preset));

/** One attached preset (q/machine): what it is and how current, Apply again when its preset moved on, Stop using. */
function AttachedPresetRow(
  props: Readonly<{
    sourceKey: string;
    source: AttachedSource | null;
    name: string;
    update: MachineSetupPresetUpdateV1 | null;
    editable: boolean;
    busy: boolean;
    onReviewUpdate: (change: Extract<MachineSetupPresetUpdateV1, { kind: 'changed' }>) => void;
    onStopUsing: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { source, update } = props;
  const changed = update?.kind === 'changed' ? update : null;
  const facts =
    source === null
      ? t('common.unavailable')
      : source.kind === 'accountPreset'
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
        changed
          ? `${t('machinePresets.setup.tab.newerRevision', { revision: changed.presetRevision })} · ${facts}`
          : update?.kind === 'unavailable'
            ? `${t(update.reason === 'preset_archived' ? 'machinePresets.setup.tab.presetArchived' : 'machinePresets.setup.tab.presetGone')} · ${facts}`
            : facts
      }
      showChevron={false}
      rightElement={
        props.editable ? (
          <View style={styles.rowActions}>
            {changed ? (
              <RoundButton
                testID={`machine-setup-source-again:${props.sourceKey}`}
                size="small"
                display="secondary"
                title={t('machinePresets.setup.tab.reviewChanges')}
                disabled={props.busy}
                onPress={() => props.onReviewUpdate(changed)}
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
    presets: readonly MachineSetupPresetChoice[];
    disabled: boolean;
    onChoose: (preset: MachineSetupPresetChoice) => void;
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
function describePreset(preset: MachineSetupPresetChoice): string {
    return describeMachineSetup(preset.setup).map(fact => t('machinePresets.setup.fact', { label: fact.label, value: fact.value })).join(' · ');
}

const styles = StyleSheet.create((theme) => ({
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  naturalWidth: { alignSelf: 'flex-start' },
}));
