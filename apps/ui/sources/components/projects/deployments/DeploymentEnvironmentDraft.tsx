import { DEPLOYMENT_TARGET_REQUIRES_REPOSITORY_DEFINITION } from '@happier-dev/protocol/deployments/resolvePublishTargetRecommendation';
import { OWN_SERVER_DEPLOYMENT_TARGET_V1, resolvePublishTargetRecommendation, type PublishTargetRecommendationInput } from '@happier-dev/deployments';
import { isMachineRoleActiveV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { deploymentRecommendationDescription, deploymentRecommendationReason } from './deploymentRecommendationDescription';
import { projectDeploymentConfigurePreflightV1 } from './deploymentPreflightWarnings';
import * as React from 'react';
import { MachineCreationContinuation, type MachineCreationContinuationDraft } from '@/components/machines/add/MachineCreationContinuation';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { ActionConfirmationReviewFacts } from '@/components/approvals/ActionConfirmationReview';
import { DeploymentCreationReviewFacts, type DeploymentCreationReviewPlan } from '@/components/approvals/ApprovalReviewFacts';
import { useInStepActionConfirmation } from '@/components/approvals/useInStepActionConfirmation';
import type { DeploymentEnvironmentTabV1 } from '@happier-dev/deployments';
import { DeploymentPartialProgress } from './DeploymentPartialProgress';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { DeploymentProjectChoiceGroups, type DeploymentProjectChoiceModel } from './DeploymentProjectChoice';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentEnvironmentCopyChoicesV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentCopyV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { DeploymentTemplateV1 } from '@happier-dev/protocol/registries';
import { environmentSecretBindingIdentityV1, projectEnvironmentSecretBindingIdentityV1, type DeploymentTemplateRefV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ProjectRefSelect } from '@/components/projects/ProjectRefSelect';
import { projectSourceRepositoryFacts } from '@/components/projects/sources/projectSourceRepositoryFacts';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { PLUGINS_APP_ROUTE } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildDeploymentEnvironmentHref, SERVICES_ROUTE } from './deploymentNavigation';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { FieldLayout, FieldValue } from '@/components/ui/lists/FieldRow';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readProjectAccountWorkspaceRefs, useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { resolveMachinePresence } from '@/sync/domains/machines/reachability/machinePresence';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { deploymentActionRefusalRemedy, deploymentDefinitionLabel, readDeploymentRefusalRecovery } from './deploymentPresentation';
import { DeploymentMachinesEmpty } from './DeploymentMachinesEmpty';
import type { DeploymentNewDefinitionKind } from './deploymentNavigation';
import { openDeploymentFolderWorkspace } from './prepareDeploymentSourceCheckout';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { DeploymentPreparationEntry } from './DeploymentPreparation';
import { DeploymentManagedDataProvisionEditor, type ManagedDataProvisionDraft } from './DeploymentManagedData';

import type { createDeploymentActions } from './deploymentActions';
import { DeploymentDeployerFields } from './DeploymentDeployerFields';
import { DeploymentTemplateDomainRows, projectDeploymentTemplateDomainChoices } from './DeploymentTemplateDomainRows';
import { DeploymentTemplateChoices, missingDeploymentTemplateVariable, type DeploymentTemplateChoicesValue } from './DeploymentTemplateChoices';
import { useDeployHostReadiness } from './EnvironmentMachineChoice';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { MachineSetupPlanReview, describeMachineSetupPlanFailure, describeMachineSetupReviewUnavailable } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { MachineSetupRecipeInputs } from '@/components/settings/machines/managed/MachineSetupRecipeInputs';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { DeploymentPlatformInspectState } from './DeploymentPlatformInspectState';
import { DeploymentPlatformTargetEditor, useDeploymentPlatformTargets } from './DeploymentPlatformTargetSheet';
import { DeploymentOwnMachineCost, DeploymentTargetPlans, DeploymentTargetPlansForAccount } from './DeploymentTargetPlans';
import { describeDeploymentPlatformRefusal } from './deploymentPlatformRefusal';
import { buildPlatformTargetCreateLinkInput, buildPlatformTargetLinkInput, readPreparedPlatformAccount, readPreparedPlatformResourceName, type PreparedPlatformTargetLink } from './platformTargetLink';
import type { readDeploymentPlatformTargets } from './platformTargetLink';
import {
  DeploymentRetentionChoice,
  deploymentManagedRetention,
  type DeploymentRetentionChoiceValue,
} from './DeploymentRetentionChoice';
import {
  readDeploymentActionError,
  readDeploymentActionResult,
  deploymentPartialRecoveryTab,
  type DeploymentActionOutcome,
} from './deploymentActionOutcome';

type Actions = ReturnType<typeof createDeploymentActions>;
type PreparedCreate = Pick<Awaited<ReturnType<Actions['prepareCreate']>>, 'review' | 'run'>;
type SavedEnvironment = Readonly<{ environmentId: string; projectSourceId?: string; revision: number }>;

function refusedPlatformLink(outcome: Extract<DeploymentActionOutcome, { kind: 'refused' }>, saved: SavedEnvironment): DeploymentActionOutcome {
  return { ...outcome, progress: {
    kind: 'partial', ...saved,
    phase: 'target', savedSecrets: [], errorCode: outcome.code,
  } };
}

const DEFAULT_COMPOSE_PATH = 'compose.yaml';
/** The own-server target is the catalog's own identity, so a suggested `targetId` resolves to the Machine card as is. */
const OWN_SERVER_TARGET = OWN_SERVER_DEPLOYMENT_TARGET_V1.id;
/** Not a choice: leads to Plugins, or reads the declared platforms again. */
const PLUGINS_TILE = 'plugins';
const RETRY_TILE = 'retry';
const LOADING_TILE = 'loading';

/** Deploy an app's steps (journey-deploy D3): this draft's own sections, split for a host that frames them. */
export type DeploymentDraftStep = 'where' | 'configure' | 'review';
/** What a stepped host needs to frame the current step: its facts for the summary, and the step's one action. */
export type DeploymentDraftFrame = Readonly<{
  step: DeploymentDraftStep;
  /** What the step's disabled action waits for, for the host's footer: an answering Machine on Where, an empty field on Configure. */
  waitingFor?: string | null;
  /** The answered Where: a platform's name or the Machine's. */
  runsOn: Readonly<{ kind: 'machine' | 'platform'; title: string | null }> | null;
  /** The Project's repository and branch, once its Source is read. */
  source: Readonly<{ title: string; note: string | null }> | null;
  appName: string | null;
  /** Review after Create refused: nothing was created (journey-deploy revFail). */
  refused: boolean;
  primary: Readonly<{ title: string; disabled: boolean; loading: boolean; testID: string }>;
  press: () => void;
  back: () => void;
  /** Change on the summary's Runs on: back to Where, dropping a prepared review. */
  toWhere: () => void;
}>;
export type DeploymentDraftStepsHost = Readonly<{ onFrame: (frame: DeploymentDraftFrame) => void; onExit: () => void }>;

/**
 * A new Environment (lab d1 `draft`): its name, the Machine that runs it, what runs and who may deploy. It is
 * the selected draft row's detail; nothing exists until Save, and nothing is deployed until the person
 * chooses to. Save prepares the Environment through its Action and shows what the creation defaults filled in;
 * Create commits that same prepared run, and Back drops it.
 */
