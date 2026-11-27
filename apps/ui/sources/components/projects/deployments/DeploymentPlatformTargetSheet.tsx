import {
  DEPLOYMENT_TARGET_REQUIRES_REPOSITORY_DEFINITION,
  readDeploymentDefinitionSourceKindV1,
  readDeploymentTargetSourceCheckV1,
  type PublishTargetRecommendationInput,
} from '@happier-dev/protocol/deployments/resolvePublishTargetRecommendation';
import * as React from 'react';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { randomUUID } from '@/platform/randomUUID';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { useDeploymentTargetLinkOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { observeActionOperationByRequestId } from '@/sync/domains/actionOperations/observeActionOperationByRequestId';
import { StyleSheet } from 'react-native-unistyles';
import {
  resolveEffectiveActionInputFields,
  isSameActionInputOptionValue,
  type EffectiveActionInputField,
} from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { seedInputByFieldHints } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { DeploymentSourceMethodV1Schema, type DeploymentSourceMethodV1 } from '@happier-dev/deployments/contracts/v1';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { readDeploymentRefusalRecovery } from './deploymentPresentation';
import type { DeploymentFailureRecoveryDestinationV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

import {
  ActionInputFields,
  getValueAtPath,
  setValueAtTopLevelPatch,
  type ActionFieldOption,
} from '@/components/sessions/actions/ActionInputFields';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { deriveRepositoryName } from '@/components/projects/starters/newAppDraft';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { findSoleEligibleOption } from '@/components/ui/selectionList/findSoleEligibleOption';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider, useListPresentation, usePageListInsets } from '@/components/ui/lists/listPresentation';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useFirstConnection } from './useFirstConnection';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { DeploymentPlatformCredentialDisclosure } from './DeploymentPlatformCredentialDisclosure';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readProjectRepositoryIdentityV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { t } from '@/text';

import { readDeploymentActionError, readDeploymentRefusal } from './deploymentActionOutcome';
import { deploymentActionRefusalRemedy, readDeploymentConnectionPermissionRemedy } from './deploymentPresentation';
import type { createDeploymentActions } from './deploymentActions';
import { isJsonObject, projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentSourceMethodChoice } from './DeploymentSourceMethodChoice';
import { DeploymentPlatformInspectState } from './DeploymentPlatformInspectState';
import {
  buildPlatformTargetDraft,
  buildPlatformTargetCreateLinkInput,
  buildPlatformTargetLinkInput,
  readDeploymentPlatformTargets,
  readProviderCreate,
  type PreparedPlatformTargetLink,
  readPlatformReviewNotice,
  readPlatformGitCreateReview,
  readPlatformReviewRuntime,
  type PlatformInspectOutcome,
  applyPlatformFieldPatch,
  disclosePlatformFields,
  drawPlatformFields,
} from './platformTargetLink';
import { managedDataTargets } from './managedData';
import { useActionFieldCreation } from '@/components/sessions/actions/useActionFieldCreation';

type Actions = ReturnType<typeof createDeploymentActions>;
type ProductionBranchOutcome = NonNullable<Extract<Awaited<ReturnType<Actions['link']>>, { ok: true }>['productionBranchOutcome']>;
type LinkRefusal = Extract<Awaited<ReturnType<Actions['link']>>, { ok: false }>
  | Readonly<{ ok: false; error: 'action_outcome_unknown' }>;
export type DeploymentPlatformLinkActions = Pick<
  Actions,
  'checkPlatformTarget' | 'inspectPlatformTarget' | 'link'
>;

type PlatformLinkEnvironment = Readonly<{
  projectSourceId: string;
  definition: PublishTargetRecommendationInput['definition'];
  controllerMachineId?: string;
}>;

export type DeploymentPlatformTargetSheetInput = Readonly<{
  name: string;
  environment: PlatformLinkEnvironment & Readonly<{ id: string; revision: number }>;
  ownerAccountId: string;
  lifetime: ServerAccountScopeLifetime;
  actions: DeploymentPlatformLinkActions;
  /** A held approval continues on the page's one approval handle. */
  onApproval: (artifactId: string) => void;
  /** The platform already chosen in the draft, so the person never picks it twice. */
  initialTargetKey?: string | null;
  /** The page's recovery router, for a refusal's next step (Source details, Settings, …). */
  onOpenRecoveryDestination?: (destination: DeploymentFailureRecoveryDestinationV1) => void;
}>;

type TargetDeclarationsState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; declarations: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[] }>
  | Readonly<{ status: 'failed'; code: string }>;

const LOADING_TARGET_DECLARATIONS: TargetDeclarationsState = Object.freeze({ status: 'loading' });

/** The plugins' own deployment targets, loaded only while a consumer asks for them. */
export function useDeploymentTargetDeclarations(lifetime: ServerAccountScopeLifetime | null) {
  const [read, setRead] = React.useState<Readonly<{ lifetime: ServerAccountScopeLifetime; state: TargetDeclarationsState }> | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!lifetime) return;
    const reader = readPluginAccountAvailability(lifetime.scope);
    let live = true;
    let running = false;
    let changed = false;
    const publish = (state: TargetDeclarationsState) => {
      if (!live) return;
      stopWaiting();
      setRead({ lifetime, state });
    };
    const acquire = async () => {
      running = true;
      try {
        do {
          changed = false;
          const result = await reader.ensureCurrentAccountExecutionDeclarations({ family: 'deploymentTargets' });
          if (!live) return;
          if (result.kind === 'available') {
            publish({ status: 'ready', declarations: result.declarations });
            return;
          }
          if (result.code !== 'account_availability_not_loaded' && result.code !== 'account_availability_scope_mismatch'
            && result.code !== 'plugin_ui_declaration_pending') {
            publish({ status: 'failed', code: result.code });
            return;
          }
          // A publication while the read was settling must wake a still-pending result.
        } while (changed);
      } catch (error: unknown) {
        const code = (error as { code?: unknown } | null)?.code;
        publish({ status: 'failed', code: typeof code === 'string' && code ? code : 'unknown_error' });
      } finally {
        running = false;
      }
    };
    const stopWaiting = reader.subscribe(() => {
      changed = true;
      if (!running) void acquire();
    });
    setRead({ lifetime, state: LOADING_TARGET_DECLARATIONS });
    void acquire();
    return () => {
      live = false;
      stopWaiting();
    };
  }, [lifetime, attempt]);
  return {
    state: read && read.lifetime === lifetime ? read.state : LOADING_TARGET_DECLARATIONS,
    retry: React.useCallback(() => setAttempt((value) => value + 1), []),
  };
}

/** Runtime and data pickers consume the same Account deployment-target declaration acquisition. */
export function useDeploymentPlatformTargets(lifetime: ServerAccountScopeLifetime | null) {
  const { state, retry } = useDeploymentTargetDeclarations(lifetime);
  const projected = React.useMemo(() => state.status === 'ready'
    ? { ...state, targets: readDeploymentPlatformTargets(state.declarations) } : state, [state]);
  return { state: projected, retry };
}

