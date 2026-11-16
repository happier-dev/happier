import { OWN_SERVER_DEPLOYMENT_TARGET_V1, resolvePublishTargetRecommendation } from '@happier-dev/deployments';
import { isMachineRoleActiveV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { deploymentRecommendationDescription } from './deploymentRecommendationDescription';
import { projectDeploymentConfigurePreflightV1 } from './deploymentPreflightWarnings';
import * as React from 'react';
import { MachineCreationContinuation, type MachineCreationContinuationDraft } from '@/components/machines/add/MachineCreationContinuation';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionConfirmationReviewFacts } from '@/components/approvals/ActionConfirmationReview';
import { DeploymentCreationReviewFacts } from '@/components/approvals/ApprovalReviewFacts';
import { useInStepActionConfirmation } from '@/components/approvals/useInStepActionConfirmation';
import type { DeploymentEnvironmentTabV1 } from '@happier-dev/deployments';
import { DeploymentPartialProgress } from './DeploymentPartialProgress';
import { DeploymentProjectChoiceGroups, type DeploymentProjectChoiceModel } from './DeploymentProjectChoice';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentEnvironmentCopyChoicesV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentCopyV1';
import type { DeploymentEnvironmentDeployerPrincipalV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentDeployerV1';
import { environmentSecretBindingIdentityV1, projectEnvironmentSecretBindingIdentityV1, type DeploymentTemplateRefV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ProjectRefSelect } from '@/components/projects/ProjectRefSelect';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { PLUGINS_APP_ROUTE } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
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
import { FieldLayout, FieldValue } from '@/components/ui/lists/FieldRow';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { deploymentActionRefusalRemedy, deploymentDefinitionLabel } from './deploymentPresentation';
import { DeploymentMachinesEmpty } from './DeploymentMachinesEmpty';
import { DeploymentPreparationEntry } from './DeploymentPreparation';
import { DeploymentManagedDataProvisionEditor, type ManagedDataProvisionDraft } from './DeploymentManagedData';

import type { createDeploymentActions } from './deploymentActions';
import { DeploymentDeployerFields } from './DeploymentDeployerFields';
import { useDeployHostReadiness } from './EnvironmentMachineChoice';
import { MachineSetupPlanReview, describeMachineSetupPlanFailure, describeMachineSetupReviewUnavailable } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { MachineSetupRecipeInputs } from '@/components/settings/machines/managed/MachineSetupRecipeInputs';
import { readDeploymentRefusalRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { DeploymentPlatformTargetEditor, useDeploymentPlatformTargets } from './DeploymentPlatformTargetSheet';
import { buildPlatformTargetCreateLinkInput, buildPlatformTargetLinkInput, type PreparedPlatformTargetLink } from './platformTargetLink';
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
  /** The answered Where: a platform's name or the Machine's. */
  runsOn: Readonly<{ kind: 'machine' | 'platform'; title: string | null }> | null;
  /** The Project's repository and branch, once its Source is read. */
  source: Readonly<{ title: string; note: string | null }> | null;
  appName: string | null;
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
      projectChoice?: DeploymentProjectChoiceModel;
      phone: boolean;
      actions: Pick<Actions, 'prepareCreate' | 'inspectPlatformTarget' | 'link'> | null;
      copyFrom?: DeploymentEnvironmentDetailV1 | null;
      /** A door that names what it starts from (Store → Apps): a stored definition, in any Project. */
      definitionKind?: 'compose' | 'image' | null;
      /** A catalog app (Deploy an app → From the catalog): its exact registry pin is what runs, in any Project. */
      catalogApp?: Readonly<{ templateRef: DeploymentTemplateRefV1; title: string }> | null;
      /** Where a door already chose (a suggested platform); the recommendation owner still decides what is offered. */
      initialTargetKey?: string | null;
      onApprovalRequested: (artifactId: string) => void;
      onSaved: (environmentId: string, next?: Readonly<{ tab?: DeploymentEnvironmentTabV1; projectSourceId?: string }>) => void;
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
    const [composePath, setComposePath] = React.useState(DEFAULT_COMPOSE_PATH);
    const [composeDocument, setComposeDocument] = React.useState('');
    const [imageName, setImageName] = React.useState('');
    const [imagePort, setImagePort] = React.useState('');
    const [ref, setRef] = React.useState<string | null>(null);
    const [production, setProduction] = React.useState(props.copyFrom ? props.copyFrom.environment.protection === 'production' : stepped);
    const [deployerMode, setDeployerMode] = React.useState<DeploymentEnvironmentDetailV1['environment']['deployerMode']>(
      props.copyFrom?.environment.deployerMode ?? 'managers',
    );
    const [deployerPrincipals, setDeployerPrincipals] = React.useState<readonly DeploymentEnvironmentDeployerPrincipalV1[]>(
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
    const partial = refusal?.kind === 'refused' ? refusal.progress : undefined;
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
    const presenceScope = props.lifetime?.scope ?? null;
    const presence = React.useMemo(() => new Map(machines.map((machine) =>
      [machine.id, describeMachinePresenceLine(machine, presenceNowMs, undefined, presenceScope)])), [machines, presenceNowMs, presenceScope]);
    const answers = (machine: (typeof machines)[number]) => presence.get(machine.id)?.online === true;
    // A Machine whose Deployments role is off refuses deploys, so it is never the default home (Machine roles).
    const deploysHere = (machine: (typeof machines)[number]) => answers(machine) && isMachineRoleActiveV1(machine.metadata, 'deployments');
    // The person's choice wins. Otherwise a copy starts on its source's Machine and a new draft on the first one that
    // answers and accepts Deployments; with no eligible Machine nothing is chosen for the person.
    const preferredId = props.copyFrom ? copySourceMachineId(props.copyFrom) : null;
    const chosen =
      machineId !== null ? machines.find((machine) => machine.id === machineId) ?? null :
      machines.find((machine) => machine.id === preferredId && deploysHere(machine)) ?? machines.find(deploysHere) ?? null;
    const branch = ref ?? source?.defaultRef ?? null;
    const platformEnvironment = React.useMemo(() => sourceId ? { projectSourceId: sourceId,
      ...(chosen ? { controllerMachineId: chosen.id } : {}) } : null, [sourceId, chosen?.id]);
    React.useEffect(() => setPlatformProvider(null), [platformTarget?.key, chosen?.id, source?.revision]);
    // A repository-free Project has only stored definitions; a door may also ask for one in any Project.
    const definitionKind = props.definitionKind ?? (source !== null && source.repository === undefined ? 'compose' : null);
    const storedDefinition = definitionKind !== null;
    const recommendation = resolvePublishTargetRecommendation({
      definition: props.copyFrom?.content.definition ?? (props.catalogApp ? { from: 'catalogApp' }
        : definitionKind ? { from: definitionKind } : { kind: 'repository' }),
      explicitTarget: targetKey !== OWN_SERVER_TARGET ? { id: targetKey, targetClass: 'platform' } : undefined,
      targets: [{ id: OWN_SERVER_TARGET, targetClass: 'ownServer', availability: allMachines == null ? 'unknown'
        : chosen && answers(chosen) ? 'available' : 'unavailable',
        accepts: OWN_SERVER_DEPLOYMENT_TARGET_V1.accepts, needs: OWN_SERVER_DEPLOYMENT_TARGET_V1.needs },
        ...platformTargets.map(target => ({ id: target.key, targetClass: 'platform' as const, availability: 'unknown' as const,
          accepts: target.accepts, needs: target.needs }))],
    });
    const offeredPlatformTargets = platformTargets.filter(target => recommendation.offeredTargetIds.includes(target.key));
    const onPlatform = recommendation.target?.targetClass === 'platform';
    const platformDefinitionAccepted = recommendation.offeredTargetIds.includes(targetKey);
    // The Configure preflight owner (DEPLOY-ACTIVITY-READ-1113) decides name and port syntax, as the server will.
    const configure = projectDeploymentConfigurePreflightV1({ name, port: imagePort });
    const imagePortValid = configure.port.status === 'valid';
    const imagePortNumber = configure.port.value ?? Number.NaN;
    // A Compose Environment reads the chosen Machine's readiness once; required host settings and an explicit
    // Review precede its setup Plan. Saving can wait for it; nothing runs until Apply.
    const host = useDeployHostReadiness(onPlatform || creatingMachine ? null : props.lifetime,
      onPlatform || creatingMachine ? null : chosen?.id ?? null);
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
      (copyChoices?.data.every(choice => choice.kind === 'createEmpty' ? provisionDrafts[choice.targetLinkId] != null
        : choice.kind !== 'reuse' || Boolean(choice.bindings?.length && choice.bindings.every(binding =>
          reusableBindings.some(eligible => environmentSecretBindingIdentityV1(eligible) === environmentSecretBindingIdentityV1(binding))))) ?? true) &&
      chosen !== null && platformDefinitionAccepted && (!onPlatform || platformProvider !== null) &&
      (props.copyFrom !== undefined && props.copyFrom !== null || props.catalogApp != null || (definitionKind === 'image'
        ? imageName.trim().length > 0 && imagePortValid
        : storedDefinition
        ? composeDocument.trim().length > 0
        : branch !== null && (onPlatform || composePath.trim().length > 0)));
    const { actions, onSaved, onApprovalRequested } = props;
    // A retention choice belongs to the Machine it was made for.
    React.useEffect(() => {
      setRetention('alwaysOn');
    }, [chosen?.id]);
    // A prepared run carries the exact operands it was prepared from; any edit makes it stale.
    React.useEffect(() => {
      setPrepared(null);
      answerStepConfirmation(false);
    }, [answerStepConfirmation, projectSelection, name, chosen?.id, branch, composePath, composeDocument, imageName, imagePort, storedDefinition, production, deployerMode, deployerPrincipals, retention, onPlatform, copyChoices, platformProvider, provisionDrafts]);
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
      if (partial) {
        if (partial.environmentId) onSaved(partial.environmentId, { tab: deploymentPartialRecoveryTab(partial) });
        return;
      }
      if (!valid || !actions || !chosen?.installationId || saving || !props.lifetime) return;
      setSaving(true);
      setRefusal(null);
      let createdEnvironment: Readonly<{ environmentId: string; revision: number }> | null = null;
      try {
        if (!prepared) {
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
            } : storedDefinition ? {
              from: 'compose', document: composeDocument, profiles: [], services: [],
            } : onPlatform ? { from: 'repository', ref: branch! } : {
              from: 'repository', ref: branch!,
              compose: { path: composePath.trim(), profiles: [], services: [] },
            } }),
            protection: production ? 'production' : 'nonProduction',
            purpose: 'standard',
            deployerMode,
            deployerPrincipals: [...deployerPrincipals],
            // A platform Environment still deploys from a Machine: the chosen one is its controller.
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
        createdEnvironment = created;
        if (platformTarget && platformProvider) {
          // An existing resource links as reviewed; Create new makes it now, through the editor's own create intent.
          const environment = { id: created.environmentId, revision: created.revision };
          const linkInput = platformProvider.kind === 'existing'
            ? buildPlatformTargetLinkInput({ target: platformTarget, environment, provider: platformProvider.provider })
            : await buildPlatformTargetCreateLinkInput({ serverId: props.lifetime.scope.serverId, target: platformTarget, environment,
              requestKey: platformProvider.requestKey, providerCreate: platformProvider.providerCreate });
          if (!linkInput) {
            setRefusal({ kind: 'refused', reason: 'other', code: 'invalid_parameters', progress: { kind: 'partial',
              environmentId: created.environmentId, revision: created.revision, phase: 'target', savedSecrets: [], errorCode: 'invalid_parameters' } });
            return;
          }
          const linked = await actions.link(linkInput, { confirmed: true });
          if (!linked.ok) {
            const outcome = readDeploymentActionResult(linked);
            if (outcome.kind === 'refused') setRefusal({ ...outcome, progress: { kind: 'partial',
              environmentId: created.environmentId, revision: created.revision, phase: 'target', savedSecrets: [], errorCode: outcome.code } });
            return;
          }
        }
        onSaved(created.environmentId, props.projectChoice && created.projectSourceId ? { projectSourceId: created.projectSourceId } : undefined);
      } catch (error) {
        // Declining the controller's review in this step is the person's answer, not a failure.
        if (isActionApprovalDeclinedErrorCode((error as { code?: unknown } | null)?.code)) return;
        const outcome = readDeploymentActionError(error);
        if (outcome.kind === 'approval') {
          if (createdEnvironment) onSaved(createdEnvironment.environmentId, { tab: 'settings' });
          onApprovalRequested(outcome.artifactId);
        }
        setRefusal(createdEnvironment && outcome.kind === 'refused' ? { ...outcome, progress: { kind: 'partial',
          environmentId: createdEnvironment.environmentId, revision: createdEnvironment.revision,
          phase: 'target', savedSecrets: [], errorCode: outcome.code } } : outcome);
      } finally {
        setSaving(false);
      }
    };

    const platformStatus = platforms.state.status;
    const targetTiles: Array<SelectionTile<string>> = [
      { id: OWN_SERVER_TARGET, icon: 'hard-drives', title: t('projects.deployments.platformLink.onMachine'),
        subtitle: t('projects.deployments.whereDescription') },
      ...offeredPlatformTargets.map((target): SelectionTile<string> => ({
        id: target.key, title: target.title, mark: <PluginMark title={target.title} pluginId={target.pluginId} />,
        ...(target.description ? { subtitle: target.description } : {}),
      })),
      ...(recommendation.target?.targetClass === 'platform' && !platformDefinitionAccepted ? [{ id: recommendation.target.id,
        title: t('common.unavailable'), subtitle: recommendation.target.id, disabled: true } satisfies SelectionTile<string>] : []),
      // The tiles keep their place while the read answers; each other state says itself once, with its next step.
      ...(recommendation.evidence.includes('stored_definition') ? [] : platformStatus === 'loading'
        ? [{ id: LOADING_TILE, icon: 'cube', title: t('projects.deployments.platformLink.loading'), disabled: true } satisfies SelectionTile<string>]
        : platformStatus === 'failed'
          ? [{ id: RETRY_TILE, icon: 'cube', title: t('projects.deployments.platformLink.failed'), subtitle: t('common.retry') } satisfies SelectionTile<string>]
          : platformTargets.length === 0
            ? [{ id: PLUGINS_TILE, icon: 'cube', title: t('projects.deployments.platformLink.usePlatform'),
                subtitle: t('projects.deployments.platformLink.emptyBody') } satisfies SelectionTile<string>]
            : []),
    ];
    // Stepped (journey-deploy where): the targets read as cards. The recommended one carries its reason and badge,
    // and More platforms always closes the grid, also where a stored definition runs on a Machine only.
    const recommendedId = recommendation.evidence.length > 0 ? recommendation.target?.id ?? null : null;
    const recommendationReason = recommendedId ? deploymentRecommendationDescription(recommendation) : null;
    const stepTiles: Array<SelectionTile<string>> = stepped ? [
      // The chosen target leads the grid across its row (journey-deploy where); the others keep two columns beneath.
      ...targetTiles.filter(tile => tile.id !== PLUGINS_TILE).map((tile): SelectionTile<string> => ({
        ...tile,
        ...(tile.id === recommendedId ? { badge: t('newApp.deploy.recommended'),
          subtitle: [recommendationReason, tile.subtitle].filter(Boolean).join('\n') } : {}),
        ...(tile.id === targetKey ? { span: 'row' as const } : {}),
      })),
      { id: PLUGINS_TILE, icon: 'plus', title: t('newApp.deploy.morePlatforms'), subtitle: t('newApp.deploy.morePlatformsBody') },
    ] : targetTiles;
    // A platform the definition can't use leaves the grid for one muted list with the one shared reason (whereM).
    const unusablePlatforms = stepped ? platformTargets.filter(target => !recommendation.offeredTargetIds.includes(target.key)) : [];
    const chooseTarget = (next: string | null) => {
      if (next === null || next === LOADING_TILE) return;
      if (next === PLUGINS_TILE) {
        // Turning on a plugin happens in Plugins; a hosted flow steps aside first.
        if (stepped) props.onDiscard();
        router.push(PLUGINS_APP_ROUTE);
        return;
      }
      if (next === RETRY_TILE) { platforms.retry(); return; }
      setTargetKey(next);
    };

    const saveAction = {
      title: partial
        ? t('projects.deployments.openEnvironment')
        : prepared
        ? t('projects.deployments.creationReview.create')
        : t('projects.deployments.saveEnvironment'),
      onPress: () => {
        void save();
      },
      disabled: stepReview ? false : partial ? !partial.environmentId || saving : !valid || !actions || saving,
      loading: saving && !stepReview,
      testID: 'project-deployments.draft.save',
    };

    const draftStep: DeploymentDraftStep = stepReview || prepared || partial ? 'review' : formStep;
    // Where continues only on a Machine that answers (whereErr): an away one says so in its tile instead.
    const whereReady = chosen !== null && answers(chosen) && platformDefinitionAccepted;
    const pressStep = useEventCallback(() => {
      if (draftStep !== 'where') { void save(); return; }
      if (!whereReady) return;
      setConfigureVisited(true);
      setFormStep('configure');
    });
    const backStep = useEventCallback(() => {
      if (draftStep === 'configure') { setFormStep('where'); return; }
      if (draftStep === 'where') { props.steps?.onExit(); return; }
      if (partial) props.onDiscard();
      else if (stepReview) answerStepConfirmation(false);
      else setPrepared(null);
    });
    const toWhere = useEventCallback(() => {
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
    const sourceTitle = source ? source.repository?.repository.nameWithOwner ?? source.name : null;
    const appName = source?.name ?? (projectSelection && 'newProject' in projectSelection ? projectSelection.newProject.name.trim() || null : null);
    const frame = React.useMemo((): DeploymentDraftFrame => ({
      step: draftStep,
      runsOn: runsOnKind ? { kind: runsOnKind, title: runsOnTitle } : null,
      source: sourceTitle ? { title: sourceTitle, note: branch } : null,
      appName,
      primary: { title: primary.title, disabled: primary.disabled, loading: primary.loading, testID: primary.testID },
      press: pressStep, back: backStep, toWhere,
    }), [draftStep, runsOnKind, runsOnTitle, sourceTitle, branch, appName, primary.title, primary.disabled, primary.loading,
      primary.testID, pressStep, backStep, toWhere]);
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
              <PageHeaderMarkIcon name="plus" />
            }
            titleEditor={partial ? undefined : {
              value: name,
              // The rail's draft row reads the same until a name is typed (one name for one draft).
              placeholder: t('projects.deployments.newEnvironment'),
              accessibilityLabel: t('projects.deployments.name'),
              onChangeText: setName,
              onCommit: () => setName((current) => current.trim()),
            }}
            description={t(partial ? 'projects.deployments.partialProgressBody' : props.copyFrom ? 'projects.deployments.copy.description' : 'projects.deployments.draftDescription')}
            {...(props.phone ? {} : { primaryAction: saveAction })}
            cancelAction={partial ? {
              title: t('common.close'), onPress: props.onDiscard, testID: 'project-deployments.draft.close',
            } : prepared ? {
              title: t('common.back'),
              onPress: () => setPrepared(null),
              testID: 'project-deployments.draft.back',
            } : {
              title: t('common.discard'),
              onPress: props.onDiscard,
              testID: 'project-deployments.draft.discard',
            }}
          />
    );
    const partialProgress = partial && refusal?.kind === 'refused' && refusal.failure
      ? <DeploymentPartialProgress testID="project-deployments.draft.progress" progress={partial} failure={refusal.failure} /> : null;
    // One notice per cause: a chosen Machine that stopped answering is said once, by its own notice, in place of the
    // target refusal and the setup failure that both come from it (journey-deploy revFail).
    const awayMachine = chosen !== null && !answers(chosen) ? chosen : null;
    // The shared notice line (SurfaceStateCard size="line"), placed at the Machine it concerns.
    const machineAwayNotice = awayMachine ? (
      <SurfaceStateCard testID="project-deployments.draft.machineAwayNotice" kind="unavailable" size="line"
        title={machineName(awayMachine.id)} reason={t('errors.machineNotAnswering')} />
    ) : null;
    // The recovery owner names where a refusal is fixed: a Machine cause, or the unavailable target, is that Machine.
    const machineCausedRefusal = awayMachine !== null && refusal?.kind === 'refused' && (refusal.code === 'target_unavailable'
      || readDeploymentRefusalRecoveryV1(refusal.code)?.nextAction.destination === 'machines');
    const refusalBanner = machineCausedRefusal ? null
      : refusal && refusal.kind === 'approval' ? (
            <AttentionBanner
              testID="project-deployments.draft.approval"
              tone="neutral"
              title={t('projects.deployments.createApprovalTitle')}
              description={t('projects.deployments.createApprovalBody')}
            />
          ) : refusal && refusal.kind === 'refused' ? (
            <AttentionBanner
              testID="project-deployments.draft.refused"
              tone="danger"
              title={t('projects.deployments.createFailedTitle')}
              description={readDeploymentRefusalRecoveryV1(refusal.code)?.remedy ?? deploymentActionRefusalRemedy(refusal.code)}
              details={[refusal.code]}
            />
          ) : null;
    const reviewFacts = stepReview ? (
            <ActionConfirmationReviewFacts actionId={stepReview.actionId} actionArgs={stepReview.actionArgs}
              summaryPlacement="host"
              preview={stepReview.preview} serverId={props.lifetime?.scope.serverId ?? null}
              testID="project-deployments.draft.confirmation" />
          ) : prepared ? (
            <DeploymentCreationReviewFacts review={prepared.review} serverId={props.lifetime?.scope.serverId ?? null}
              testID="project-deployments.draft" />
          ) : null;
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
    const whereGroup = <>
          <ItemGroup
            // Stepped, the host's step description asks the question; the group keeps the recommendation's reason.
            title={stepped ? undefined : t('projects.deployments.whereTitle')}
            description={deploymentRecommendationDescription(recommendation)}
          >
            {props.platformAvailable ? (
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
            {machines.length === 0 && machineId === null ? (
              <DeploymentMachinesEmpty serverId={props.lifetime?.scope.serverId ?? ''} testID="project-deployments.draft" empty={
                <Item
                  testID="project-deployments.draft.noMachine.create"
                  title={t('managedMachines.add.createPath')}
                  subtitle={t('projects.deployments.noMachineBody')}
                  onPress={() => setCreatingMachine(true)}
                  disabled={!props.lifetime}
                />} />
            ) : (
              <SessionMachineField
                testID="project-deployments.draft.machine"
                serverId={props.lifetime?.scope.serverId ?? ''}
                machines={machines}
                machineId={machineId ?? chosen?.id ?? null}
                machineName={t('approvals.machineNotKnown')}
                title={onPlatform
                  ? t('projects.deployments.platformLink.deploysFrom')
                  : t('projects.deployments.machine')}
                awayMachinesChoosable
                onSelectMachine={(machine) => setMachineId(machine.id)}
              />
            )}
            {/* Stepped, how long it keeps running is one of More settings (journey-deploy cfgM). */}
            {stepped ? null : machineAwayNotice}
            {stepped ? null : retentionChoice}
          </ItemGroup>
          {!platformDefinitionAccepted ? <SurfaceStateCard kind="unavailable" size="line"
            title={t('common.unavailable')} /> : null}
    </>;
    const machineAway = chosen !== null && !answers(chosen);
    // The Machine choice lives in the Machine card (whereM): its picker with the presence owner's line, and when that
    // Machine is away, the one next step on its own line.
    // Until the Machine list has answered, the field holds its place; "no Machine" is said only once it is known.
    const machineCard = allMachines != null && machines.length === 0 && machineId === null ? (
      <DeploymentMachinesEmpty serverId={props.lifetime?.scope.serverId ?? ''} testID="project-deployments.draft" empty={
        <Item testID="project-deployments.draft.noMachine.create" title={t('managedMachines.add.createPath')}
          subtitle={t('projects.deployments.noMachineBody')} onPress={() => setCreatingMachine(true)} disabled={!props.lifetime} />} />
    ) : (
      <View style={styles.machineCard}>
        {/* A bare section, so the field's row lands on the tile's text column like the title above it. */}
        <ItemGroup surface="none">
        <SessionMachineField
          testID="project-deployments.draft.machine"
          serverId={props.lifetime?.scope.serverId ?? ''}
          machines={machines}
          machineId={machineId ?? chosen?.id ?? null}
          machineName={t('approvals.machineNotKnown')}
          title={onPlatform ? t('projects.deployments.platformLink.deploysFrom') : t('projects.deployments.machine')}
          {...(chosen ? { subtitle: presence.get(chosen.id)?.label } : {})}
          awayMachinesChoosable
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
              renderOptionFooter={({ option }) => option.id === OWN_SERVER_TARGET ? machineCard : null}
            />
            </BareSectionContent>
          </ItemGroup>
          {unusablePlatforms.length > 0 ? (
            <ItemGroup testID="project-deployments.draft.cantRun"
              title={sourceTitle || appName ? t('newApp.deploy.cantRun', { name: appName ?? sourceTitle ?? '' }) : t('newApp.deploy.cantRunUnnamed')}
              titleRole="label" description={t('newApp.deploy.cantRunStored')}>
              {unusablePlatforms.map(target => <Item key={target.key} mode="info" dimmed showChevron={false} title={target.title}
                icon={<PluginMark title={target.title} pluginId={target.pluginId} />} />)}
            </ItemGroup>
          ) : null}
    </> : null;
    const configureGroups = <>
          {platformTarget && platformDefinitionAccepted && platformEnvironment && props.lifetime && actions ? (
            <DeploymentPlatformTargetEditor key={`${platformTarget.key}:${chosen?.id ?? ''}:${source?.revision ?? ''}`}
              name={name} environment={platformEnvironment} ownerAccountId={props.lifetime.scope.accountId}
              lifetime={props.lifetime} actions={{ inspectPlatformTarget: actions.inspectPlatformTarget, link: actions.link }}
              initialTargetKey={platformTarget.key} onPrepared={setPlatformProvider}
              onApproval={onApprovalRequested} onClose={props.onDiscard} />
          ) : null}
          {/* An unready Machine says so once, with its one next step (lab d1d notready): review its setup. The recipe's
              inputs follow the callout; the reviewed plan then replaces it with Set up and the plan itself. */}
          {!onPlatform && chosen && host.setup && !host.prepared ? (
            <AttentionBanner
              testID={host.readiness === 'needsSetup' ? 'project-deployments.draft.hostNeedsSetup' : 'project-deployments.draft.hostUnchecked'}
              tone="warning"
              title={t(host.readiness === 'needsSetup' ? 'projects.deployments.platformLink.hostNeedsSetup'
                : 'projects.deployments.platformLink.hostUnchecked', { machine: machineName(chosen.id) })}
              description={t('projects.deployments.platformLink.hostSetupBody')}
              action={{ label: t('projects.deployments.platformLink.hostReviewAction', { machine: machineName(chosen.id) }),
                onPress: () => { void host.review(); }, loading: host.reviewing,
                disabled: !host.canReview || hostApply.pending, display: 'default', testID: 'project-deployments.draft.hostSetup.prepare' }}
            />
          ) : null}
          {!onPlatform && host.setup ? <MachineSetupRecipeInputs setup={host.setup} projection={host.inputProjection}
            scope={props.lifetime?.scope} onChange={host.setSetup} testID="project-deployments.draft.hostSetup.inputs" /> : null}
          {!onPlatform && chosen && host.prepared?.ok && host.readiness !== 'ready' ? <>
            <AttentionBanner
              testID="project-deployments.draft.hostSetup"
              tone="warning"
              title={t('projects.deployments.platformLink.hostNeedsSetup', { machine: machineName(chosen.id) })}
              description={t('projects.deployments.platformLink.hostSetupBody')}
              {...(hostApply.error ? { details: [hostApply.error] } : {})}
              action={{ label: t('projects.deployments.platformLink.hostSetupAction', { machine: machineName(chosen.id) }),
                onPress: () => { void applyHostSetup(); }, loading: hostApply.pending,
                disabled: hostApply.pending || describeMachineSetupReviewUnavailable(host.prepared, machineName) !== undefined,
                display: 'secondary', testID: 'project-deployments.draft.hostSetup.apply' }}
            />
            <MachineSetupPlanReview testID="project-deployments.draft.hostSetup.review" prepared={host.prepared}
              nameOf={machineName} disabled={hostApply.pending} />
          </> : !onPlatform && host.prepared?.ok === false ? awayMachine ? null : (
            <AttentionBanner testID="project-deployments.draft.hostSetup.failed" tone="warning" title={t('machinePresets.setup.title')}
              description={describeMachineSetupPlanFailure(host.prepared, machineName)} />
          ) : !onPlatform && chosen && host.readiness === 'unknown' && !host.setup ? (
            <ItemGroup>
              <Item testID="project-deployments.draft.hostUnchecked" mode="info"
                title={t('projects.deployments.platformLink.hostUnchecked', { machine: machineName(chosen.id) })} />
            </ItemGroup>
          ) : null}
          <ItemGroup
            title={t('projects.deployments.whatRunsTitle')}
            description={props.copyFrom || storedDefinition || props.catalogApp ? undefined : onPlatform
              ? t('projects.deployments.platformLink.platformBuilds')
              : t('projects.deployments.whatRunsDescription')}
          >
            {props.copyFrom ? <Item title={deploymentDefinitionLabel(props.copyFrom.content) ?? t('projects.deployments.whatRunsTitle')}
              subtitle={props.copyFrom.content.name} mode="info" /> : props.catalogApp ? <Item testID="project-deployments.draft.catalogApp"
              title={props.catalogApp.title} mode="info" showChevron={false} /> : definitionKind === 'image' ? <>
              <Item title={t('managedMachines.config.image')} accessoryLayout={stepped ? 'adaptive' : 'stacked'} showChevron={false}
                rightElement={<FieldTextInput testID="project-deployments.draft.imageName"
                  accessibilityLabel={t('managedMachines.config.image')} value={imageName}
                  onChangeText={setImageName} monospace autoCapitalize="none" autoComplete="off" />}
              />
              <Item title={t('projects.deployments.domainFieldPort')} accessoryLayout={stepped ? 'adaptive' : 'stacked'} showChevron={false}
                rightElement={<FieldTextInput testID="project-deployments.draft.imagePort"
                  accessibilityLabel={t('projects.deployments.domainFieldPort')} value={imagePort}
                  onChangeText={setImagePort} monospace autoCapitalize="none" autoComplete="off" />}
              />
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
                source?.defaultRef
                  ? t('projects.deployments.branchDefault', {
                      ref: source.defaultRef,
                    })
                  : t('projects.deployments.branchChoose')
              }
              defaultIsPrompt={!source?.defaultRef}
              compact={props.phone}
              onChange={setRef}
            />
            {!onPlatform && props.lifetime && source?.repository ? <>
              <DeploymentPreparationEntry lifetime={props.lifetime} projectSourceId={source.id} mode="prepare" />
              <DeploymentPreparationEntry lifetime={props.lifetime} projectSourceId={source.id} mode="import" />
            </> : null}
            </>}
          </ItemGroup>
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
              title={t('projects.deployments.production')}
              subtitle={t('projects.deployments.productionHint')}
              rightElement={
                <Switch value={production} onValueChange={setProduction} />
              }
              onPress={() => setProduction((current) => !current)}
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
                    subtitle={t('newApp.deploy.moreSettingsSummary')} onPress={() => setMoreOpen(true)} />
                </ItemGroup>
              )}
            </View>
          )}
          {draftStep === 'review' ? (partialProgress ?? <>{refusalBanner}{reviewFacts}</>) : null}
        </View>
      );
    }

    return (
      <View style={styles.page}>
        <ItemList testID="project-deployments.draft">
          {header}
          {partialProgress ?? <>
          {refusalBanner}
          {reviewFacts}
          {projectChoiceGroups}
          {whereGroup}
          {configureGroups}
          {deployerGroups}
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
}));

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