export const DeploymentEnvironmentDraft = React.memo(
  function DeploymentEnvironmentDraft(
    props: Readonly<{
      lifetime: ServerAccountScopeLifetime | null;
      sourceId: string | null;
      /** The build preview explicitly selected by the entry point, for Review only. */
      projectChoice?: DeploymentProjectChoiceModel;
      phone: boolean;
      actions: Pick<Actions, 'prepareCreate' | 'checkPlatformTarget' | 'inspectPlatformTarget' | 'link'> | null;
      copyFrom?: DeploymentEnvironmentDetailV1 | null;
      createProduction?: boolean;
      /** A door that names what it starts from (Store → Apps): a stored definition, in any Project. */
      definitionKind?: DeploymentNewDefinitionKind | null;
      /** The exact registry App pin and its declared inputs. */
      catalogApp?: Readonly<{ templateRef: DeploymentTemplateRefV1; title: string; template: DeploymentTemplateV1 }> | null;
      /** Where a door already chose (a suggested platform); the recommendation owner still decides what is offered. */
      initialTargetKey?: string | null;
      onApprovalRequested: (artifactId: string) => void;
      onSaved: (environmentId: string, next: Readonly<{ tab?: DeploymentEnvironmentTabV1; projectSourceId: string }>) => void;
      /** Whether this viewer can link a platform; without it the draft offers machines only. */
      platformAvailable?: boolean;
      onDiscard: () => void;
      /** The Machine the door already chose (Deploy an app here); the person's own choice still wins. */
      initialMachineId?: string | null;
      /**
       * Hosted as steps (Deploy an app): Where, then Configure, then Review, each framed by the host (title, summary,
       * footer) from the published frame. The same instance walks every step, so nothing typed is lost between them.
       */
      steps?: DeploymentDraftStepsHost;
    }>,
  ) {
    const { theme } = useUnistyles();
    const projectSelection = props.projectChoice?.selection;
    const sourceId = props.projectChoice ? (projectSelection && 'projectSourceId' in projectSelection ? projectSelection.projectSourceId : null) : props.sourceId;
    const source =
      useProjectSource(props.lifetime, sourceId).source?.source ?? null;
    const allMachines = useMachineListForServer(
      props.lifetime?.scope.serverId ?? '', props.lifetime?.isCurrent() === true,
    );
    // A target link names each Machine's installation; a Machine without one cannot be linked.
    const machines = React.useMemo(
      () => (allMachines ?? []).filter((machine) => Boolean(machine.installationId)),
      [allMachines],
    );
    const stepped = props.steps !== undefined;
    // A stepped draft starts named and marked as production (journey-deploy cfgx); both stay one press away.
    const [name, setName] = React.useState(() => props.copyFrom
      ? t('projects.deployments.copy.name', { name: props.copyFrom.content.name })
      : stepped ? t('newApp.deploy.defaultEnvironmentName') : '');
    const [formStep, setFormStep] = React.useState<'where' | 'configure'>('where');
    const [moreOpen, setMoreOpen] = React.useState(false);
    const [configureVisited, setConfigureVisited] = React.useState(false);
    const [domainHostnames, setDomainHostnames] = React.useState<Readonly<Record<string, string>>>({});
    const catalogTemplate = props.catalogApp?.template;
    const catalogDomains = catalogTemplate?.domains;
    const [templateChoices, setTemplateChoices] = React.useState<DeploymentTemplateChoicesValue>({});
    const domainChoices = React.useMemo(() => catalogDomains
      ? projectDeploymentTemplateDomainChoices(catalogDomains, domainHostnames)
      : null, [catalogDomains, domainHostnames]);
    const missingVariable = catalogTemplate
      ? missingDeploymentTemplateVariable(catalogTemplate, templateChoices, domainChoices?.bindings) : null;
    const [copyChoices, setCopyChoices] = React.useState(() => props.copyFrom ? initialCopyChoices(props.copyFrom) : null);
    const [provisionDrafts, setProvisionDrafts] = React.useState<Readonly<Record<string, ManagedDataProvisionDraft | null>>>({});
    const onProvisionDraftChange = React.useCallback((targetLinkId: string, draft: ManagedDataProvisionDraft | null) => {
      setProvisionDrafts(current => ({ ...current, [targetLinkId]: draft }));
    }, []);
    const [creatingMachine, setCreatingMachine] = React.useState(false);
    const [machineCreationDraft, setMachineCreationDraft] = React.useState<MachineCreationContinuationDraft | null>(null);
    const [machineId, setMachineId] = React.useState<string | null>(props.initialMachineId ?? null);
    const router = useRouter();
    // Provider choices are prepared in the existing platform editor; Create links that exact result.
    const platforms = useDeploymentPlatformTargets(props.platformAvailable === true ? props.lifetime : null);
    const platformTargets = platforms.state.status === 'ready' ? platforms.state.targets : NO_PLATFORM_TARGETS;
    const [targetKey, setTargetKey] = React.useState<string>(props.initialTargetKey ?? OWN_SERVER_TARGET);
    const platformTarget = props.platformAvailable === true ? platformTargets.find((target) => target.key === targetKey) ?? null : null;
    const [platformProvider, setPlatformProvider] = React.useState<PreparedPlatformTargetLink | null>(null);
    const [platformWaitingFor, setPlatformWaitingFor] = React.useState<string | null>(null);
    const [composePath, setComposePath] = React.useState(DEFAULT_COMPOSE_PATH);
    const [composeDocument, setComposeDocument] = React.useState('');
    const [imageName, setImageName] = React.useState('');
    const [imagePort, setImagePort] = React.useState('');
    // A folder source: the chosen Machine's folder (absolute, as its browser returns it) and whether its .env files go too.
    const [folderSelection, setFolderSelection] = React.useState<Readonly<{ machineId: string; path: string }> | null>(null);
    const [folderEnvFiles, setFolderEnvFiles] = React.useState(false);
    const [ref, setRef] = React.useState<string | null>(null);
    // A copy is a new Environment beside its source, never a second production one by default (PAGE-ACCEPT-176 R10-D12).
    const [production, setProduction] = React.useState(props.createProduction || (!props.copyFrom && Boolean(stepped)));
    const [deployerMode, setDeployerMode] = React.useState<DeploymentEnvironmentDetailV1['environment']['deployerMode']>(
      props.copyFrom?.environment.deployerMode ?? 'managers',
    );
    const [deployerPrincipals, setDeployerPrincipals] = React.useState<readonly PrincipalRefV1[]>(
      props.copyFrom?.environment.deployerPrincipals ?? [],
    );
    const [saving, setSaving] = React.useState(false);
    const [prepared, setPrepared] = React.useState<PreparedCreate | null>(null);
    // The review step is also the controller's confirmation host: its carried review shows here and Create answers it.
    const stepConfirmation = useInStepActionConfirmation();
    const { answer: answerStepConfirmation, confirm: stepConfirm } = stepConfirmation;
    const stepReview = stepConfirmation.pending;
    const [refusal, setRefusal] =
      React.useState<DeploymentActionOutcome | null>(null);
    const refusedVariable = refusal?.kind === 'refused' && refusal.code === 'template_variable_required'
      ? readRecord(refusal.failure?.details).key : undefined;
    const refusedVariableKey = typeof refusedVariable === 'string' ? refusedVariable : undefined;
    const refusedDomainKey = catalogTemplate?.variables.find(variable => variable.key === refusedVariableKey)?.valueFrom?.domainKey;
    const partial = refusal?.kind === 'refused' ? refusal.progress : undefined;
    const createOutcomeUnknown = refusal?.kind === 'refused' && isActionOutcomeUnknownErrorCodeV1(refusal.code);
    const recoveryEnvironmentId = partial?.environmentId;
    const recoveryProjectSourceId = partial?.projectSourceId ?? sourceId;
    const recoveryReceipt = partial?.deployment;
    const recoveryDeploymentId = recoveryReceipt && 'deploymentId' in recoveryReceipt ? recoveryReceipt.deploymentId : undefined;
    const checkCreatedEnvironment = () => {
      const href = props.lifetime && recoveryProjectSourceId && recoveryEnvironmentId
        ? buildDeploymentEnvironmentHref({ serverId: props.lifetime.scope.serverId, projectSourceId: recoveryProjectSourceId,
            environmentId: recoveryEnvironmentId, ...(recoveryDeploymentId ? { deploymentId: recoveryDeploymentId } : {}) })
        : props.lifetime ? `${SERVICES_ROUTE}?serverId=${encodeURIComponent(props.lifetime.scope.serverId)}` : SERVICES_ROUTE;
      props.onDiscard();
      router.push(href as never);
    };
    const [retention, setRetention] =
      React.useState<DeploymentRetentionChoiceValue>('alwaysOn');
    const draftTitle = useCollectionDraftTitle();
    React.useEffect(() => {
      draftTitle.publish(name);
    }, [draftTitle, name]);
    React.useEffect(() => () => draftTitle.publish(''), [draftTitle]);

    // The first Machine that answers is the likely home; the person can choose another.
    // One presence owner says whether each Machine answers: the menu shows its words, and the default uses its fact.
    const presenceNowMs = useMachinePresenceNowMs(machines);
    const presence = React.useMemo(() => new Map(machines.map(machine =>
      [machine.id, resolveMachinePresence(machine, presenceNowMs)])), [machines, presenceNowMs]);
    const answers = (machine: (typeof machines)[number]) => presence.get(machine.id) === 'online';
    // A Machine whose Deployments role is off refuses deploys, so it is never the default home (Machine roles).
    const deploysHere = (machine: (typeof machines)[number]) => answers(machine) && isMachineRoleActiveV1(machine.metadata, 'deployments');
    // The person's choice wins. Otherwise a copy starts on its source's Machine and a new draft on the first one that
    // answers and accepts Deployments; with no eligible Machine nothing is chosen for the person.
    const preferredId = props.copyFrom ? copySourceMachineId(props.copyFrom) : null;
    const chosen =
      machineId !== null ? machines.find((machine) => machine.id === machineId) ?? null :
      machines.find((machine) => machine.id === preferredId && deploysHere(machine)) ?? machines.find(deploysHere) ?? null;
    const chosenPresence = chosen ? presence.get(chosen.id) : undefined;
    const folderPath = folderSelection && folderSelection.machineId === chosen?.id ? folderSelection.path : null;
    const defaultBranch = source?.defaultRef ?? source?.repository?.repository.defaultBranch ?? null;
    const branch = ref ?? defaultBranch;
    React.useEffect(() => setPlatformProvider(null), [platformTarget?.key, chosen?.id, source?.revision]);
    // A repository-free Project has only stored definitions; a door may also ask for one in any Project.
    const definitionKind = props.definitionKind ?? (source !== null && source.repository === undefined ? 'compose' : null);
    const storedDefinition = definitionKind !== null;
    const copiedDefinition = props.copyFrom?.content.definition;
    const hasCatalogApp = props.catalogApp != null;
    const definition = React.useMemo<PublishTargetRecommendationInput['definition']>(() =>
      copiedDefinition ?? (hasCatalogApp ? { from: 'catalogApp' }
        : definitionKind ? { from: definitionKind } : { kind: 'repository' }),
    [copiedDefinition, hasCatalogApp, definitionKind]);
    const platformEnvironment = React.useMemo(() => sourceId ? { projectSourceId: sourceId, definition, repositoryBranch: branch,
      ...(chosen ? { controllerMachineId: chosen.id } : {}) } : null, [sourceId, definition, branch, chosen?.id]);
    const recommendationInput: PublishTargetRecommendationInput = {
      definition,
      targets: [{ id: OWN_SERVER_TARGET, targetClass: 'ownServer', availability: allMachines == null || chosenPresence === 'unknown' ? 'unknown'
        : chosenPresence === 'online' ? 'available' : 'unavailable',
        accepts: OWN_SERVER_DEPLOYMENT_TARGET_V1.accepts, needs: OWN_SERVER_DEPLOYMENT_TARGET_V1.needs },
        ...platformTargets.map(target => ({ id: target.key, targetClass: 'platform' as const, availability: 'unknown' as const,
          accepts: target.accepts, needs: target.needs }))],
    };
    const recommendation = resolvePublishTargetRecommendation({ ...recommendationInput,
      explicitTarget: targetKey !== OWN_SERVER_TARGET ? { id: targetKey, targetClass: 'platform' } : undefined });
    // What Happier would suggest before the person picks: the stepped grid's lead and its Recommended badge read this,
    // so choosing a card only moves the selection, never the grid or the badge (DESIGN-ACCEPT-2 W4).
    const suggestion = stepped ? resolvePublishTargetRecommendation(recommendationInput) : recommendation;
    const offeredPlatformTargets = platformTargets.filter(target => recommendation.offeredTargetIds.includes(target.key));
    const onPlatform = recommendation.target?.targetClass === 'platform';
    const platformStatus = platforms.state.status;
    const platformDefinitionAccepted = recommendation.offeredTargetIds.includes(targetKey);
    const selectedPlatformUnavailable = onPlatform && !platformDefinitionAccepted
      && (props.platformAvailable !== true || platformStatus === 'ready');
    // The Configure preflight owner (DEPLOY-ACTIVITY-READ-1113) decides name and port syntax, as the server will.
    const configure = projectDeploymentConfigurePreflightV1({ name, port: imagePort });
    const imagePortValid = configure.port.status === 'valid';
    const imagePortNumber = configure.port.value ?? Number.NaN;
    // A Compose Environment reads the chosen Machine's readiness once; required host settings and an explicit
    // Review precede its setup Plan. Saving can wait for it; nothing runs until Apply.
    const host = useDeployHostReadiness(onPlatform || creatingMachine ? null : props.lifetime,
      onPlatform || creatingMachine || chosenPresence !== 'online' ? null : chosen?.id ?? null);
    const [hostApply, setHostApply] = React.useState<Readonly<{ pending: boolean; error: string | null }>>(HOST_APPLY_IDLE);
    React.useEffect(() => setHostApply(HOST_APPLY_IDLE), [chosen?.id]);
    const applyHostSetup = async () => {
      const lifetime = props.lifetime;
      if (!host.prepared?.ok || !lifetime || hostApply.pending) return;
      setHostApply({ pending: true, error: null });
      let result;
      try {
        result = await hostSetupExecute.confirmed('machines.setup.apply', host.prepared.input, { surface: 'ui',
          serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId });
      } catch {
        setHostApply({ pending: false, error: 'managed_request_failed' });
        return;
      }
      const outcome = classifyHomeActionOutcome(result);
      if (outcome.kind === 'failed') { setHostApply({ pending: false, error: homeDomainFailureCode(outcome.failure) }); return; }
      setHostApply(HOST_APPLY_IDLE);
      if (outcome.kind === 'approval_pending') { props.onApprovalRequested(outcome.artifactId); return; }
      const output = ManagedMachineActionOutputSchemasV1['machines.setup.apply'].safeParse(outcome.result);
      if (output.success) openActionOperationDetail({ serverId: lifetime.scope.serverId, operationId: output.data.operationId });
    };
    const reusableBindings = copyChoices?.secrets.filter(choice => choice.kind !== 'omit' && choice.binding.purpose === 'variable')
      .map(choice => choice.binding) ?? [];
    const valid =
      configure.name.status === 'valid' && (!props.projectChoice || projectSelection != null) &&
      !domainChoices?.missingRequired && !domainChoices?.invalidKeys.size && missingVariable === null &&
      (copyChoices?.data.every(choice => choice.kind === 'createEmpty' ? provisionDrafts[choice.targetLinkId] != null
        : choice.kind !== 'reuse' || Boolean(choice.bindings?.length && choice.bindings.every(binding =>
          reusableBindings.some(eligible => environmentSecretBindingIdentityV1(eligible) === environmentSecretBindingIdentityV1(binding))))) ?? true) &&
      chosen !== null && platformDefinitionAccepted && (!onPlatform || platformProvider !== null) &&
      (props.copyFrom !== undefined && props.copyFrom !== null || props.catalogApp != null || (definitionKind === 'image'
        ? imageName.trim().length > 0 && imagePortValid
        : definitionKind === 'folder'
        ? folderPath !== null && composePath.trim().length > 0
        : storedDefinition
        ? composeDocument.trim().length > 0
        : branch !== null && (onPlatform || composePath.trim().length > 0)));
    const { actions, onSaved, onApprovalRequested } = props;
    const openSavedEnvironment = (environmentId: string, projectSourceId: string | null | undefined, tab?: DeploymentEnvironmentTabV1) => {
      if (projectSourceId) onSaved(environmentId, { projectSourceId, ...(tab ? { tab } : {}) });
      else checkCreatedEnvironment();
    };
    // A retention choice belongs to the Machine it was made for.
    React.useEffect(() => {
      setRetention('alwaysOn');
      setFolderSelection(null);
    }, [chosen?.id]);
    // A prepared run carries the exact operands it was prepared from; any edit makes it stale.
    React.useEffect(() => {
      setPrepared(null);
      answerStepConfirmation(false);
    }, [answerStepConfirmation, projectSelection, name, chosen?.id, branch, composePath, composeDocument, imageName, imagePort, folderPath, folderEnvFiles, storedDefinition, domainChoices, templateChoices, production, deployerMode, deployerPrincipals, retention, onPlatform, copyChoices, platformProvider, provisionDrafts]);
    // A folder reads home-relative on its own Machine, as Open and the path browser show it.
    const folderLabel = (path: string) => formatPathRelativeToHome(path, chosen?.metadata?.homeDir ?? null);
    const pickFolder = async () => {
      if (!chosen || !props.lifetime) return;
      const machine = chosen.id;
      const path = await openMachinePathBrowserModal({ machineId: machine, serverId: props.lifetime.scope.serverId,
        title: t('newApp.deploy.folderChoose'), initialPath: folderPath ?? chosen.metadata?.homeDir ?? null,
        selectionMode: 'directory' });
      if (path) setFolderSelection({ machineId: machine, path });
    };
    const machineName = (machineId: string) => {
      const machine = (allMachines ?? []).find((entry) => entry.id === machineId);
      return machine ? getMachineDisplayName(machine, allMachines ?? []) : t('approvals.machineNotKnown');
    };

    // Save is explicit creation intent; the host prepares omitted defaults and
    // retains the exact operands. Create runs that retained invocation, never a second preparation.
    const save = async () => {
      if (stepReview) {
        answerStepConfirmation(true);
        return;
      }
      if (createOutcomeUnknown) {
        checkCreatedEnvironment();
        return;
      }
      if (partial) {
        if (recoveryEnvironmentId) openSavedEnvironment(recoveryEnvironmentId, recoveryProjectSourceId, deploymentPartialRecoveryTab(partial));
        return;
      }
      if (!valid || !actions || !chosen?.installationId || saving || !props.lifetime) return;
      setSaving(true);
      setRefusal(null);
      let createdEnvironment: SavedEnvironment | null = null;
      try {
        if (!prepared) {
          // A folder is opened on its Machine (Open's attach) only now, on the person's Save; the definition names it.
          const folderWorkspaceId = definitionKind === 'folder' && folderPath !== null
            ? await openDeploymentFolderWorkspace(props.lifetime, { machineId: chosen.id, path: folderPath }) : null;
          const next = await actions.prepareCreate({
            ...(projectSelection && 'newProject' in projectSelection ? { newProject: projectSelection.newProject }
              : projectSelection ? { projectSourceId: projectSelection.projectSourceId } : {}),
            name: name.trim(),
            ...(props.copyFrom && copyChoices ? { copyFrom: {
              environmentId: props.copyFrom.environment.id, expectedRevision: props.copyFrom.environment.revision,
              choices: { ...copyChoices, data: copyChoices.data.map(choice => choice.kind === 'createEmpty'
                ? { targetLinkId: choice.targetLinkId, kind: 'createEmpty' as const, provision: provisionDrafts[choice.targetLinkId]! } : choice) },
            } } : { definition: props.catalogApp ? { from: 'catalogApp', templateRef: props.catalogApp.templateRef }
              : definitionKind === 'image' ? {
              from: 'image', image: imageName.trim(), port: imagePortNumber,
            } : folderWorkspaceId !== null ? {
              from: 'folder', workspaceId: folderWorkspaceId, compose: { path: composePath.trim(), profiles: [], services: [] },
              ...(folderEnvFiles ? { includeEnvFiles: true as const } : {}),
            } : storedDefinition ? {
              from: 'compose', document: composeDocument, profiles: [], services: [],
            } : onPlatform ? { from: 'repository', ref: branch! } : {
              from: 'repository', ref: branch!,
              compose: { path: composePath.trim(), profiles: [], services: [] },
            } }),
            ...(domainChoices?.bindings.length ? { domainBindings: domainChoices.bindings } : {}),
            ...(templateChoices.bindings?.length ? { bindings: templateChoices.bindings } : {}),
            protection: production ? 'production' : 'nonProduction',
            purpose: 'standard',
            deployerMode,
            deployerPrincipals: [...deployerPrincipals],
            // A platform Environment still deploys from a Machine: the chosen one is its controller.
            ...(folderWorkspaceId !== null ? { controllerMachineId: chosen.id, buildMachineId: chosen.id } : {}),
            ...(onPlatform ? { controllerMachineId: chosen.id } : {
              firstTargetLink: { machines: [{ machineId: chosen.id, installationId: chosen.installationId }] },
              ...deploymentManagedRetention(retention),
            }),
          }, undefined, stepConfirm);
          setPrepared({ review: next.review, run: next.run });
          return;
        }
        const created = await prepared.run();
        if (!created.ok) {
          setRefusal({ kind: 'refused', reason: 'other', code: created.error });
          return;
        }
        createdEnvironment = { environmentId: created.environmentId, revision: created.revision, projectSourceId: created.projectSourceId ?? sourceId ?? undefined };
        if (platformTarget && platformProvider) {
          // An existing resource links as reviewed; Create new makes it now, through the editor's own create intent.
          const environment = { id: created.environmentId, revision: created.revision };
          const linkInput = platformProvider.kind === 'existing'
            ? buildPlatformTargetLinkInput({ target: platformTarget, environment, provider: platformProvider.provider })
            : await buildPlatformTargetCreateLinkInput({ serverId: props.lifetime.scope.serverId, target: platformTarget, environment,
              requestKey: platformProvider.requestKey, providerCreate: platformProvider.providerCreate });
          if (!linkInput) {
            setRefusal(refusedPlatformLink({ kind: 'refused', reason: 'other', code: 'invalid_parameters' }, createdEnvironment));
            return;
          }
          const linked = await actions.link(linkInput, { confirmed: true });
          if (!linked.ok) {
            const outcome = readDeploymentActionResult(linked);
            if (outcome.kind === 'refused') setRefusal(refusedPlatformLink(outcome, createdEnvironment));
            return;
          }
        }
        openSavedEnvironment(createdEnvironment.environmentId, createdEnvironment.projectSourceId);
      } catch (error) {
        // Declining the controller's review in this step is the person's answer, not a failure.
        if (isActionApprovalDeclinedErrorCode((error as { code?: unknown } | null)?.code)) return;
        const outcome = readDeploymentActionError(error);
        if (props.catalogApp && outcome.kind === 'refused' && outcome.code === 'template_variable_required') {
          setPrepared(null);
          setFormStep('configure');
        }
        if (outcome.kind === 'approval') {
          if (createdEnvironment) openSavedEnvironment(createdEnvironment.environmentId, createdEnvironment.projectSourceId, 'settings');
          onApprovalRequested(outcome.artifactId);
        }
        setRefusal(createdEnvironment && outcome.kind === 'refused' ? refusedPlatformLink(outcome, createdEnvironment) : outcome);
      } finally {
        setSaving(false);
      }
    };

    // Turning on a plugin happens in Plugins; a hosted flow steps aside first. A tile that goes there is an action
    // among the choices, never one of them (DESIGN-ACCEPT-2 M1, lab jdF-where).
    const openPlugins = () => {
        if (stepped) props.onDiscard();
        router.push(PLUGINS_APP_ROUTE);
    };
    const draftStep: DeploymentDraftStep = stepReview || prepared || partial || createOutcomeUnknown ? 'review' : formStep;
    const whereScope = props.lifetime?.scope;
    const ownServerWhere = stepped && draftStep === 'where' && !props.copyFrom;
    const catalogProvidesCompose = ownServerWhere && props.catalogApp != null;
    const generatesComposeFromImage = ownServerWhere && definitionKind === 'image' && !catalogProvidesCompose;
    // The repository's observed root Compose file speaks on Where (its tile) and on Configure (Ask an agent stands only
    // while there is none, PAGE-ACCEPT-176 R8-D7); one read serves both steps.
    const composeRepository = stepped && draftStep !== 'review' && !props.copyFrom && !storedDefinition
      && props.catalogApp == null && definitionKind !== 'image' && source?.repository ? source : null;
    const whereProjectRefs = useProjectAccountRows(rows => areServerAccountScopesEqual(rows?.scope, whereScope)
      ? readProjectAccountWorkspaceRefs({ projectAccountRows: rows }) : undefined, composeRepository !== null);
    const rootCompose = React.useMemo(() => {
      if (!composeRepository || !whereScope || !whereProjectRefs) return 'unknown';
      const facts = projectSourceRepositoryFacts(whereScope.serverId, [composeRepository], whereProjectRefs).get(composeRepository.id);
      return facts?.status === 'observed' ? facts.observation.rootFiles.compose : 'unknown';
    }, [composeRepository, whereScope, whereProjectRefs]);

    const targetTiles: Array<SelectionTile<string>> = [
      { id: OWN_SERVER_TARGET, icon: 'hard-drives', title: t('projects.deployments.platformLink.onMachine'),
        subtitle: t(catalogProvidesCompose ? 'newApp.deploy.whereCatalogCompose'
          : generatesComposeFromImage ? 'newApp.deploy.whereImageCompose'
          : ownServerWhere && rootCompose === 'absent' ? 'newApp.deploy.whereNoRootCompose'
          : 'projects.deployments.whereDescription') },
      ...offeredPlatformTargets.map((target): SelectionTile<string> => ({
        id: target.key, title: target.title, mark: <PluginMark title={target.title} pluginId={target.pluginId} />,
        ...(target.description ? { subtitle: target.description } : {}),
      })),
      ...(selectedPlatformUnavailable ? [{ id: targetKey,
        title: t('common.unavailable'), subtitle: recommendation.target.id, disabled: true } satisfies SelectionTile<string>] : []),
      // The tiles keep their place while the read answers; each other state says itself once, with its next step.
      ...(recommendation.evidence.includes('stored_definition') ? [] : platformStatus === 'loading'
        ? [{ id: LOADING_TILE, icon: 'cube', title: t('projects.deployments.platformLink.loading'), disabled: true } satisfies SelectionTile<string>]
        : platformStatus === 'failed'
          ? [{ id: RETRY_TILE, icon: 'cube', title: t('projects.deployments.platformLink.failed'), subtitle: t('common.retry') } satisfies SelectionTile<string>]
          : platformTargets.length === 0
            ? [{ id: PLUGINS_TILE, icon: 'cube', action: openPlugins, title: t('projects.deployments.platformLink.usePlatform'),
                subtitle: t('projects.deployments.platformLink.emptyBody') } satisfies SelectionTile<string>]
            : []),
    ];
    // Stepped (journey-deploy where): the targets read as cards. The recommended one carries its reason and badge,
    // and More platforms always closes the grid, also where a stored definition runs on a Machine only.
    const recommendedId = suggestion.evidence.length > 0 ? suggestion.target?.id ?? null : null;
    // A folder is no stored definition: the Machine card's own line says how it runs, with no second reason.
    const recommendationReason = recommendedId && definitionKind !== 'folder' ? deploymentRecommendationReason(suggestion) : null;
    // The recommended target (else the first one) leads the grid across its row (journey-deploy where, whereM); the
    // others keep two columns beneath. Choosing another target only moves the selection, never the grid.
    const choiceTiles = targetTiles.filter(tile => tile.id !== PLUGINS_TILE);
    const leadId = choiceTiles.some(tile => tile.id === recommendedId) ? recommendedId : choiceTiles[0]?.id ?? null;
    const stepTiles: Array<SelectionTile<string>> = stepped ? [
      ...[...choiceTiles.filter(tile => tile.id === leadId), ...choiceTiles.filter(tile => tile.id !== leadId)]
        .map((tile): SelectionTile<string> => ({
        ...tile,
        ...(tile.id === recommendedId ? { badge: t('newApp.deploy.recommended'),
          subtitle: [recommendationReason, tile.subtitle].filter(Boolean).join('\n') } : {}),
        ...(tile.id === leadId ? { span: 'row' as const } : {}),
      })),
      { id: PLUGINS_TILE, icon: 'plus', action: openPlugins, title: t('newApp.deploy.morePlatforms'), subtitle: t('newApp.deploy.morePlatformsBody') },
    ] : targetTiles;
    // A platform the definition can't use leaves the grid for one muted list with the one shared reason (whereM).
    const repositoryOnlyPlatforms = platformTargets.filter(target =>
      recommendation.corrections.some(correction => correction.targetId === target.key && correction.kind === 'prepare_repository'));
    // Several platforms share one reason, said for all of them (R14-D11).
    const repositoryOnlyReason = repositoryOnlyPlatforms.length === 0 ? undefined
      : deploymentActionRefusalRemedy(DEPLOYMENT_TARGET_REQUIRES_REPOSITORY_DEFINITION, definition, repositoryOnlyPlatforms.length);
    const chooseTarget = (next: string | null) => {
      if (next === null || next === LOADING_TILE) return;
      if (next === RETRY_TILE) { platforms.retry(); return; }
      setTargetKey(next);
    };

    const saveTitle = createOutcomeUnknown || recoveryEnvironmentId
        ? recoveryProjectSourceId && recoveryEnvironmentId ? t('projects.deployments.openEnvironment') : t('projects.deployments.createOutcomeCheck')
        : partial
        ? t('projects.deployments.openEnvironment')
        : props.copyFrom
        // On the review itself the primary says what it does, as Create does (PAGE-ACCEPT-176 R13-D8).
        ? stepReview || prepared ? t('projects.deployments.creationReview.createCopy') : t('newApp.deploy.review')
        : prepared
        ? t('projects.deployments.creationReview.create')
        : t('projects.deployments.saveEnvironment');
    const saveAction = {
      title: saveTitle,
      onPress: () => {
        void save();
      },
      disabled: stepReview ? false : createOutcomeUnknown ? saving : partial ? !partial.environmentId || saving : !valid || !actions || saving,
      loading: saving && !stepReview,
      testID: 'project-deployments.draft.save',
    };

    // Where continues only on a Machine that answers (whereErr): an away one says so in its tile instead.
    const whereReady = chosen !== null && answers(chosen) && platformDefinitionAccepted;
    // Every deploy, a platform's too, runs from an answering Machine; without one Where says so where Continue is.
    // A platform with no answering Machine at all says why and leads to adding one, in place of the footer's wait
    // line (PAGE-ACCEPT-176 R8-D6); a chosen away Machine keeps its own card's guide. Only a settled inventory can say
    // none answers: before the Home's first Machine list arrives the answer is unknown, not no.
    const platformNeedsMachine = draftStep === 'where' && onPlatform && platformDefinitionAccepted && allMachines != null
      && !machines.some(answers);
    const whereWaitingFor = draftStep === 'where' && platformDefinitionAccepted && !platformNeedsMachine
      && (chosen === null || !answers(chosen)) ? t('newApp.deploy.waitMachine') : null;
    // Configure's Review waits for what the person still has to fill, first empty field first, in the footer where Where's
    // wait is said (DESIGN-ACCEPT-3): an image draft's image and port, then the new Project's name.
    const imageDraft = definitionKind === 'image' && (props.copyFrom === undefined || props.copyFrom === null) && props.catalogApp == null;
    const configureWaitingFor = draftStep !== 'configure' ? null
      : imageDraft && imageName.trim().length === 0 ? t('newApp.deploy.configureNeeds.image')
      : imageDraft && !imagePortValid ? t('newApp.deploy.configureNeeds.port')
      : props.projectChoice && projectSelection == null ? t('newApp.deploy.configureNeeds.project')
      : onPlatform && platformProvider === null ? platformWaitingFor : null;
    const pressStep = useEventCallback(() => {
      if (draftStep !== 'where') { void save(); return; }
      if (!whereReady) return;
      setConfigureVisited(true);
      setFormStep('configure');
    });
    const backStep = useEventCallback(() => {
      if (draftStep === 'configure') { setFormStep('where'); return; }
      if (draftStep === 'where') { props.steps?.onExit(); return; }
      if (partial || createOutcomeUnknown) props.onDiscard();
      else if (stepReview) answerStepConfirmation(false);
      else setPrepared(null);
    });
    const toWhere = useEventCallback(() => {
      if (createOutcomeUnknown) { props.onDiscard(); return; }
      if (stepReview) answerStepConfirmation(false);
      setPrepared(null);
      setFormStep('where');
    });
    const primary = draftStep === 'where'
      ? { title: t('common.continue'), disabled: !whereReady, loading: false, testID: 'project-deployments.draft.continue' }
      : draftStep === 'configure'
        ? { title: t('newApp.deploy.review'), disabled: saveAction.disabled, loading: saveAction.loading, testID: 'project-deployments.draft.review' }
        : { title: saveAction.title, disabled: saveAction.disabled, loading: saveAction.loading, testID: saveAction.testID };
    const runsOnKind = onPlatform && platformTarget ? 'platform' : chosen ? 'machine' : null;
    const runsOnTitle = onPlatform && platformTarget ? platformTarget.title : chosen ? machineName(chosen.id) : null;
    // A saved Source carries no checkout path or Machine, so the summary names it by its name alone (journey-deploy:
    // "name ~/path on Machine" belongs to a local checkout, which this draft is not given).
    const sourceTitle = source ? source.name : props.catalogApp?.title ?? null;
    // A catalog app has no saved Source yet; the summary names the app and where it comes from (journey-deploy catWhere).
    // A repository Source says where its code lives (jdF-where's quiet note after the name); the name already says which.
    const sourceNote = !source && props.catalogApp ? t('newApp.deploy.catalogSourceNote')
      : source?.repository?.provider.displayName ?? null;
    const appName = source?.name ?? (projectSelection && 'newProject' in projectSelection ? projectSelection.newProject.name.trim() || null : null);
    const frame = React.useMemo((): DeploymentDraftFrame => ({
      step: draftStep,
      runsOn: runsOnKind ? { kind: runsOnKind, title: runsOnTitle } : null,
      waitingFor: whereWaitingFor ?? configureWaitingFor,
      source: sourceTitle ? { title: sourceTitle, note: sourceNote } : null,
      appName,
      refused: draftStep === 'review' && !partial && !createOutcomeUnknown && refusal?.kind === 'refused',
      primary: { title: primary.title, disabled: primary.disabled, loading: primary.loading, testID: primary.testID },
      press: pressStep, back: backStep, toWhere,
    }), [draftStep, runsOnKind, runsOnTitle, whereWaitingFor, configureWaitingFor, sourceTitle, sourceNote, appName, partial, createOutcomeUnknown, refusal, primary.title, primary.disabled,
      primary.loading, primary.testID, pressStep, backStep, toWhere]);
    const stepsHost = React.useRef(props.steps);
    stepsHost.current = props.steps;
    React.useEffect(() => { stepsHost.current?.onFrame(frame); }, [frame]);

    if (creatingMachine && props.lifetime) return <MachineCreationContinuation
      serverId={props.lifetime.scope.serverId} testID="project-deployments.draft.createMachine"
      draft={machineCreationDraft} onDraftChange={setMachineCreationDraft}
      onCancel={() => setCreatingMachine(false)}
      onArrived={({ machineId }) => { setMachineId(machineId); setCreatingMachine(false); }} />;

    const header = stepped ? null : (
          <PageHeader
            testID="project-deployments.draft.header"
            title={name.trim() || t('projects.deployments.newEnvironment')}
            alwaysShowTitle
            leading={
              // A copy carries the Environment's own mark; a new one starts from "+" (R11-D7).
              <PageHeaderMarkIcon name={props.copyFrom ? 'copy' : 'plus'} />
            }
            titleEditor={partial ? undefined : {
              value: name,
              // The rail's draft row reads the same until a name is typed (one name for one draft).
              placeholder: t('projects.deployments.newEnvironment'),
              accessibilityLabel: t('projects.deployments.name'),
              onChangeText: setName,
              onCommit: () => setName((current) => current.trim()),
            }}
            description={stepReview?.summary ?? t(partial ? 'projects.deployments.partialProgressBody' : props.copyFrom
              // Choose only where the copy offers a choice (PAGE-ACCEPT-176 R12-D6).
              ? copyChoices?.secrets.length || copyChoices?.data.length ? 'projects.deployments.copy.description' : 'projects.deployments.copy.descriptionNoChoice'
              : 'projects.deployments.draftDescription')}
            {...(props.phone ? {} : { primaryAction: saveAction })}
            cancelAction={partial ? {
              title: t('common.close'), onPress: props.onDiscard, testID: 'project-deployments.draft.close',
            } : prepared || stepReview ? {
              title: t('common.back'),
              onPress: backStep,
              disabled: saving && !stepReview,
              testID: 'project-deployments.draft.back',
            } : {
              title: t('common.discard'),
              onPress: props.onDiscard,
              testID: 'project-deployments.draft.discard',
            }}
          />
    );
    // Create saved the Environment, then the platform refused its resource (journey-deploy revFail after a partial
    // Create): the stepped Review keeps its plan and says what exists, row by row, instead of the generic progress list.
    const platformRefusal = stepped && prepared && onPlatform && platformTarget && partial?.phase === 'target'
      && refusal?.kind === 'refused' ? refusal : null;
    // Create and link-existing refusals are named by what was asked of the platform (taken name, already linked).
    const platformRefusalCopy = platformRefusal && platformTarget ? describeDeploymentPlatformRefusal({
      platform: platformTarget.title, resource: platformProvider?.kind === 'existing' ? 'existing' : 'create',
      code: platformRefusal.code, ...(platformRefusal.failure?.failureCause ? { cause: platformRefusal.failure.failureCause } : {}),
    }) : null;
    // The shared deployment failure presenter gives the reason (any refusal but a taken name) and the technical details.
    const platformOutcome = platformRefusal?.failure ? presentActionFailureOutcome(platformRefusal.failure, 'deployment') : null;
    const partialProgress = !createOutcomeUnknown && partial && refusal?.kind === 'refused' && refusal.failure && !platformRefusal
      ? <DeploymentPartialProgress testID="project-deployments.draft.progress" progress={partial} failure={refusal.failure} /> : null;
    // One notice per cause: a chosen Machine that stopped answering is said once, by its own notice, in place of the
    // target refusal and the setup failure that both come from it (journey-deploy revFail).
    const awayMachine = chosenPresence === 'offline' ? chosen : null;
    // The shared notice line (SurfaceStateCard size="line"), placed at the Machine it concerns.
    const machineAwayNotice = awayMachine ? (
      <SurfaceStateCard testID="project-deployments.draft.machineAwayNotice" kind="unavailable" size="line"
        title={machineName(awayMachine.id)} reason={t('errors.machineNotAnswering')} />
    ) : null;
    const draftRefusal = refusal?.kind === 'refused' ? refusal : null;
    const refusalRecovery = draftRefusal ? readDeploymentRefusalRecovery(draftRefusal.code,
      draftRefusal.failure?.details, draftRefusal.request, draftRefusal.failure?.failureCause?.errorCode) : null;
    // The recovery owner names where a refusal is fixed: a Machine cause, or the unavailable target, is that Machine.
    const machineCausedRefusal = awayMachine !== null && draftRefusal !== null && (draftRefusal.code === 'target_unavailable'
      || refusalRecovery?.nextAction.destination === 'machines');
    const refusalBanner = createOutcomeUnknown ? (
      <AttentionBanner testID="project-deployments.draft.outcome-unknown" tone="neutral"
        title={t(recoveryEnvironmentId ? 'projects.deployments.createResultUnknownTitle' : 'projects.deployments.createOutcomeUnknownTitle')}
        description={t('projects.deployments.createOutcomeUnknownBody')}
        details={[t('projects.deployments.createOutcomeUnknownDetails')]} />
    ) : machineCausedRefusal ? null
      : refusal && refusal.kind === 'approval' ? (
            <AttentionBanner
              testID="project-deployments.draft.approval"
              tone="neutral"
              title={t('projects.deployments.createApprovalTitle')}
              description={t('projects.deployments.createApprovalBody')}
            />
          ) : platformRefusal?.code === 'needsGitAccess' ? (
            <DeploymentPlatformInspectState outcome={null} refusal={{ code: platformRefusal.code, details: platformRefusal.failure?.details }} />
          ) : platformRefusal && platformRefusalCopy ? (
            <AttentionBanner
              testID="project-deployments.draft.refused"
              tone="danger"
              title={platformRefusalCopy.title}
              description={platformRefusalCopy.specific ? platformRefusalCopy.description
                : platformOutcome?.reason ?? platformRefusalCopy.description}
              details={platformOutcome ? platformOutcome.technicalDetails.map(line => `${line.label}: ${line.value}`) : [platformRefusal.code]}
            />
          ) : refusal && refusal.kind === 'refused' ? (
            <AttentionBanner
              testID="project-deployments.draft.refused"
              tone="danger"
              title={t('projects.deployments.createFailedTitle')}
              description={refusedVariableKey
                ? t('session.actionsDraft.validation.requiredField', { field: refusedVariableKey })
                : refusalRecovery?.remedy ?? deploymentActionRefusalRemedy(refusal.code, definition)}
              details={[refusal.code]}
            />
          ) : null;
    // Stepped, the review reads as groups (journey-deploy rev, revM) from the operands the prepared review was made
    // from; any edit drops it, so they stay what was reviewed.
    const reviewPlan: DeploymentCreationReviewPlan | null = stepped && prepared && chosen ? {
      newProjectName: projectSelection && 'newProject' in projectSelection ? projectSelection.newProject.name.trim() || null : null,
      environment: { name: name.trim(), production, deployers: deployerMode },
      runs: props.copyFrom ? null : props.catalogApp ? { kind: 'app', name: props.catalogApp.title }
        : definitionKind === 'image' ? { kind: 'image', image: imageName.trim() }
        : definitionKind === 'folder' && folderPath !== null ? { kind: 'folder', folder: folderLabel(folderPath) }
        : storedDefinition ? { kind: 'compose' } : branch ? { kind: 'repository', ref: branch } : null,
      runsOn: onPlatform && platformTarget ? { kind: 'platform', platform: platformTarget.title, pluginId: platformTarget.pluginId,
        machine: machineName(chosen.id), machineId: chosen.id, resource: platformProvider?.kind === 'existing' ? 'existing' : 'create',
        resourceName: readPreparedPlatformResourceName(platformProvider, platformTarget.title) }
        : { kind: 'machine', machine: machineName(chosen.id), machineId: chosen.id },
      answered: refusal !== null,
      refused: refusal?.kind === 'refused' && !platformRefusal,
      ...(platformRefusalCopy ? { platformRefused: { status: platformRefusalCopy.row } } : {}),
    } : null;
    // The account this platform acts through, once Configure has named it: Review says which of its plans it is on.
    const platformAccount = onPlatform ? readPreparedPlatformAccount(platformProvider) : null;
    const reviewFacts = stepReview ? (
            <ActionConfirmationReviewFacts actionId={stepReview.actionId} actionArgs={stepReview.actionArgs}
              summaryPlacement="host"
              preview={stepReview.preview} serverId={props.lifetime?.scope.serverId ?? null}
              testID="project-deployments.draft.confirmation" />
          ) : prepared ? (
            <DeploymentCreationReviewFacts review={prepared.review} serverId={props.lifetime?.scope.serverId ?? null}
              testID="project-deployments.draft" plan={reviewPlan ?? undefined}
              // The chosen platform's declared plans, as its Where card showed them (deploy auto-mode U3).
              cost={onPlatform && platformTarget?.plans?.length ? (platformAccount
                ? <DeploymentTargetPlansForAccount account={platformAccount} plans={platformTarget.plans} platform={platformTarget.title}
                  columns={!props.phone} phone={props.phone} testID="project-deployments.draft.cost.plans" />
                : <DeploymentTargetPlans plans={platformTarget.plans} platform={platformTarget.title} columns={!props.phone}
                  phone={props.phone} testID="project-deployments.draft.cost.plans" />)
                : reviewPlan?.runsOn.kind === 'machine'
                  ? <DeploymentOwnMachineCost machine={reviewPlan.runsOn.machine} testID="project-deployments.draft.cost.ownMachine" />
                  : undefined} />
          ) : null;
    // What making this platform resource means, in the platform's own words (deploy auto-mode U8, e.g. a Pages source
    // is final at creation): one field from its inspect, shown before Create.
    const platformNotice = prepared && onPlatform && platformProvider?.reviewNotice ? (
      <AttentionBanner testID="project-deployments.draft.reviewNotice" tone="neutral" title={platformProvider.reviewNotice} />
    ) : null;
    // What a create upload builds with: the runtime as name and version, its pin short beside the build tool
    // (PAGE-ACCEPT-176 R9-D5). The platform supplies it only for builds Happier runs, never Git integration.
    const reviewRuntime = prepared && onPlatform && platformProvider?.kind === 'create' ? platformProvider.reviewRuntime ?? null : null;
    const platformRuntime = reviewRuntime ? (
      <ItemGroup testID="project-deployments.draft.reviewRuntime" header="none">
        {/* How it deploys already names the Machine it builds on; this row says with what. */}
        <Item mode="info" title={t('projects.deployments.platformLink.buildImage')}
          detail={`${reviewRuntime.name} ${reviewRuntime.version}`}
          subtitle={`${reviewRuntime.tool} ${reviewRuntime.toolVersion} · ${reviewRuntime.pin}`} />
      </ItemGroup>
    ) : null;
    // What Happier creates leads; the build runtime is a developer detail after it (PAGE-ACCEPT-176 R10-D7).
    const reviewBody = createOutcomeUnknown ? null : platformNotice || platformRuntime ? <>{platformNotice}{reviewFacts}{platformRuntime}</> : reviewFacts;
    const projectChoiceGroups = props.projectChoice ? <DeploymentProjectChoiceGroups model={props.projectChoice}
            testIDPrefix="project-deployments.draft.project"
            description={t('capabilities.store.appPage.projectDescription')}
            newProjectHint={t('capabilities.store.appPage.projectNewHint')} /> : null;
    const retentionChoice = onPlatform ? null : (
              <DeploymentRetentionChoice
                testID="project-deployments.draft.retention"
                serverId={props.lifetime?.scope.serverId ?? null}
                machineId={chosen?.id ?? null}
                value={retention}
                onChange={setRetention}
              />
            );
    const machineEmpty = machines.length === 0 && machineId === null ? (
      <DeploymentMachinesEmpty serverId={props.lifetime?.scope.serverId ?? ''} testID="project-deployments.draft" empty={
        <Item testID="project-deployments.draft.noMachine.create" title={t('managedMachines.add.createPath')}
          subtitle={t('projects.deployments.noMachineBody')} onPress={() => setCreatingMachine(true)} disabled={!props.lifetime} />} />
    ) : null;
    const soleTarget = props.platformAvailable && targetTiles.length === 1 && targetTiles[0]?.id === OWN_SERVER_TARGET
      ? targetTiles[0] : null;
    const controllerField = machineEmpty ?? (
      <SessionMachineField
        testID="project-deployments.draft.machine"
        serverId={props.lifetime?.scope.serverId ?? ''}
        machines={machines}
        machineId={machineId ?? chosen?.id ?? null}
        machineName={t('approvals.machineNotKnown')}
        title={t(onPlatform ? 'projects.deployments.platformLink.deploysFrom' : 'projects.deployments.machine')}
        // On a platform, the Machine's part needs saying: it runs the platform's deploys for this Environment (R14-D11).
        {...(onPlatform ? { subtitle: t('projects.deployments.platformLink.deploysFromBody') }
          : soleTarget?.subtitle ? { subtitle: soleTarget.subtitle } : {})}
        awayMachinesChoosable={!stepped}
        onSelectMachine={(machine) => setMachineId(machine.id)}
      />
    );
    const whereGroup = <>
          <ItemGroup
            // Stepped, the host's step description asks the question; the group keeps the recommendation's reason.
            title={stepped ? undefined : t('projects.deployments.whereTitle')}
            description={deploymentRecommendationDescription(recommendation)}
          >
            {/* One possible target is no choice: the Machine field carries its line instead of a lone radio (R13-D8). */}
            {props.platformAvailable && !soleTarget ? (
              <SelectionTiles<string>
                accessibilityLabel={t('projects.deployments.whereTitle')}
                testIdPrefix="project-deployments.draft.target"
                surface="sheet"
                options={targetTiles}
                value={targetKey}
                onChange={chooseTarget}
                minimumColumns={1}
                maximumColumns={props.phone ? 1 : targetTileColumns(targetTiles.length)}
              />
            ) : null}
            {controllerField}
            {/* Stepped, how long it keeps running is one of More settings (journey-deploy cfgM). */}
            {stepped ? null : machineAwayNotice}
            {stepped ? null : retentionChoice}
          </ItemGroup>
          {/* On the page column like every other section, not across the whole pane (PAGE-ACCEPT-176 round 14). */}
          {/* Only for a platform that is chosen: a refusal of an option the page doesn't draw is a stray line (R11-D7). */}
          {selectedPlatformUnavailable ? <ItemGroup header="none" surface="none">
            <SurfaceStateCard kind="unavailable" size="line" title={t('common.unavailable')} reason={repositoryOnlyReason} />
          </ItemGroup> : null}
    </>;
    const machineAway = chosenPresence === 'offline';
    // The Machine choice lives in the Machine card (whereM): its picker with the presence owner's line, and when that
    // Machine is away, the one next step on its own line.
    // Until the Machine list has answered, the field holds its place; "no Machine" is said only once it is known.
    // An unchosen Machine card reads its Machine's facts; only the chosen card carries the Machine select, so a radio
    // card that isn't chosen never holds a second live control (lab stWhere / where round 3 #2, DESIGN-ACCEPT W3).
    const machineStatus = !chosen ? null : host.readiness === 'ready' ? t('newApp.deploy.readyToHost')
      : chosenPresence === 'unknown' ? t('common.loading')
      : describeMachinePresenceLine(chosen, presenceNowMs, undefined, null,
        chosenPresence === 'online' ? 'reachable' : 'unreachable').label;
    const machineFacts = chosen ? (
      <View style={[styles.machineCard, { borderTopWidth: resolveThemeHairlineBorderStyle(theme.colors.border.subtle).borderWidth,
        borderTopColor: theme.colors.border.subtle }]}>
        <ItemGroup surface="none" header="none">
          <BareSectionContent>
            <MachineCardFactRows serverId={props.lifetime?.scope.serverId ?? null} machineId={chosen.id}
              machine={machineName(chosen.id)} status={machineStatus} />
          </BareSectionContent>
        </ItemGroup>
      </View>
    ) : null;
    const machineCard = machineEmpty ?? (
      <View style={[styles.machineCard, { borderTopWidth: resolveThemeHairlineBorderStyle(theme.colors.border.subtle).borderWidth,
        borderTopColor: theme.colors.border.subtle }]}>
        {/* A bare section under the card's hairline (jdF-whereM), with no section spacer of its own. */}
        <ItemGroup surface="none" header="none">
        <SessionMachineField
          testID="project-deployments.draft.machine"
          serverId={props.lifetime?.scope.serverId ?? ''}
          machines={machines}
          machineId={machineId ?? chosen?.id ?? null}
          machineName={t('approvals.machineNotKnown')}
          // The Machine card stays the Machine's card when a platform is chosen; which Machine a platform deploys from is
          // Configure's (journey-deploy stWhere).
          title={t('projects.deployments.machine')}
          /* An answering Machine whose Docker setup the Plan reports satisfied says it is ready to host (whereM). */
          {...(machineStatus ? { subtitle: machineStatus } : {})}
          awayMachinesChoosable
          showDivider={false}
          onSelectMachine={(machine) => setMachineId(machine.id)}
        />
        {chosen && props.lifetime ? <MachineCardFacts serverId={props.lifetime.scope.serverId} machineId={chosen.id} /> : null}
        {machineAway ? (
          <BareSectionContent>
            <Text testID="project-deployments.draft.machineAway" variant="meta" style={{ color: theme.colors.text.secondary }}>
              {t('newApp.deploy.machineOfflineGuide')}
            </Text>
          </BareSectionContent>
        ) : null}
        </ItemGroup>
      </View>
    );
    const stepWhere = stepped ? <>
          <ItemGroup surface="none">
            <BareSectionContent>
            <SelectionTiles<string>
              accessibilityLabel={t('projects.deployments.whereTitle')}
              testIdPrefix="project-deployments.draft.target"
              options={stepTiles}
              value={targetKey}
              onChange={chooseTarget}
              minimumColumns={1}
              maximumColumns={props.phone ? 1 : 2}
              descriptionPlacement="below"
              // Each card carries its own facts (journey-deploy where): the Machine card stays with A machine, and a
              // platform shows its declared plans; which Machine a platform deploys from is Configure's (On <platform>).
              renderOptionFooter={({ option, selected }) => {
                const plans = option.id === OWN_SERVER_TARGET ? undefined
                  : offeredPlatformTargets.find(target => target.key === option.id)?.plans;
                const body = option.id === OWN_SERVER_TARGET ? selected ? machineCard : machineFacts ?? machineCard
                  : plans ? <DeploymentTargetPlans plans={plans} platform={option.title} columns={!props.phone && option.id === leadId}
                    phone={props.phone} testID={`project-deployments.draft.target:${option.id}`} /> : null;
                return body ? <View testID={`project-deployments.draft.target:${option.id}:footer`}>{body}</View> : null;
              }}
            />
            </BareSectionContent>
          </ItemGroup>
          {platformNeedsMachine && platformTarget ? (
            <SurfaceStateCard testID="project-deployments.draft.platformNeedsMachine" size="line" kind="unavailable"
              title={t('newApp.deploy.platformNeedsMachine', { platform: platformTarget.title })}
              action={{ label: t('newApp.auto.addMachine'), onPress: () => setCreatingMachine(true),
                testID: 'project-deployments.draft.platformNeedsMachine.add', disabled: !props.lifetime }} />
          ) : null}
          {repositoryOnlyReason ? (
            <ItemGroup testID="project-deployments.draft.cantRun"
              title={sourceTitle || appName ? t('newApp.deploy.cantRun', { name: appName ?? sourceTitle ?? '' }) : t('newApp.deploy.cantRunUnnamed')}
              titleRole="label" description={repositoryOnlyReason}>
              {repositoryOnlyPlatforms.map(target => <Item key={target.key} mode="info" dimmed showChevron={false} title={target.title}
                icon={<PluginMark title={target.title} pluginId={target.pluginId} />} />)}
            </ItemGroup>
          ) : null}
    </> : null;
    const configureGroups = <>
          {stepped && onPlatform && platformDefinitionAccepted ? <ItemGroup>{controllerField}</ItemGroup> : null}
          {platformTarget && platformDefinitionAccepted && platformEnvironment && props.lifetime && actions ? (
            <DeploymentPlatformTargetEditor key={`${platformTarget.key}:${chosen?.id ?? ''}:${source?.revision ?? ''}`}
              name={name} environment={platformEnvironment} ownerAccountId={props.lifetime.scope.accountId}
              lifetime={props.lifetime} actions={actions}
              initialTargetKey={platformTarget.key} onPrepared={setPlatformProvider}
              onWaitingForChange={stepped ? setPlatformWaitingFor : undefined}
              onApproval={onApprovalRequested} onClose={props.onDiscard} />
          ) : null}
          {/* Unknown readiness opens the Machine setup owner; a confirmed setup need can review its recipe here.
              A Machine that is not answering is unknown because of that cause, which its own notice already says. */}
          {!onPlatform && chosen && ((host.setup && !host.prepared) || (!host.setup && host.readiness === 'unknown' && !awayMachine)) ? (
            <AttentionBanner
              testID={host.readiness === 'needsSetup' ? 'project-deployments.draft.hostNeedsSetup' : 'project-deployments.draft.hostUnchecked'}
              tone="warning"
              title={t(host.readiness === 'needsSetup' ? 'projects.deployments.platformLink.hostNeedsSetup'
                : 'projects.deployments.platformLink.hostUnchecked')}
              // Unknown readiness says what Review setup does, on which Machine (DESIGN-ACCEPT C5: status is not
              // guidance); a confirmed setup need keeps the review reassurance.
              description={host.readiness === 'needsSetup' ? t('projects.deployments.platformLink.hostSetupBody')
                : resolveActionExecutionFailureMessage(host.prepared,
                    t('projects.deployments.platformLink.hostUncheckedBody', { machine: machineName(chosen.id) }),
                    { closedCodesOnly: true }) ?? undefined}
              // The Machine field above names it, so the title says "this Machine"; the way forward stays quiet beside the
              // footer's one primary (R2-D5).
              action={{ label: t('projects.deployments.platformLink.hostReviewShort'),
                onPress: () => {
                  if (host.setup) void host.review();
                  else if (props.lifetime) router.pushRetainingCurrent(machinePageHref({ door: 'rail',
                    target: { machineId: chosen.id, serverId: props.lifetime.scope.serverId }, tab: { id: 'setup' } }));
                }, loading: host.reviewing,
                disabled: hostApply.pending || (host.setup ? !host.canReview : !props.lifetime),
                display: 'secondary', testID: 'project-deployments.draft.hostSetup.prepare' }}
            />
          ) : null}
          {!onPlatform && host.setup ? <MachineSetupRecipeInputs setup={host.setup} projection={host.inputProjection}
            scope={props.lifetime?.scope} onChange={host.setSetup} testID="project-deployments.draft.hostSetup.inputs" /> : null}
          {!onPlatform && chosen && host.prepared?.ok && host.readiness !== 'ready' ? <>
            <AttentionBanner
              testID="project-deployments.draft.hostSetup"
              tone="warning"
              title={t('projects.deployments.platformLink.hostNeedsSetup')}
              description={t('projects.deployments.platformLink.hostSetupBody')}
              {...(hostApply.error ? { details: [hostApply.error] } : {})}
              action={{ label: t('projects.deployments.platformLink.hostSetupAction', { machine: machineName(chosen.id) }),
                onPress: () => { void applyHostSetup(); }, loading: hostApply.pending,
                disabled: hostApply.pending || describeMachineSetupReviewUnavailable(host.prepared, machineName) !== undefined,
                display: 'secondary', testID: 'project-deployments.draft.hostSetup.apply' }}
            />
            <MachineSetupPlanReview testID="project-deployments.draft.hostSetup.review" prepared={host.prepared}
              nameOf={machineName} disabled={hostApply.pending} />
          </> : !onPlatform && host.setup && host.prepared?.ok === false ? awayMachine ? null : (
            <AttentionBanner testID="project-deployments.draft.hostSetup.failed" tone="warning" title={t('machinePresets.setup.title')}
              description={describeMachineSetupPlanFailure(host.prepared, machineName)} />
          ) : null}
          {/* A one-service catalog app adds nothing here the summary doesn't say (its name is the Source): the section
              stands only when it carries the app's addresses (DESIGN-ACCEPT C6, lab catCfg). */}
          {catalogDomains?.length === 0 ? null : <ItemGroup
            title={t('projects.deployments.whatRunsTitle')}
            description={props.copyFrom || storedDefinition || props.catalogApp ? undefined : onPlatform
              ? t('projects.deployments.platformLink.platformBuilds')
              : t('projects.deployments.whatRunsDescription')}
          >
            {/* What the copy runs, named for itself, not the section's title again (PAGE-ACCEPT-176 R11-D7). */}
            {props.copyFrom ? <Item title={deploymentDefinitionLabel(props.copyFrom.content) ?? t('projects.deployments.composeFile')}
              subtitle={props.copyFrom.content.name} mode="info" /> : catalogDomains ? (
                <DeploymentTemplateDomainRows domains={catalogDomains} testIDPrefix="project-deployments.draft.domain"
                  hostname={key => domainHostnames[key] ?? ''} invalidKeys={domainChoices?.invalidKeys} focusKey={refusedDomainKey}
                  onChangeHostname={(key, hostname) => {
                    setDomainHostnames(current => ({ ...current, [key]: hostname }));
                    if (key === refusedDomainKey) setRefusal(null);
                  }} />
              ) : definitionKind === 'image' ? <>
              {/* Each field says what it takes, as the source tile and journey-deploy imgCfg do (DESIGN-ACCEPT-3). */}
              <Item title={t('managedMachines.config.image')} subtitle={t('newApp.builtImageSubtitle')}
                accessoryLayout={stepped ? 'adaptive' : 'stacked'} showChevron={false}
                rightElement={<FieldTextInput testID="project-deployments.draft.imageName"
                  accessibilityLabel={t('managedMachines.config.image')} value={imageName}
                  onChangeText={setImageName} monospace autoCapitalize="none" autoComplete="off" />}
              />
              <Item title={t('projects.deployments.domainFieldPort')} subtitle={t('newApp.deploy.imagePortDescription')}
                accessoryLayout={stepped ? 'adaptive' : 'stacked'} showChevron={false}
                rightElement={<FieldTextInput testID="project-deployments.draft.imagePort"
                  accessibilityLabel={t('projects.deployments.domainFieldPort')} value={imagePort}
                  onChangeText={setImagePort} monospace autoCapitalize="none" autoComplete="off" />}
              />
            </> : definitionKind === 'folder' ? <>
              {/* The folder is a destination on the chosen Machine: its value and a chevron, its browser one press away. */}
              <Item testID="project-deployments.draft.folder" title={t('newApp.deploy.folder')}
                detail={folderPath !== null ? folderLabel(folderPath) : t('newApp.deploy.folderChoose')}
                disabled={chosen === null} onPress={() => { void pickFolder(); }} />
              <FieldValueItem
                testID="project-deployments.draft.compose"
                title={t('projects.deployments.composeFile')}
                value={composePath}
                placeholder={DEFAULT_COMPOSE_PATH}
                monospace
                autoCapitalize="none"
                autoComplete="off"
                onCommit={(text) => {
                  setComposePath(text.trim());
                  return text.trim();
                }}
              />
              <Item title={t('newApp.deploy.folderEnvFiles')}
                subtitle={t(folderEnvFiles ? 'newApp.deploy.folderEnvFilesOn' : 'newApp.deploy.folderEnvFilesOff')}
                rightElement={<Switch testID="project-deployments.draft.folderEnvFiles" value={folderEnvFiles} onValueChange={setFolderEnvFiles} />}
                onPress={() => setFolderEnvFiles(current => !current)} showChevron={false} />
            </> : storedDefinition ? (
              <Item title={t('projects.deployments.composeFile')} accessoryLayout="stacked" showChevron={false}
                rightElement={<FieldTextInput testID="project-deployments.draft.composeDocument"
                  accessibilityLabel={t('projects.deployments.composeFile')} value={composeDocument}
                  onChangeText={setComposeDocument} multiline growWithText monospace autoCapitalize="none" autoComplete="off" />}
              />
            ) : <>
            {onPlatform ? null : <FieldValueItem
              testID="project-deployments.draft.compose"
              title={t('projects.deployments.composeFile')}
              value={composePath}
              placeholder={DEFAULT_COMPOSE_PATH}
              monospace
              autoCapitalize="none"
              autoComplete="off"
              onCommit={(text) => {
                setComposePath(text.trim());
                return text.trim();
              }}
            />}
            <ProjectRefSelect
              testID="project-deployments.draft.ref"
              title={t('projects.deployments.branch')}
              value={ref}
              defaultLabel={
                defaultBranch
                  ? t('projects.deployments.branchDefault', { ref: defaultBranch })
                  : t('projects.deployments.branchChoose')
              }
              defaultIsPrompt={!defaultBranch}
              compact={props.phone}
              onChange={setRef}
            />
            {/* The agent entries are one row of What runs: its title says what they do, the two entries are its buttons,
                beneath it on a phone (DESIGN-ACCEPT-2 C7: they were two centred sparkle links under Branch). */}
            {/* It says what gets set up and stands only while the repository has no Compose file it can see; Prepare is
                its action, Import a quiet second (PAGE-ACCEPT-176 R8-D7). */}
            {!onPlatform && props.lifetime && source?.repository && rootCompose !== 'present' ? (
              <Item testID="project-deployments.draft.agent" title={t('projects.deployments.preparation.askAgent')}
                subtitle={t('projects.deployments.preparation.askAgentBody')} subtitleLines={0}
                showChevron={false} accessoryLayout={props.phone ? 'stacked' : 'adaptive'}
                rightElement={<View style={styles.agentEntries}>
                  <DeploymentPreparationEntry lifetime={props.lifetime} projectSourceId={source.id} mode="prepare" emphasis="secondary" />
                  <DeploymentPreparationEntry lifetime={props.lifetime} projectSourceId={source.id} mode="import" emphasis="plain" />
                </View>} />
            ) : null}
            </>}
          </ItemGroup>}
          {catalogTemplate && props.lifetime ? (
            <DeploymentTemplateChoices template={catalogTemplate} lifetime={props.lifetime} mode="create"
              value={templateChoices} onChange={choices => {
                setTemplateChoices(choices);
                if (refusedVariableKey) setRefusal(null);
              }}
              testID="project-deployments.draft.catalogChoices" refusedVariableKey={refusedVariableKey} />
          ) : null}
          {props.copyFrom && copyChoices ? (
            <ItemGroup title={t('projects.deployments.copy.bindings')} description={t('projects.deployments.copy.domainsStay')}>
              {copyChoices.secrets.map((choice, index) => {
                const identity = choice.binding;
                if (identity.purpose !== 'variable' && identity.purpose !== 'registry') return null;
                const title = identity.purpose === 'variable' ? identity.name : identity.registryOrigin;
                return <SegmentedChoiceItem<SecretCopyChoice> key={`secret:${index}`} title={title}
                  testIDPrefix={`project-deployments.draft.copy.secret:${index}`}
                  value={choice.kind === 'rebind' ? 'choose' : choice.kind}
                  options={[
                    { id: 'useSameReference', label: t('projects.deployments.copy.same') },
                    { id: 'choose', label: t('projects.deployments.copy.choose'), disabled: !props.lifetime },
                    { id: 'omit', label: t('projects.deployments.copy.omit') },
                  ]}
                  onChange={next => {
                    if (next !== 'choose') {
                      setCopyChoices(current => current ? { ...current, secrets: current.secrets.map((row, i) => i === index
                        ? { binding: row.binding, kind: next } : row),
                        data: next === 'omit' ? current.data.map(row => row.kind === 'reuse'
                          ? { ...row, bindings: row.bindings?.filter(binding => environmentSecretBindingIdentityV1(binding) !== environmentSecretBindingIdentityV1(identity)) } : row) : current.data,
                      } : current);
                      return;
                    }
                    if (!props.lifetime) return;
                    // Choose another opens the one Saved Secret picker; dismissing it keeps the previous choice.
                    const lifetime = props.lifetime;
                    void presentSavedSecretReferencePicker({ accountLifetime: lifetime, signal: new AbortController().signal,
                      ...(choice.kind === 'rebind' ? { selected: { ref: choice.source.ref,
                        resourceRevision: choice.source.resourceRevision } } : {}),
                      isCurrent: lifetime.isCurrent }).then(selected => {
                      if (!selected) return;
                      setCopyChoices(current => current ? { ...current, secrets: current.secrets.map((row, i) => i === index
                        ? { binding: row.binding, kind: 'rebind', source: { kind: 'secret', ref: selected.ref,
                          resourceRevision: selected.resourceRevision } } : row) } : current);
                    });
                  }} />;
              })}
              {copyChoices.values.map((choice, index) => <Item key={`value:${index}`}
                title={choice.binding.purpose === 'variable' ? choice.binding.name : choice.binding.purpose}
                showChevron={false} subtitle={t('projects.deployments.copy.include')}
                rightElement={<Switch value={choice.kind !== 'omit'} onValueChange={include => setCopyChoices(current => current
                  ? { ...current, values: current.values.map((row, i) => i === index
                    ? { binding: row.binding, kind: include ? 'include' : 'omit' } : row) } : current)} />} />)}
            </ItemGroup>
          ) : null}
          {props.copyFrom && copyChoices && copyChoices.data.length > 0 ? (
            <ItemGroup title={t('projects.deployments.copy.dataTitle')}>
              {copyChoices.data.map((choice, index) => {
                const link = props.copyFrom?.targetLinks.find(row => row.targetLink.id === choice.targetLinkId);
                return <React.Fragment key={choice.targetLinkId}><SegmentedChoiceItem<DataCopyChoice>
                  title={link?.targetLink.targetKind ?? choice.targetLinkId}
                  testIDPrefix={`project-deployments.draft.copy.data:${index}`}
                  value={choice.kind}
                  options={DATA_COPY_OPTIONS()}
                  onChange={next => {
                    setProvisionDrafts(current => ({ ...current, [choice.targetLinkId]: null }));
                    setCopyChoices(current => current ? { ...current, data: current.data.map((row, i) => i === index
                      ? { targetLinkId: row.targetLinkId, kind: next } : row) } : current);
                  }} />
                  {choice.kind === 'createEmpty' && link?.targetLink.source.kind === 'plugin' && props.lifetime ?
                    <DeploymentCopyProvisionEditor targetLinkId={choice.targetLinkId} contribution={link.targetLink.source.contribution}
                      lifetime={props.lifetime} disabled={saving} onChange={onProvisionDraftChange} /> : null}
                  {choice.kind === 'reuse' ? <ItemGroup title={t('projects.deployments.copy.dataConnections')}
                    description={t('projects.deployments.copy.dataConnectionsHint')}>
                    {reusableBindings.length === 0 ? <SurfaceStateCard size="line" kind="unavailable"
                      title={t('common.unavailable')} reason={t('projects.deployments.copy.dataConnectionsUnavailable')} /> : null}
                    {reusableBindings.map(binding => {
                      if (binding.purpose !== 'variable') return null;
                      const identity = environmentSecretBindingIdentityV1(binding);
                      const selected = choice.bindings?.some(row => environmentSecretBindingIdentityV1(row) === identity) ?? false;
                      return <Item key={identity} title={binding.name} showChevron={false}
                        rightElement={<Switch testID={`project-deployments.draft.copy.data:${index}:binding:${binding.phase}:${binding.name}`}
                          disabled={saving} value={selected} onValueChange={include => setCopyChoices(current => current ? {
                            ...current, data: current.data.map(row => row.targetLinkId === choice.targetLinkId && row.kind === 'reuse'
                              ? { ...row, bindings: include ? [...row.bindings ?? [], binding]
                                : (row.bindings ?? []).filter(entry => environmentSecretBindingIdentityV1(entry) !== identity) } : row),
                          } : current)} />} />;
                    })}
                  </ItemGroup> : null}
                </React.Fragment>;
              })}
            </ItemGroup>
          ) : null}
    </>;
    const deployerGroups = <>
          <ItemGroup
            title={t('projects.deployments.whoMayDeploy')}
            description={t('projects.deployments.whoMayDeployDescription')}
          >
            <DeploymentDeployerFields mode={deployerMode} principals={deployerPrincipals}
              scope={props.lifetime?.scope ?? null} lifetime={props.lifetime} source={source}
              owner={projectSelection && 'newProject' in projectSelection ? projectSelection.newProject.owner : undefined} editable disabled={saving}
              onModeChange={setDeployerMode} onChangePrincipals={setDeployerPrincipals} />
          </ItemGroup>
          <ItemGroup>
            <Item
              testID="project-deployments.draft.production"
              title={t(onPlatform ? 'newApp.deploy.protectEnvironment' : 'projects.deployments.production')}
              subtitle={t(onPlatform ? 'newApp.deploy.protectEnvironmentHint' : 'projects.deployments.productionHint')}
              rightElement={
                <Switch value={production} disabled={props.createProduction} onValueChange={setProduction} />
              }
              onPress={props.createProduction ? undefined : () => setProduction((current) => !current)}
              showChevron={false}
            />
          </ItemGroup>
    </>;

    if (stepped) {
      // One instance for every step: a visited step stays mounted while another shows, so its choices (the platform
      // editor's resource, a typed document) are there when the person comes back.
      return (
        <View testID="project-deployments.draft">
          <View style={draftStep === 'where' ? null : styles.hiddenStep}>{stepWhere}</View>
          {!configureVisited ? null : (
            <View style={draftStep === 'configure' ? null : styles.hiddenStep}>
              {machineAwayNotice}
              {refusalBanner}
              {/* What runs leads Configure; the Project it is listed under follows it (journey-deploy imgCfg). */}
              {configureGroups}
              {projectChoiceGroups}
              {moreOpen ? <>
                <ItemGroup title={t('newApp.deploy.moreSettings')}>
                  <Item testID="project-deployments.draft.name" title={t('projects.deployments.name')} accessoryLayout="adaptive"
                    showChevron={false} rightElement={<FieldTextInput testID="project-deployments.draft.nameField"
                      accessibilityLabel={t('projects.deployments.name')} value={name} onChangeText={setName}
                      placeholder={t('projects.deployments.newEnvironment')} />} />
                  {retentionChoice}
                </ItemGroup>
                {deployerGroups}
              </> : (
                <ItemGroup>
                  <Item testID="project-deployments.draft.more" title={t('newApp.deploy.moreSettings')}
                    subtitle={t(onPlatform ? 'newApp.deploy.morePlatformSettingsSummary' : 'newApp.deploy.moreSettingsSummary')} onPress={() => setMoreOpen(true)} />
                </ItemGroup>
              )}
            </View>
          )}
          {draftStep === 'review' ? (partialProgress ?? <>{machineCausedRefusal ? machineAwayNotice : refusalBanner}
            {/* Opened from a build preview: what it built, and whether it answers, before Production (deploy auto-mode U9). */}
            {reviewBody}</>) : null}
        </View>
      );
    }

    return (
      <View style={styles.page}>
        <ItemList testID="project-deployments.draft">
          {header}
          {partialProgress ?? <>
          {refusalBanner}
          {reviewBody}
          {/* The Review replaces the form (PAGE-ACCEPT-176 R12-D6); the form stays mounted, so Back returns to what was typed. */}
          <View testID="project-deployments.draft.form" style={reviewBody ? styles.hiddenStep : null}>
          {projectChoiceGroups}
          {whereGroup}
          {configureGroups}
          {deployerGroups}
          </View>
          </>}
        </ItemList>
        {props.phone ? (
          <KeyboardStickyFooter>
            <PagePinnedBar>
              <RoundButton
                testID="project-deployments.draft.save.phone"
                title={saveAction.title}
                disabled={saveAction.disabled}
                loading={saveAction.loading}
                onPress={saveAction.onPress}
              />
            </PagePinnedBar>
          </KeyboardStickyFooter>
        ) : null}
      </View>
    );
  },
);