type PlatformTargetSource = Readonly<{ contribution: Readonly<{ pluginId: string; localId: string }> }>;
const NO_TITLES: ReadonlyMap<string, string> = new Map();
const titleKey = (pluginId: string, localId: string) => `${pluginId}/${localId}`;

/**
 * Platform and managed data targets' own names (Vercel, Cloudflare Pages, Neon), read once from the Account's
 * deployment-target declarations while `wanted`. Every Environment row, header and Settings row names its platform
 * through this, and Move names the provider a destination's data lives on.
 */
export function useDeploymentPlatformTargetTitles(lifetime: ServerAccountScopeLifetime | null, wanted: boolean) {
  const { state } = useDeploymentPlatformTargets(wanted ? lifetime : null);
  const titles = React.useMemo(() => state.status === 'ready'
    ? new Map([...state.targets, ...managedDataTargets(state.declarations)]
      .map(target => [titleKey(target.pluginId, target.targetId), target.title]))
    : NO_TITLES, [state]);
  return React.useCallback(
    (source: PlatformTargetSource) => titles.get(titleKey(source.contribution.pluginId, source.contribution.localId)) ?? null,
    [titles],
  );
}

const EMPTY_VALUES: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Prepare a platform target inline in the draft, or link one from an existing Environment:
 * choose a target from the plugins' declarations, the connected account it uses, and the project, environment
 * and product through the provider's own choices. Check reads the provider and the saved association. Link records
 * the checked target after write admission. Linking deploys nothing.
 */