type DraftCopyDataChoice = Exclude<DeploymentEnvironmentCopyChoicesV1['data'][number], { kind: 'createEmpty' }>
  | Readonly<{ targetLinkId: string; kind: 'createEmpty'; provision?: ManagedDataProvisionDraft }>;
type DraftCopyChoices = Omit<DeploymentEnvironmentCopyChoicesV1, 'data'> & { data: DraftCopyDataChoice[] };

type SecretCopyChoice = 'useSameReference' | 'choose' | 'omit';
type DataCopyChoice = DeploymentEnvironmentCopyChoicesV1['data'][number]['kind'];
/** A copy's data is a deliberate choice; each option says what the new Environment gets. */
const DATA_COPY_OPTIONS = (): ReadonlyArray<SegmentedChoiceOption<DataCopyChoice>> => Object.values({
  omit: { id: 'omit', label: t('projects.deployments.copy.dataOmit'), description: t('projects.deployments.copy.dataOmitHint') },
  reuse: { id: 'reuse', label: t('projects.deployments.copy.dataReuse'), description: t('projects.deployments.copy.dataReuseHint') },
  createEmpty: { id: 'createEmpty', label: t('projects.deployments.copy.dataEmpty'), description: t('projects.deployments.copy.dataEmptyHint') },
  restoreBackup: { id: 'restoreBackup', label: t('projects.deployments.copy.dataRestore'), description: t('projects.deployments.copy.dataRestoreHint'),
    unavailableReason: t('projects.deployments.copy.dataRestoreUnavailable') },
} satisfies { [Choice in DataCopyChoice]: SegmentedChoiceOption<Choice> });

/** Where it runs fills whole rows: three across, or two when three would leave one tile alone (four choices). */
function targetTileColumns(count: number): number {
  return count <= 3 ? Math.max(count, 1) : count % 3 === 1 ? 2 : 3;
}

const HOST_APPLY_IDLE = Object.freeze({ pending: false, error: null });
const hostSetupExecute = createFrontDoorActionExecute();

const NO_PLATFORM_TARGETS: ReturnType<typeof readDeploymentPlatformTargets> = [];

/** The source's runtime Machine, else its controller: where the copy is most likely meant to run. */
function copySourceMachineId(source: DeploymentEnvironmentDetailV1): string {
  return source.targetLinks.find((row) => row.targetLink.role === 'runtime')?.targetLink.machines[0] ?? source.environment.controllerMachineId;
}

/** Copy admission requires an explicit choice per source row; no values or credentials are opened here. */
function initialCopyChoices(source: DeploymentEnvironmentDetailV1): DraftCopyChoices {
  return {
    secrets: source.content.bindings.filter(row => row.source.kind === 'secret').map((row): DeploymentEnvironmentCopyChoicesV1['secrets'][number] => ({
      binding: projectEnvironmentSecretBindingIdentityV1(row), kind: row.purpose === 'variable' || row.purpose === 'registry' ? 'useSameReference' : 'omit',
    })),
    values: source.content.bindings.filter(row => row.source.kind !== 'secret').map((row): DeploymentEnvironmentCopyChoicesV1['values'][number] => ({
      binding: projectEnvironmentSecretBindingIdentityV1(row), kind: 'include',
    })),
    data: source.targetLinks.filter(row => row.targetLink.role === 'data').map(row => ({ targetLinkId: row.targetLink.id, kind: 'omit' })),
    retainPreviousDeployments: 'copy',
  };
}

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, minHeight: 0 },
  // A visited step that another step covers: kept mounted with its choices, out of layout and out of the tab order.
  hiddenStep: { display: 'none' },
  machineCard: { gap: theme.space.s4 },
  machineFacts: { flexDirection: 'row', gap: theme.space.s16, paddingTop: theme.space.s8 },
  machineFactValues: { flex: 1, minWidth: 0 },
  agentEntries: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 },
}));