export function DeploymentPlatformTargetEditor(
  props: Omit<DeploymentPlatformTargetSheetInput, 'environment'> & CustomModalInjectedProps & Readonly<{
    environment: PlatformLinkEnvironment & Readonly<{ id?: string; revision?: number;
      /** What runs owns the repository choice in the guided draft. Null means a choice is still required. */
      repositoryBranch?: string | null }>;
    /** Drafts review the same provider result in place; the creating page commits the association. */
    /** Inside the new-Environment draft: the chosen existing resource or reviewed create intent, linked after Create. */
    onPrepared?: (prepared: PreparedPlatformTargetLink | null) => void;
    onWaitingForChange?: (waitingFor: string | null) => void;
  }>,
) {
  const shouldContinue = useMountedShouldContinue();
  const router = useRouter();
  const controllerLabel = useServerScopedMachineLabel(props.lifetime.scope.serverId, props.environment.controllerMachineId ?? null);
  const [mode, setMode] = React.useState<'existing' | 'create'>('existing');
  const [requestKey, setRequestKey] = React.useState<string | null>(null);
  const [linkSettlement, setLinkSettlement] = React.useState<LinkRefusal | null>(null);
  const [createdBranchOutcome, setCreatedBranchOutcome] = React.useState<ProductionBranchOutcome | null>(null);
  const [recoveryReadRefused, setRecoveryReadRefused] = React.useState<string | null>(null);
  const provisioned = linkSettlement?.error === 'deployment_link_incomplete' ? linkSettlement.recovery : null;
  const outcomeUnknown = linkSettlement?.error === 'action_outcome_unknown';
  const duplicate = linkSettlement?.error === 'provider_scope_already_linked' ? linkSettlement : null;
  const reviewingCreate = provisioned !== null || outcomeUnknown || createdBranchOutcome !== null;
  const linkOperations = useDeploymentTargetLinkOperations({
    serverId: props.lifetime.scope.serverId, accountId: props.lifetime.scope.accountId,
    machineId: undefined, environmentId: props.onPrepared ? null : props.environment.id ?? null,
  });
  // Hydrate retained summaries through their original executor, one canonical finite observer at a time.
  const observation = linkOperations.find(operation => operation.snapshot.requestId
    && (operation.snapshotComplete !== true || operation.snapshot.state === 'accepted' || operation.snapshot.state === 'running'));
  const unresolvedLink = linkOperations.some(operation => operation.snapshotComplete !== true);
  const pendingLink = linkOperations.some(operation => operation.snapshot.state === 'accepted' || operation.snapshot.state === 'running');
  const linkRequestId = observation?.snapshot.requestId;
  const linkMachineId = observation?.snapshot.scope.machineId;
  const linkServerId = observation?.serverId ?? props.lifetime.scope.serverId;
  const linkAccountId = props.lifetime.scope.accountId;
  React.useEffect(() => {
    if (!linkRequestId || !linkMachineId) return;
    const controller = new AbortController();
    setRecoveryReadRefused(null);
    void observeActionOperationByRequestId({ serverId: linkServerId, accountId: linkAccountId, machineId: linkMachineId,
      requestIdentity: { actionId: 'deployments.targets.link', requestId: linkRequestId }, signal: controller.signal,
      onUnavailable: code => { if (!controller.signal.aborted) setRecoveryReadRefused(code); } });
    return () => controller.abort();
  }, [linkRequestId, linkMachineId, linkServerId, linkAccountId]);
  React.useEffect(() => {
    if (linkOperations.length === 0) return;
    let live = true;
    void import('@happier-dev/protocol/deployments/deploymentActionsV1').then(({ DeploymentTargetLinkResultV1Schema }) => {
      if (!live) return;
      const settlements = linkOperations.flatMap(operation => {
        const domain = operation.snapshot.domainRef;
        if (domain?.kind !== 'deploymentTargetLink') return [];
        const parsed = DeploymentTargetLinkResultV1Schema.safeParse(operation.snapshot.result ?? operation.snapshot.error?.details);
        const result = parsed.success ? parsed.data : isActionOutcomeUnknownErrorCodeV1(operation.snapshot.error?.errorCode)
          ? { ok: false as const, error: 'action_outcome_unknown' as const } : null;
        // A confirmed association conflict leaves the acknowledged native project available for Finish linking.
        if (result && !result.ok && result.error === 'deployment_link_incomplete'
          && !result.failure
          && result.recovery.expectedRevision !== props.environment.revision) return [];
        if (result?.ok && result.productionBranchOutcome && props.environment.revision !== undefined
          && result.revision < props.environment.revision) return [];
        return result ? [{ operation, domain, result }] : [];
      });
      const completed = new Set(settlements.filter(entry => entry.result.ok).map(entry => entry.domain.requestKey));
      // A failed or unrelated association cannot erase a created resource. Finish the newest orphan first.
      const orphans = settlements.filter(entry => entry.domain.purpose === 'create' && !completed.has(entry.domain.requestKey)
        && !entry.result.ok && (entry.result.error === 'deployment_link_incomplete' || entry.result.error === 'action_outcome_unknown'));
      const selected = (orphans.length ? orphans : settlements).reduce<(typeof settlements)[number] | null>((latest, entry) =>
        !latest || entry.operation.snapshot.createdAt > latest.operation.snapshot.createdAt ? entry : latest, null);
      if (!selected) return;
      const result = selected.result;
      setLinkSettlement(result.ok ? null : result);
      setCreatedBranchOutcome(result.ok ? result.productionBranchOutcome ?? null : null);
      if (!result.ok && result.error === 'deployment_link_incomplete') {
        setTargetKey(`${result.recovery.source.contribution.pluginId}/${result.recovery.source.contribution.localId}`);
        setMode('create');
      }
      const association = orphans.includes(selected) ? linkOperations.filter(operation => operation.snapshot.domainRef?.kind === 'deploymentTargetLink'
        && operation.snapshot.domainRef.purpose === 'associate' && operation.snapshot.domainRef.requestKey === selected.domain.requestKey)
        .reduce<(typeof linkOperations)[number] | null>((latest, operation) =>
          !latest || operation.snapshot.createdAt > latest.snapshot.createdAt ? operation : latest, null) : null;
      const failure = association?.snapshot.error ?? (!result.ok && result.error === 'deployment_link_incomplete' ? result.failure : undefined);
      const refusedCode = failure?.errorCode ?? (!result.ok && result.error !== 'deployment_link_incomplete'
        && result.error !== 'provider_scope_already_linked' && result.error !== 'action_outcome_unknown' ? result.error : null);
      setLinkRefused(refusedCode ? { code: refusedCode, details: failure?.details } : null);
    });
    return () => { live = false; };
  }, [linkOperations, props.environment.revision]);
  const { state: platformsState, retry: retryPlatforms } =
    useDeploymentPlatformTargets(props.lifetime);
  const sourceKind = readDeploymentDefinitionSourceKindV1(props.environment.definition);
  const { targets, sourceRefusals } = React.useMemo(() => {
    const sourceRefusals = new Map<string, typeof DEPLOYMENT_TARGET_REQUIRES_REPOSITORY_DEFINITION>();
    const targets = platformsState.status === 'ready' ? platformsState.targets.filter(entry => {
      const refusal = readDeploymentTargetSourceCheckV1(entry)?.(sourceKind);
      if (!refusal) return true;
      sourceRefusals.set(entry.key, refusal);
      return false;
    }) : [];
    return { targets, sourceRefusals };
  }, [platformsState, sourceKind]);
  const provisionedSourceRefusal = provisioned
    ? sourceRefusals.get(titleKey(provisioned.source.contribution.pluginId, provisioned.source.contribution.localId)) : undefined;
  const sourceRefusal = provisionedSourceRefusal ?? (targets.length === 0 ? sourceRefusals.values().next().value : undefined);
  const [targetKey, setTargetKey] = React.useState<string | null>(props.initialTargetKey ?? null);
  const target = provisioned
    ? targets.find(entry => entry.pluginId === provisioned.source.contribution.pluginId && entry.targetId === provisioned.source.contribution.localId) ?? null
    : targets.find((entry) => entry.key === targetKey) ?? targets[0] ?? null;
  // Create new makes the resource for an existing Environment here, or for the draft's Environment once it exists.
  const createAvailable = Boolean(props.onPrepared || (props.environment.id && props.environment.revision !== undefined));
  const create = mode === 'create' && createAvailable ? target?.create : undefined;
  const form = React.useMemo(() => create && target
    ? { ...target, ...create, inspectLocalId: create.localId, inspectActionId: create.actionId } : target, [target, create]);
  const [selectedMethod, setSourceMethod] = React.useState<DeploymentSourceMethodV1>('gitIntegration');
  const sourceMethod = target?.sourceMethods.includes(selectedMethod) ? selectedMethod : target?.sourceMethods[0];
  const [platformMenuOpen, setPlatformMenuOpen] = React.useState(false);
  const [account, setAccount] =
    React.useState<QualifiedConnectedAccountRef | null>(null);
  const [enteredValues, setValues] =
    React.useState<Readonly<Record<string, unknown>>>(EMPTY_VALUES);
  // One page of choices per field; Previous walks back the cursors this field was asked with.
  const [cursors, setCursors] = React.useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const [outcome, setOutcome] = React.useState<PlatformInspectOutcome | null>(
    null,
  );
  const [busy, setBusy] = React.useState<'check' | 'link' | null>(null);
  const [linkRefused, setLinkRefused] = React.useState<Readonly<{ code: string; details?: unknown }> | null>(null);
  // Add a token runs the one shared connect flow for this service; its account becomes this link's account,
  // and the platform's own choices and Check (what the token can do) follow in place.
  const firstConnection = useFirstConnection(props.lifetime, form?.service ?? null, (connected) => {
    setAccount(connected);
    resetValues();
    setCursors({});
    resetFrom();
  });
  const needsConnect = target !== null && account === null && firstConnection.missing;
  const connectionPending = firstConnection.pending;
  const connectionNeeded = needsConnect || connectionPending || firstConnection.unavailable;
  const sourceRead = useProjectSource(props.lifetime, props.environment.projectSourceId);
  const source = sourceRead.source?.source ?? null;
  const repository = React.useMemo(
    () => readProjectRepositoryIdentityV1({ source }),
    [source],
  );

  const takesRepositoryBranch = create?.fields.some(field => field.path === 'productionBranch') === true;
  const usesDraftBranch = takesRepositoryBranch && props.environment.repositoryBranch !== undefined;
  const repositoryName = source?.repository?.repository.nameWithOwner.split('/').at(-1);
  const suggestedName = takesRepositoryBranch && repositoryName ? deriveRepositoryName(repositoryName) : '';
  const draftBranch = usesDraftBranch ? props.environment.repositoryBranch
    : source?.defaultRef ?? source?.repository?.repository.defaultBranch;
  const values = React.useMemo(() => ({
    ...enteredValues,
    ...(suggestedName && enteredValues.resourceName === undefined ? { resourceName: suggestedName } : {}),
    ...(takesRepositoryBranch && (usesDraftBranch || enteredValues.productionBranch === undefined)
      ? { productionBranch: draftBranch } : {}),
  }), [draftBranch, enteredValues, suggestedName, takesRepositoryBranch, usesDraftBranch]);

  const draft = React.useMemo(
    () =>
      form && account && !connectionNeeded
        ? buildPlatformTargetDraft({
            target: form,
            ownerAccountId: props.ownerAccountId,
            serverId: props.lifetime.scope.serverId,
            environment: props.environment,
            account,
            repository,
            values,
            ...(!create && form.sourceMethods.includes('upload') && sourceMethod ? { sourceMethod } : {}),
          })
        : null,
    [
      form,
      account,
      connectionNeeded,
      props.ownerAccountId,
      props.lifetime.scope.serverId,
      props.environment,
      repository,
      values,
      sourceMethod,
      create,
    ],
  );
  const effectiveFields = React.useMemo(
    () => form ? resolveEffectiveActionInputFields(
      { inputHints: { fields: [...form.fields] } }, draft ?? values, { includeHidden: true },
    ) : [],
    [form, draft, values],
  );
  const fields = React.useMemo(
    () => disclosePlatformFields(effectiveFields, values),
    [effectiveFields, values],
  );
  const requests = React.useMemo(
    () =>
      form && draft
        ? fields.map((field) => {
            const cursor = cursors[field.path]?.at(-1);
            return {
              field,
              actionId: form.inspectActionId,
              draftInput: draft,
              ...(cursor ? { cursor } : {}),
            };
          })
        : [],
    [form, draft, fields, cursors],
  );
  const options = useInputFieldOptions({
    requests,
    declaredInputTypes: form?.declaredInputTypes,
    enabled: draft !== null,
    serverId: props.lifetime.scope.serverId,
    accountLifetime: props.lifetime,
  });
  const fieldCreation = useActionFieldCreation({
    declarations: platformsState.status === 'ready' ? platformsState.declarations : undefined,
    lifetime: props.lifetime, enabled: draft !== null, account, fields: effectiveFields, values,
    onCreated: (created) => patch(created, true),
  });
  const resolveOptions = fieldCreation.withCreatedChoices(options.resolveOptions);
  // One failed read is said once, at the sheet; an optional choice this target has nothing for is not drawn.
  const drawn = drawPlatformFields(fields, values, (field) => options.state(field),
    (field) => (cursors[field.path]?.length ?? 0) > 0, (field) => fieldCreation.choiceAction(field) !== undefined);
  const visibleFields = usesDraftBranch ? drawn.fields.filter(field => field.path !== 'productionBranch') : drawn.fields;
  const optionRefusal = drawn.failure;
  const optionRecovery = optionRefusal && readDeploymentRefusalRecovery(optionRefusal.code, optionRefusal);
  const missingField = fields.find(field => {
    const value = getValueAtPath(values, field.path);
    return field.required && (value == null || (typeof value === 'string' && value.trim() === ''));
  });
  const missing = missingField !== undefined;

  const resetValues = (createFields: readonly EffectiveActionInputField[] | null = create?.fields ?? null) => {
    setValues(createFields ? seedInputByFieldHints({ inputHints: { fields: [...createFields] } }, EMPTY_VALUES) : EMPTY_VALUES);
  };
  const resetFrom = React.useCallback(() => {
    setOutcome(null);
    setLinkRefused(null);
    if (!provisioned && !outcomeUnknown) setRequestKey(null);
    props.onPrepared?.(null);
  }, [props.onPrepared, provisioned, outcomeUnknown]);
  const choosePlatform = (id: string) => {
    setPlatformMenuOpen(false);
    if (id === target?.key) return;
    setTargetKey(id);
    setSourceMethod('gitIntegration');
    setAccount(null);
    resetValues(mode === 'create' ? targets.find(entry => entry.key === id)?.create?.fields ?? null : null);
    setCursors({});
    resetFrom();
  };
  // Existing and New keep each answer both ask the same way (the project just created on either path), so a choice
  // that is empty on Existing can lead to New without choosing that project again.
  const chooseMode = (next: 'existing' | 'create') => {
    if (!target) return;
    const nextForm = next === 'create' ? target.create : target;
    const keepAccount = !account || !nextForm
      || buildQualifiedPluginContributionKey(account.service) === buildQualifiedPluginContributionKey(nextForm.service);
    setMode(next);
    if (!keepAccount) setAccount(null);
    const nextFields = next === 'create' ? nextForm?.fields ?? null : null;
    const seeded = nextFields ? seedInputByFieldHints({ inputHints: { fields: [...nextFields] } }, EMPTY_VALUES) : EMPTY_VALUES;
    const kept = keepAccount ? Object.fromEntries((form?.fields ?? []).flatMap(field => {
      const value = field.path.includes('.') ? undefined : values[field.path];
      const asked = field.inputType && 'pluginId' in field.inputType ? buildQualifiedPluginContributionKey(field.inputType) : null;
      return value !== undefined && asked && nextForm?.fields.some(entry => entry.path === field.path && entry.inputType
        && 'pluginId' in entry.inputType && buildQualifiedPluginContributionKey(entry.inputType) === asked) ? [[field.path, value]] : [];
    })) : {};
    setValues(Object.keys(kept).length ? { ...seeded, ...kept } : seeded);
    setCursors({});
    resetFrom();
  };
  // A just-created project has nothing to pick on Existing: the empty choice leads to New.
  const emptyChoiceLead = !create && target?.create && createAvailable && busy === null && !reviewingCreate ? {
    label: t('projects.deployments.platformLink.createNew'), onPress: () => chooseMode('create'),
    testID: 'project-deployments.platform.createNew',
  } : undefined;
  const patch = (next: Record<string, unknown>, createdScope = false) => {
    const { values: kept, changedIndex: changed } = applyPlatformFieldPatch(effectiveFields, values, next);
    setValues(createdScope ? { ...kept, ...next } : kept);
    setCursors((current) =>
      changed === -1
        ? current
        : Object.fromEntries(
            Object.entries(current).filter(
              ([path]) =>
                effectiveFields.findIndex((field) => field.path === path) <= changed,
            ),
          ),
    );
    resetFrom();
  };
  // A required provider choice with exactly one eligible option is answered for the person, in field order: the
  // Cloudflare account behind the sole connection, or the Worker just named on Create new (PAGE-ACCEPT-176 R8-D4, R10-D6).
  const mayPreselect = draft !== null && !connectionNeeded && busy === null && !reviewingCreate;
  const soleChoice = mayPreselect ? fields.reduce<Readonly<{ path: string; value: ActionFieldOption['value'] }> | null>((found, field) => {
    if (found || !field.required || field.allowCustomValue || field.widget !== 'select') return found;
    if (getValueAtPath(values, field.path) !== undefined || (cursors[field.path]?.length ?? 0) > 0) return found;
    const choices = options.state(field);
    if (choices.status !== 'ready' || choices.nextCursor !== undefined) return found;
    const option = findSoleEligibleOption(choices.options, choice => !choice.disabled);
    return option ? { path: field.path, value: option.value } : found;
  }, null) : null;
  const applySoleChoice = useEventCallback(() => { if (soleChoice) patch(setValueAtTopLevelPatch(values, soleChoice.path, soleChoice.value)); });
  // The choice is rebuilt each render; its serialized form says when it changed.
  const soleChoiceKey = soleChoice ? JSON.stringify(soleChoice) : null;
  React.useEffect(() => { if (soleChoiceKey) applySoleChoice(); }, [soleChoiceKey, applySoleChoice]);
  const page = (
    field: EffectiveActionInputField,
    direction: 'next' | 'previous',
  ) => {
    const nextCursor = options.state(field).nextCursor;
    setCursors((current) => {
      const stack = current[field.path] ?? [];
      const next =
        direction === 'next'
          ? nextCursor
            ? [...stack, nextCursor]
            : stack
          : stack.slice(0, -1);
      return { ...current, [field.path]: next };
    });
  };

  const { onClose, onApproval, actions } = props;
  const connect = firstConnection.connect;
  const check = async () => {
    if (!target || !draft || !account || busy) return;
    setBusy('check');
    setOutcome(null);
    props.onPrepared?.(null);
    setLinkRefused(null);
    setLinkSettlement(null);
    try {
      const { repository: _repository, environmentId: _environmentId, expectedRevision: _revision, credentialRef: _ref,
        credentialPrincipal: _principal, v: _version, serverId: _serverId, ...fields } = draft;
      const operands = projectNativeJsonValueForTransport(fields);
      if (!isJsonObject(operands)) throw new TypeError('Invalid deployment target operands');
      const inspected = await actions.checkPlatformTarget({
        projectSourceId: props.environment.projectSourceId,
        ...(props.environment.id ? { environmentId: props.environment.id } : {}),
        ...(props.environment.controllerMachineId ? { controllerMachineId: props.environment.controllerMachineId } : {}),
        target: { pluginId: target.pluginId, localId: target.targetId },
        credentialRef: account,
        fields: operands,
      });
      if (!shouldContinue() || !props.lifetime.isCurrent()) return;
      if (inspected.kind === 'alreadyLinked') {
        setLinkSettlement(inspected.association);
        return;
      }
      setOutcome(inspected);
      if (inspected.kind === 'ready') props.onPrepared?.({ kind: 'existing', provider: inspected.provider,
        reviewNotice: readPlatformReviewNotice(inspected.provider) });
    } catch (error) {
      if (!shouldContinue() || !props.lifetime.isCurrent()) return;
      const refusal = readDeploymentActionError(error);
      setOutcome(refusal.kind === 'refused' ? refusal : readDeploymentRefusal('deployment_content_unavailable'));
    } finally {
      if (shouldContinue() && props.lifetime.isCurrent()) setBusy(null);
    }
  };
  const link = async () => {
    if (!target || outcome?.kind !== 'ready' || busy || !props.environment.id || props.environment.revision === undefined) return;
    setBusy('link');
    setLinkRefused(null);
    try {
      const resourceId = outcome.provider.providerIdentity.providerResourceId;
      const resourceField = fields.find(field => field.widget === 'select' && getValueAtPath(values, field.path) === resourceId);
      const resourceTitle = resourceField ? options.resolveOptions(resourceField)
        .find(option => isSameActionInputOptionValue(option.value, resourceId))?.label : undefined;
      const result = await actions.link(
        buildPlatformTargetLinkInput({
          target,
          environment: { id: props.environment.id, revision: props.environment.revision },
          provider: outcome.provider,
          ...(resourceTitle ? { title: resourceTitle } : {}),
        }),
        // This sheet is the person's confirmation of the exact Link.
        { confirmed: true },
      );
      if (result.ok) {
        onClose();
        return;
      }
      if (result.error === 'provider_scope_already_linked') setLinkSettlement(result);
      else setLinkRefused({ code: result.error });
    } catch (error) {
      const read = readDeploymentActionError(error);
      if (read.kind === 'approval') {
        onClose();
        onApproval(read.artifactId);
        return;
      }
      setLinkRefused(read.kind === 'refused' ? { code: read.code, details: read.failure?.details } : { code: 'unknown_error' });
    } finally {
      setBusy(null);
    }
  };

  const createOrFinish = async () => {
    if (busy || provisionedSourceRefusal || (!provisioned && (pendingLink || unresolvedLink)) || outcomeUnknown || !props.environment.id || props.environment.revision === undefined) return;
    setBusy('link');
    setLinkRefused(null);
    try {
      let input: Parameters<Actions['link']>[0];
      if (provisioned) input = { ...provisioned, expectedRevision: props.environment.revision };
      else {
        if (!target || !create || !draft) return;
        const key = requestKey ?? randomUUID();
        setRequestKey(key);
        const parsed = await buildPlatformTargetCreateLinkInput({ serverId: props.lifetime.scope.serverId, target,
          environment: { id: props.environment.id, revision: props.environment.revision }, requestKey: key,
          providerCreate: readProviderCreate(draft) });
        if (!parsed) { setLinkRefused({ code: 'invalid_parameters' }); return; }
        input = parsed;
      }
      const result = await actions.link(input, { confirmed: true });
      if (!shouldContinue()) return;
      if (result.ok) {
        setLinkSettlement(null);
        if (result.productionBranchOutcome) { setCreatedBranchOutcome(result.productionBranchOutcome); return; }
        onClose(); return;
      }
      if (result.error === 'deployment_link_incomplete') {
        setLinkSettlement(result);
        if (result.failure) setLinkRefused({ code: result.failure.errorCode, details: result.failure.details });
      } else if (result.error === 'provider_scope_already_linked') setLinkSettlement(result);
      else setLinkRefused({ code: result.error });
    } catch (error) {
      const read = readDeploymentActionError(error);
      if (read.kind === 'approval') { onClose(); onApproval(read.artifactId); return; }
      if (read.kind === 'refused' && read.code === 'deployment_link_incomplete') {
        const { DeploymentTargetLinkProvisionedResultV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
        const partial = DeploymentTargetLinkProvisionedResultV1Schema.safeParse(read.failure?.details);
        if (!shouldContinue()) return;
        if (partial.success) {
          setLinkSettlement(partial.data);
          const cause = partial.data.failure;
          if (cause) setLinkRefused({ code: cause.errorCode, details: cause.details });
          return;
        }
      }
      if (read.kind === 'refused' && isActionOutcomeUnknownErrorCodeV1(read.code) && !provisioned) setLinkSettlement({ ok: false, error: 'action_outcome_unknown' });
      else setLinkRefused(read.kind === 'refused' ? { code: read.code, details: read.failure?.details } : { code: 'unknown_error' });
    } finally { if (shouldContinue()) setBusy(null); }
  };

  const platformItems = React.useMemo(
    (): DropdownMenuItem[] =>
      targets.map((entry) => ({
        id: entry.key,
        title: entry.title,
        checked: entry.key === target?.key,
        disabled: busy !== null || reviewingCreate,
      })),
    [targets, target?.key, busy, reviewingCreate],
  );

  const providerUrl = provisioned?.provider.providerUrl;
  const disclosedProvider = provisioned?.provider ?? (outcome?.kind === 'ready' || outcome?.kind === 'needsGitAccess' ? outcome.provider : null);
  const ready = outcome?.kind === 'ready';
  // In the draft, a ready create intent is the editor's whole answer: the draft's Create makes the resource with it.
  const preparedCreateKey = React.useRef<string | null>(null);
  const createIntentReady = Boolean(create && draft && target && !missing && !needsConnect && drawn.canCheck);
  const { onPrepared, onWaitingForChange } = props;
  const connectLabel = needsConnect ? t('projects.deployments.platformLink.connectAction', { platform: target.title }) : null;
  const reviewMissing = missingField ? t('projects.deployments.platformLink.reviewMissing', {
    field: missingField.title ?? t('projects.deployments.branch'),
  }) : null;
  const waitingFor = !onWaitingForChange || !target || (create ? createIntentReady : ready) ? null
    : connectLabel ?? (connectionPending ? t('common.loading')
      : firstConnection.unavailable ? t('errors.connectedAccountsUnavailable')
      : !account ? t('projects.deployments.platformLink.onPlatformBody')
      : optionRefusal ? t('projects.deployments.platformLink.choicesFailed', { platform: target.title })
      : reviewMissing ?? (!create ? t(outcome ? 'projects.deployments.platformLink.checkAgain' : 'projects.deployments.platformLink.check') : null));
  React.useEffect(() => { onWaitingForChange?.(waitingFor); }, [onWaitingForChange, waitingFor]);
  React.useEffect(() => () => onWaitingForChange?.(null), [onWaitingForChange]);
  // Before Create, the platform's inspect says what making this resource means (deploy auto-mode U8): read once per
  // platform, account and source method, through the target's own inspect with no resource named.
  // The create draft's own choices name how it deploys and which provider environment; the notice is read for those.
  const draftMethod = DeploymentSourceMethodV1Schema.safeParse(draft?.sourceMethod);
  const createSourceMethod = draftMethod.success ? draftMethod.data : sourceMethod;
  const providerEnvironment = draft?.providerEnvironment;
  const gitCreateReview = create && target && draft ? readPlatformGitCreateReview(target, draft) : null;
  // Branch-head deploy providers also disclose what Send builds (Pages source mode is fixed at creation).
  const needsProviderNotice = !gitCreateReview || target?.gitSource?.guarantee === 'branchHead';
  const noticeKey = needsProviderNotice && onPrepared && create && createIntentReady && target && account
    ? JSON.stringify([target.key, account, createSourceMethod ?? null, providerEnvironment ?? null]) : null;
  const [createNotice, setCreateNotice] = React.useState<Readonly<{
    key: string;
    notice: string | null;
    runtime: ReturnType<typeof readPlatformReviewRuntime>;
  }> | null>(null);
  const selectSoleConnection = useEventCallback((next: QualifiedConnectedAccountPurposeBindingTargetV1 | null) => {
    if (next?.kind === 'account') setAccount(next.account);
  });
  const readCreateNotice = useEventCallback((key: string, isCurrent: () => boolean) => {
    if (!target || !account) return;
    const input = buildPlatformTargetDraft({ target,
      ownerAccountId: props.ownerAccountId, serverId: props.lifetime.scope.serverId, environment: {}, account,
      repository: null, values: providerEnvironment === undefined ? {} : { providerEnvironment },
      ...(createSourceMethod ? { sourceMethod: createSourceMethod } : {}) });
    if (target.inspectInputSchema
      && !isValidPluginJsonSchemaValue(compilePluginJsonSchema(target.inspectInputSchema), input)) return;
    void actions.inspectPlatformTarget(target.inspectActionId, input,
      props.environment.controllerMachineId ? { externalActionTarget: { kind: 'machine', machineId: props.environment.controllerMachineId } } : undefined)
      .then(result => {
        if (!isCurrent()) return;
        const value = result.ok ? result.value : null;
        setCreateNotice({ key, notice: readPlatformReviewNotice(value), runtime: readPlatformReviewRuntime(value) });
      });
  });
  React.useEffect(() => {
    if (!noticeKey) return;
    let current = true;
    readCreateNotice(noticeKey, () => current);
    return () => { current = false; };
  }, [noticeKey, readCreateNotice]);
  const currentNotice = createNotice?.key === noticeKey ? createNotice : null;
  const reviewNotice = [gitCreateReview, currentNotice?.notice].filter(Boolean).join(' ') || null;
  React.useEffect(() => {
    if (!onPrepared || !create) return;
    if (!createIntentReady || !draft) { onPrepared(null); return; }
    preparedCreateKey.current ??= randomUUID();
    onPrepared({ kind: 'create', requestKey: preparedCreateKey.current, providerCreate: readProviderCreate(draft),
      reviewNotice,
      ...(currentNotice?.runtime && controllerLabel ? { reviewRuntime: { ...currentNotice.runtime, machineName: controllerLabel } } : {}),
    });
  }, [onPrepared, create, createIntentReady, draft, reviewNotice, currentNotice, controllerLabel]);
  // Before Connect there is nothing to check or link: no disabled Check anywhere, the connection leads (DESIGN-ACCEPT C1).
  const onPrimaryPress = useEventCallback(() => { void (create ? createOrFinish() : ready && !onPrepared ? link() : check()); });
  const primaryTestID = createdBranchOutcome || provisioned || outcomeUnknown || duplicate || pendingLink || unresolvedLink
    || !target || (create && onPrepared) || connectionNeeded ? null
    : create ? 'project-deployments.platform.create'
      : ready && !onPrepared ? 'project-deployments.platform.link' : 'project-deployments.platform.check';
  const primaryLoading = busy !== null;
  const primaryDisabled = primaryLoading || !draft || !target || missing || !drawn.canCheck;
  const primaryTitle = create ? t('projects.deployments.platformLink.create', { platform: target?.title ?? '' })
    : ready && target && !onPrepared ? t('projects.deployments.platformLink.link', { platform: target.title })
      : outcome ? t('projects.deployments.platformLink.checkAgain') : t('projects.deployments.platformLink.check');
  const primary = React.useMemo(() => primaryTestID ? {
    testID: primaryTestID, loading: primaryLoading, disabled: primaryDisabled, title: primaryTitle, onPress: onPrimaryPress,
  } : null, [primaryTestID, primaryLoading, primaryDisabled, primaryTitle, onPrimaryPress]);
  const showDone = createdBranchOutcome !== null;
  const showCancel = !onPrepared && !showDone;
  const doneTitle = showDone ? t('common.done') : null;
  const footer = React.useMemo(() => (
    <ModalCardFooterActions {...(showCancel ? { cancel: { onPress: onClose, testID: 'project-deployments.platform.cancel', disabled: primaryLoading } } : {})}>
      {doneTitle !== null ? <RoundButton testID="project-deployments.platform.done" size="normal" title={doneTitle} onPress={onClose} />
        : primary ? <RoundButton size="normal" {...primary} /> : null}
    </ModalCardFooterActions>
  ), [showCancel, onClose, primaryLoading, doneTitle, primary]);
  const { setChrome } = props;
  // Inside a page (the new-environment draft) the editor is one of the page's sections: its rows share the page's
  // edge, the platform names the section and its one action sits on the section title (lab d1r `platform`).
  const embedded = !setChrome;
  // Embedded, the editor is one of its host's sections: it keeps the host's presentation and insets, so the platform
  // section lines up with the sections around it (a dialog's or a page's), instead of adding a page inset of its own.
  const hostPresentation = useListPresentation();
  const hostInsets = usePageListInsets();
  React.useEffect(() => {
    setChrome?.({ kind: 'card', footer });
  }, [setChrome, footer]);
  React.useEffect(() => () => setChrome?.(null), [setChrome]);

  return (
    <ListPresentationProvider value={embedded ? hostPresentation : 'page'} pageInsets={embedded ? hostInsets : 'contained'}>
      <View testID="project-deployments.platform" style={embedded ? styles.embedded : deploymentSheetStyles.body}>
        {props.onPrepared || !target ? null : <Text style={deploymentSheetStyles.lead}>
          {t('projects.deployments.platformLink.lead')}
        </Text>}
        {createdBranchOutcome ? <SurfaceStateCard testID="project-deployments.platform.productionBranch" size="line"
          kind={createdBranchOutcome.status === 'set' ? 'success' : 'warning'}
          title={t('projects.deployments.platformLink.created')}
          reason={createdBranchOutcome.status === 'set' ? t('projects.deployments.platformLink.branchSet', createdBranchOutcome)
            : [createdBranchOutcome.status === 'defaultKept' ? t('projects.deployments.platformLink.branchDefaultKept', createdBranchOutcome)
              : t('projects.deployments.platformLink.branchUnconfirmed', createdBranchOutcome),
            readDeploymentConnectionPermissionRemedy(createdBranchOutcome.failureCause.errorCode ?? undefined, createdBranchOutcome.failureCause)]
              .filter(Boolean).join(' ')}
          {...(createdBranchOutcome.status === 'set' ? {} : { diagnosticCode: createdBranchOutcome.failureCause.errorCode ?? undefined })} />
          : sourceRefusal ? (
          <SurfaceStateCard testID="project-deployments.platform.sourceRefused" size="line" kind="unavailable"
            title={t('common.unavailable')}
            reason={deploymentActionRefusalRemedy(sourceRefusal)} />
        ) : reviewingCreate && !target ? null : platformsState.status === 'loading' ? (
          <SurfaceStateCard
            testID="project-deployments.platform.loading"
            size="line"
            kind="loading"
            title={t('projects.deployments.platformLink.loading')}
          />
        ) : platformsState.status === 'failed' ? (
          <SurfaceStateCard
            testID="project-deployments.platform.failed"
            size="line"
            kind="error"
            title={t('projects.deployments.platformLink.failed')}
            diagnosticCode={platformsState.code}
            action={{ label: t('common.retry'), onPress: retryPlatforms }}
          />
        ) : !target ? (
          <SurfaceStateCard
            testID="project-deployments.platform.empty"
            size="line"
            kind="empty"
            title={t('projects.deployments.platformLink.empty')}
            reason={t('projects.deployments.platformLink.emptyBody')}
          />
        ) : (
          <>
            <ItemGroup {...(embedded ? {
              title: t('projects.deployments.platformLink.onPlatformTitle', { platform: target.title }),
              // Create new says its consequence once, as the section's sentence, not as a bold row among the account rows
              // (PAGE-ACCEPT-176 R7-D2).
              description: t(create ? 'projects.deployments.platformLink.createConsequences' : 'projects.deployments.platformLink.onPlatformBody'),
              // The section's Check stands only once it can run (an account and its choices made); a disabled
              // header action that cannot succeed yet is not drawn (DESIGN-ACCEPT C1 follow-up).
              ...(primary && (!primary.disabled || primary.loading) ? { action: <SectionActionButton {...primary} /> } : {}),
            } : { header: 'none' as const })}>
              {connectionPending ? (
                <SurfaceStateCard testID="project-deployments.platform.connectionPending" size="line" kind="loading"
                  title={t('common.loading')} />
              ) : firstConnection.unavailable ? (
                <SurfaceStateCard testID="project-deployments.platform.connectionUnavailable" size="line" kind="unavailable"
                  title={t('projects.deployments.platformLink.connection')} reason={t('errors.connectedAccountsUnavailable')}
                  action={{ label: t('common.retry'), onPress: firstConnection.retry,
                    testID: 'project-deployments.platform.connectionRetry' }} />
              ) : connectLabel ? (
                <SurfaceStateCard
                  testID="project-deployments.platform.connect"
                  size="line"
                  kind="unavailable"
                  title={t('projects.deployments.platformLink.connectTitle', { platform: target.title })}
                  reason={t('projects.deployments.platformLink.connectBody', { platform: target.title })}
                  action={{
                    label: connectLabel,
                    onPress: connect,
                    testID: 'project-deployments.platform.connect.add',
                  }}
                />
              ) : null}
              {target.create && createAvailable && !connectionNeeded ? <SegmentedChoiceItem<'existing' | 'create'>
                // The row names the choice; the project row below names the thing, so the two never share a title.
                testID="project-deployments.platform.mode" title={t('projects.deployments.platformLink.modeTitle')}
                value={mode} disabled={busy !== null || reviewingCreate}
                options={[{ id: 'existing', label: t('projects.deployments.platformLink.modeExisting') },
                  { id: 'create', label: t('projects.deployments.platformLink.modeCreate') }]}
                onChange={chooseMode}
              /> : null}
              {create && !reviewingCreate && !embedded ? <Item title={reviewNotice ?? t('projects.deployments.platformLink.createConsequences')} showChevron={false} /> : null}
              {props.onPrepared ? null : <DropdownMenu
                testID="project-deployments.platform.choice"
                open={platformMenuOpen}
                onOpenChange={setPlatformMenuOpen}
                items={platformItems}
                selectedId={target.key}
                onSelect={choosePlatform}
                itemTrigger={{
                  title: t('projects.deployments.platformLink.platform'),
                  showSelectedSubtitle: false,
                  itemProps: { disabled: busy !== null || reviewingCreate },
                }}
              />
              }
              {create && !outcomeUnknown && props.environment.controllerMachineId ? <Item mode="info" testID="project-deployments.platform.controller"
                title={t(provisioned ? 'projects.deployments.platformLink.finishLinkingOnMachine' : 'projects.deployments.platformLink.createOnMachine')} detail={controllerLabel ?? props.environment.controllerMachineId} /> : null}
              {connectionNeeded ? null : <ConnectedAccountPurposeTargetChooser
                key={target.key}
                testID="project-deployments.platform.account"
                localizedTextPluginId={form!.service.pluginId}
                declaration={{
                  purpose: form!.purpose,
                  service: form!.service,
                  // The credential this link uses; the provider's own account or team is a choice below it.
                  title: t('projects.deployments.platformLink.connection'),
                  required: true,
                }}
                value={account ? { kind: 'account', account } : null}
                // Create new says once what the connection means for deploys, as this row's description, instead of a
                // "Deploys use this connection" row restating the same account (PAGE-ACCEPT-176 R8-D4).
                {...(create && draft && !disclosedProvider ? { description: t(draft.credentialPrincipal.kind === 'team'
                  ? 'projects.deployments.platformLink.connectionTeamNote'
                  : 'projects.deployments.platformLink.connectionPersonalNote') } : {})}
                accountsOnly
                addAccount={{ label: t('projects.deployments.platformLink.connectAction', { platform: target.title }), onPress: connect }}
                disabled={busy !== null || reviewingCreate}
                onChange={(next) => {
                  setAccount(next?.kind === 'account' ? next.account : null);
                  resetValues();
                  setCursors({});
                  resetFrom();
                }}
                // The only eligible connection is chosen for the person, as Add domain does (PAGE-ACCEPT-176 R7-D2).
                onSelectSingleEligible={selectSoleConnection}
              />}
              {!create && sourceMethod && !connectionNeeded ? <DeploymentSourceMethodChoice
                methods={target.sourceMethods}
                value={sourceMethod}
                disabled={busy !== null || reviewingCreate}
                testID="project-deployments.platform.sourceMethod"
                onChange={(method) => { setSourceMethod(method); resetFrom(); }}
              /> : null}
              {/* Each provider choice is a row of the same sheet: the row names it, the control draws no label. */}
              {draft && !connectionNeeded
                ? visibleFields.map((field) => {
                    const more = options.state(field).nextCursor !== undefined;
                    const back = (cursors[field.path]?.length ?? 0) > 0;
                    return (
                      <React.Fragment key={field.path}>
                        <Item
                          testID={`project-deployments.platform.row:${field.path}`}
                          title={field.title ?? field.path}
                          showChevron={false}
                          accessoryLayout="adaptive"
                          rightElement={
                            <ActionInputFields
                              fields={[field]}
                              input={values as Record<string, unknown>}
                              editable={busy === null && !reviewingCreate}
                              busy={busy !== null}
                              frame="none"
                              resolveFieldOptions={resolveOptions}
                              resolveChoiceAction={field => fieldCreation.choiceAction(field, resolveOptions)}
                              resolveOptionsEmptyAction={field => field.required ? emptyChoiceLead : undefined}
                              resolveFieldTestID={(entry) =>
                                `project-deployments.platform.field:${entry.path}`
                              }
                              onPatch={patch}
                            />
                          }
                        />
                        {more || back ? (
                          <View style={styles.paging}>
                            {back ? (
                              <SectionActionButton
                                testID={`project-deployments.platform.previous:${field.path}`}
                                title={t('projects.deployments.pagePrevious')}
                                icon="caret-left"
                                onPress={() => page(field, 'previous')}
                              />
                            ) : null}
                            {more ? (
                              <SectionActionButton
                                testID={`project-deployments.platform.next:${field.path}`}
                                title={t('projects.deployments.pageNext')}
                                icon="caret-right"
                                onPress={() => page(field, 'next')}
                              />
                            ) : null}
                          </View>
                        ) : null}
                      </React.Fragment>
                    );
                  })
                : null}
              {draft && optionRefusal ? (
                <SurfaceStateCard testID="project-deployments.platform.choicesFailed"
                  size="line" kind="error"
                  title={optionRefusal.field.title ?? optionRefusal.field.path}
                  reason={optionRecovery?.remedy ?? t('projects.deployments.platformLink.choicesFailedBody')}
                  diagnosticCode={optionRefusal.diagnostic?.reason ?? optionRefusal.code}
                  action={optionRecovery && (props.onOpenRecoveryDestination || optionRecovery.nextAction.destination === 'machines') ? {
                    label: optionRecovery.nextAction.label,
                    onPress: () => {
                      if (props.onOpenRecoveryDestination) {
                        onClose();
                        props.onOpenRecoveryDestination(optionRecovery.nextAction.destination);
                      } else router.pushRetainingCurrent(SETTINGS_ROUTES.machines);
                    },
                  } : { label: t('common.retry'), onPress: () => options.retry() }}
                />
              ) : null}
            </ItemGroup>
            {props.onPrepared && create && draft && !connectionNeeded && reviewMissing && !drawn.failure ? (
              <SurfaceStateCard testID="project-deployments.platform.reviewMissing" size="line" kind="unavailable"
                title={reviewMissing} />
            ) : null}
            {/* One cause, one message: a failed choices read is the sheet's message, not a stale Check result too. */}
            {drawn.failure ? null : <DeploymentPlatformInspectState outcome={outcome}
              {...(props.onOpenRecoveryDestination ? { onOpenRecovery: (destination: DeploymentFailureRecoveryDestinationV1) => {
                onClose();
                props.onOpenRecoveryDestination?.(destination);
              } } : {})} />}
          </>
        )}
        {!createdBranchOutcome && disclosedProvider ? <DeploymentPlatformCredentialDisclosure principal={disclosedProvider.credentialPrincipal}
          provider={disclosedProvider.providerIdentity} platform={target?.title ?? t('projects.deployments.platformLink.platform')} scope={props.lifetime.scope}
          lifetime={props.lifetime} serverId={props.lifetime.scope.serverId} testIDPrefix="project-deployments.platform.access" /> : null}
        {unresolvedLink && recoveryReadRefused ? <SurfaceStateCard testID="project-deployments.platform.recoveryUnavailable" size="line" kind="error"
          title={t('projects.deployments.platformLink.recoveryUnavailable')} diagnosticCode={recoveryReadRefused} /> : pendingLink || unresolvedLink ? <SurfaceStateCard testID="project-deployments.platform.pending" size="line" kind="loading"
          title={t('common.loading')} /> : null}
        {provisioned ? <SurfaceStateCard testID="project-deployments.platform.provisioned" size="line" kind="error"
          title={t('projects.deployments.platformLink.provisioned')}
          {...(provisionedSourceRefusal ? {} : { action: { label: t('projects.deployments.platformLink.finishLinking'),
            onPress: () => { void createOrFinish(); }, disabled: busy !== null } })} /> : null}
        {providerUrl ? <ItemGroup header="none">
          <Item testID="project-deployments.platform.openProvider" title={t('projects.deployments.platformLink.openProvider')}
            onPress={() => requestOpenExternalUrl(providerUrl, { serverId: props.lifetime.scope.serverId, expectedAccountId: props.lifetime.scope.accountId })} />
        </ItemGroup> : null}
        {outcomeUnknown ? <SurfaceStateCard testID="project-deployments.platform.outcomeUnknown" size="line" kind="error"
          title={t('projects.deployments.platformLink.outcomeUnknown')}
          reason={t('projects.deployments.platformLink.outcomeUnknownBody')} /> : null}
        {duplicate ? <ItemGroup header="none">
          <SurfaceStateCard testID="project-deployments.platform.duplicate" size="line" kind="error"
            title={t('projects.deployments.platformLink.duplicate')}
            action={{ label: t('projects.deployments.platformLink.useExisting'), onPress: () => {
              onClose(); router.push(deploymentEnvironmentRoute(duplicate.environment));
            } }} />
          <Item title={t('projects.deployments.platformLink.chooseAnother')} onPress={() => {
            setLinkSettlement(null); setRequestKey(null); setAccount(null); resetValues(); setCursors({}); resetFrom();
          }} />
        </ItemGroup> : null}
        {linkRefused?.code === 'needsGitAccess' ? (
          <DeploymentPlatformInspectState outcome={null} refusal={linkRefused} />
        ) : linkRefused ? (
          <SurfaceStateCard
            testID="project-deployments.platform.linkRefused"
            size="line"
            kind="error"
            title={t('projects.deployments.platformLink.linkRefused')}
            reason={readDeploymentConnectionPermissionRemedy(linkRefused.code, linkRefused.details)
              ?? readDeploymentRefusalRecovery(linkRefused.code, linkRefused.details)?.remedy
              ?? (linkRefused.code === DEPLOYMENT_TARGET_REQUIRES_REPOSITORY_DEFINITION
                ? deploymentActionRefusalRemedy(linkRefused.code)
                : readDeploymentRefusal(linkRefused.code).reason === 'permission'
                  ? t('projects.deployments.platformLink.managersOnly') : t('projects.deployments.nothingChanged'))}
            diagnosticCode={linkRefused.code}
          />
        ) : null}
        {/* Without card chrome the section title carries the action; only a created branch's Done ends the body. */}
        {embedded && createdBranchOutcome ? footer : null}
      </View>
    </ListPresentationProvider>
  );
}

export function showDeploymentPlatformTargetSheet(
  input: DeploymentPlatformTargetSheetInput,
): void {
  showDeploymentSheet({
    component: DeploymentPlatformTargetEditor,
    props: input,
    title: t('projects.deployments.platformLink.title', { name: input.name }),
    testID: 'project-deployments.platform.modal',
  });
}

const styles = StyleSheet.create((theme) => ({
  embedded: { gap: theme.space.s16 },
  paging: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s8,
  },
}));