/**
 * An unchosen Machine card's facts (lab stWhere / where): Machine, Status and, when its owner reports it, free memory,
 * as the compact label · value lines the platform cards' plans use, read-only (DESIGN-ACCEPT W3).
 */
function MachineCardFactRows(props: Readonly<{ serverId: string | null; machineId: string; machine: string; status: string | null }>) {
  const { theme } = useUnistyles();
  const resources = useMachineResourceSummary({ serverId: props.serverId ?? '', machineId: props.machineId });
  const available = props.serverId && resources?.kind === 'reporting' ? resources.summary?.memory.availableBytes ?? null : null;
  const rows = [
    { label: t('projects.deployments.machine'), value: props.machine },
    ...(props.status ? [{ label: t('newApp.deploy.factStatus'), value: props.status }] : []),
    ...(available !== null ? [{ label: t('newApp.deploy.factMemory'),
      value: t('newApp.deploy.factMemoryFree', { free: formatHappierDataBytes(available, { kind: 'memory' }) }) }] : []),
  ];
  return (
    <View style={styles.machineFacts}>
      <View>{rows.map(row => <Text key={row.label} variant="meta" numberOfLines={1}
        style={{ color: theme.colors.text.secondary }}>{row.label}</Text>)}</View>
      <View style={styles.machineFactValues}>{rows.map(row => <Text key={row.label} variant="meta" numberOfLines={1}
        style={{ color: theme.colors.text.primary }}>{row.value}</Text>)}</View>
    </View>
  );
}

/**
 * The chosen Machine's facts in its Where card (journey-deploy whereM), each only when its owner reports it: free
 * memory from the Machine's resource summary. Runs and Docker have no owner read here yet, so they are not drawn.
 */
function MachineCardFacts(props: Readonly<{ serverId: string; machineId: string }>) {
  const resources = useMachineResourceSummary({ serverId: props.serverId, machineId: props.machineId });
  const available = resources?.kind === 'reporting' ? resources.summary?.memory.availableBytes ?? null : null;
  if (available === null) return null;
  return (
    <BareSectionContent>
      <FieldLayout label={t('newApp.deploy.factMemory')} columns>
        <FieldValue value={t('newApp.deploy.factMemoryFree', { free: formatHappierDataBytes(available, { kind: 'memory' }) })} />
      </FieldLayout>
    </BareSectionContent>
  );
}

function DeploymentCopyProvisionEditor(props: Readonly<{
  targetLinkId: string;
  contribution: Readonly<{ pluginId: string; localId: string }>;
  lifetime: ServerAccountScopeLifetime;
  disabled: boolean;
  onChange: (targetLinkId: string, draft: ManagedDataProvisionDraft | null) => void;
}>) {
  const onChange = React.useCallback((draft: ManagedDataProvisionDraft | null) => props.onChange(props.targetLinkId, draft),
    [props.onChange, props.targetLinkId]);
  return <DeploymentManagedDataProvisionEditor lifetime={props.lifetime} contribution={props.contribution}
    disabled={props.disabled} onChange={onChange} />;
}
