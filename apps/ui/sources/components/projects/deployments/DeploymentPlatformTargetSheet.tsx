import * as React from 'react';
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
import type { DeploymentSourceMethodV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentTargetLinkProviderContentV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import type { DeploymentFailureRecoveryDestinationV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

import {
  ActionInputFields,
  getValueAtPath,
} from '@/components/sessions/actions/ActionInputFields';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { connectedAccountPurposeServiceTargets } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { useProfile, useServerScopedMachineLabel } from '@/sync/store/hooks';
import { DeploymentPlatformCredentialDisclosure, DeploymentPlatformCredentialPrincipal } from './DeploymentPlatformCredentialDisclosure';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readProjectRepositoryIdentityV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { t } from '@/text';

import { readDeploymentActionError, readDeploymentRefusal } from './deploymentActionOutcome';
import type { createDeploymentActions } from './deploymentActions';
import { DeploymentSourceMethodChoice } from './DeploymentSourceMethodChoice';
import { DeploymentPlatformInspectState } from './DeploymentPlatformInspectState';
import {
  buildPlatformTargetDraft,
  buildPlatformTargetLinkInput,
  readDeploymentPlatformTargets,
  readPlatformInspectOutcome,
  type PlatformInspectOutcome,
  applyPlatformFieldPatch,
  disclosePlatformFields,
  drawPlatformFields,
} from './platformTargetLink';

type Actions = ReturnType<typeof createDeploymentActions>;
type LinkRefusal = Extract<Awaited<ReturnType<Actions['link']>>, { ok: false }>
  | Readonly<{ ok: false; error: 'action_outcome_unknown' }>;
export type DeploymentPlatformLinkActions = Pick<
  Actions,
  'inspectPlatformTarget' | 'link'
>;

export type DeploymentPlatformTargetSheetInput = Readonly<{
  name: string;
  environment: Readonly<{
    id: string;
    revision: number;
    projectSourceId: string;
    controllerMachineId?: string;
  }>;
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

/** The plugins' own deployment targets, loaded only while a draft or this sheet asks for them. */
export function useDeploymentTargetDeclarations(lifetime: ServerAccountScopeLifetime | null) {
  const [state, setState] = React.useState<TargetDeclarationsState>({
    status: 'loading',
  });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!lifetime) return;
    let live = true;
    setState((previous) =>
      previous.status === 'ready' ? previous : { status: 'loading' },
    );
    let stopWaiting: (() => void) | null = null;
    const reader = readPluginAccountAvailability(lifetime.scope);
    reader
      .ensureCurrentAccountExecutionDeclarations({
        family: 'deploymentTargets',
      })
      .then((result) => {
        if (!live) return;
        if (result.kind === 'available') {
          setState({ status: 'ready', declarations: result.declarations });
          return;
        }
        // Availability that has not arrived for this Account yet (not loaded, still the previous Account's, or a
        // declaration still pending) is not a refusal: keep loading and read again once it changes.
        if (result.code === 'account_availability_not_loaded' || result.code === 'account_availability_scope_mismatch'
          || result.code === 'plugin_ui_declaration_pending') {
          stopWaiting = reader.subscribe(() => {
            stopWaiting?.();
            stopWaiting = null;
            if (live) setAttempt((value) => value + 1);
          });
          return;
        }
        setState({ status: 'failed', code: result.code });
      })
      .catch((error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (live)
          setState({
            status: 'failed',
            code: typeof code === 'string' && code ? code : 'unknown_error',
          });
      });
    return () => {
      live = false;
      stopWaiting?.();
    };
  }, [lifetime, attempt]);
  return {
    state,
    retry: React.useCallback(() => setAttempt((value) => value + 1), []),
  };
}

/** Runtime and data pickers consume the same Account deployment-target declaration acquisition. */
export function useDeploymentPlatformTargets(lifetime: ServerAccountScopeLifetime | null) {
  const { state, retry } = useDeploymentTargetDeclarations(lifetime);
  const projected = React.useMemo(() => state.status === 'ready'
    ? { status: 'ready' as const, targets: readDeploymentPlatformTargets(state.declarations) } : state, [state]);
  return { state: projected, retry };
}

type PlatformTargetSource = Readonly<{ contribution: Readonly<{ pluginId: string; localId: string }> }>;
const NO_TITLES: ReadonlyMap<string, string> = new Map();
const titleKey = (pluginId: string, localId: string) => `${pluginId}/${localId}`;

/**
 * Platform targets' own names (Vercel, Cloudflare Pages), read once from the Account's deployment-target
 * declarations while `wanted`. Every Environment row, header and Settings row names its platform through this.
 */
export function useDeploymentPlatformTargetTitles(lifetime: ServerAccountScopeLifetime | null, wanted: boolean) {
  const [titles, setTitles] = React.useState<ReadonlyMap<string, string>>(NO_TITLES);
  React.useEffect(() => {
    if (!lifetime || !wanted) return;
    let live = true;
    void readPluginAccountAvailability(lifetime.scope)
      .ensureCurrentAccountExecutionDeclarations({ family: 'deploymentTargets' })
      .then((result) => {
        if (!live || result.kind !== 'available') return;
        setTitles(new Map(readDeploymentPlatformTargets(result.declarations)
          .map((target) => [titleKey(target.pluginId, target.targetId), target.title])));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lifetime, wanted]);
  return React.useCallback(
    (source: PlatformTargetSource) => titles.get(titleKey(source.contribution.pluginId, source.contribution.localId)) ?? null,
    [titles],
  );
}

const EMPTY_VALUES: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Prepare a platform target inline in the draft, or link one from an existing Environment:
 * choose a target from the plugins' declarations, the connected account it uses, and the project, environment
 * and product through the provider's own choices. Check reads the provider only; Link records exactly what the
 * check returned. Linking deploys nothing; the next Deploy does.
 */
export function DeploymentPlatformTargetEditor(
  props: Omit<DeploymentPlatformTargetSheetInput, 'environment'> & CustomModalInjectedProps & Readonly<{
    environment: Readonly<{ id?: string; revision?: number; projectSourceId: string; controllerMachineId?: string }>;
    /** Drafts review the same provider result in place; the creating page commits the association. */
    onPrepared?: (provider: DeploymentTargetLinkProviderContentV1 | null) => void;
  }>,
) {
  const shouldContinue = useMountedShouldContinue();
  const router = useRouter();
  const controllerLabel = useServerScopedMachineLabel(props.lifetime.scope.serverId, props.environment.controllerMachineId ?? null);
  const [mode, setMode] = React.useState<'existing' | 'create'>('existing');
  const [requestKey, setRequestKey] = React.useState<string | null>(null);
  const [linkSettlement, setLinkSettlement] = React.useState<LinkRefusal | null>(null);
  const [recoveryReadRefused, setRecoveryReadRefused] = React.useState<string | null>(null);
  const provisioned = linkSettlement?.error === 'deployment_link_incomplete' ? linkSettlement.recovery : null;
  const outcomeUnknown = linkSettlement?.error === 'action_outcome_unknown';
  const duplicate = linkSettlement?.error === 'provider_scope_already_linked' ? linkSettlement : null;
  const reviewingCreate = provisioned !== null || outcomeUnknown;
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
        // A later Environment edit supersedes this exact reviewed association. Add can start a fresh choice.
        if (result && !result.ok && result.error === 'deployment_link_incomplete'
          && result.recovery.expectedRevision !== props.environment.revision) return [];
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
      if (!result.ok && result.error === 'deployment_link_incomplete') {
        setTargetKey(`${result.recovery.source.contribution.pluginId}/${result.recovery.source.contribution.localId}`);
        setMode('create');
      }
      const association = orphans.includes(selected) ? linkOperations.filter(operation => operation.snapshot.domainRef?.kind === 'deploymentTargetLink'
        && operation.snapshot.domainRef.purpose === 'associate' && operation.snapshot.domainRef.requestKey === selected.domain.requestKey)
        .reduce<(typeof linkOperations)[number] | null>((latest, operation) =>
          !latest || operation.snapshot.createdAt > latest.snapshot.createdAt ? operation : latest, null) : null;
      setLinkRefused(association?.snapshot.error?.errorCode ?? (!result.ok && result.error !== 'deployment_link_incomplete'
        && result.error !== 'provider_scope_already_linked' && result.error !== 'action_outcome_unknown' ? result.error : null));
    });
    return () => { live = false; };
  }, [linkOperations, props.environment.revision]);
  const { state: platformsState, retry: retryPlatforms } =
    useDeploymentPlatformTargets(props.lifetime);
  const targets =
    platformsState.status === 'ready' ? platformsState.targets : [];
  const [targetKey, setTargetKey] = React.useState<string | null>(props.initialTargetKey ?? null);
  const target = provisioned
    ? targets.find(entry => entry.pluginId === provisioned.source.contribution.pluginId && entry.targetId === provisioned.source.contribution.localId) ?? null
    : targets.find((entry) => entry.key === targetKey) ?? targets[0] ?? null;
  const create = mode === 'create' && !props.onPrepared && props.environment.id && props.environment.revision !== undefined ? target?.create : undefined;
  const form = React.useMemo(() => create && target
    ? { ...target, ...create, inspectLocalId: create.localId, inspectActionId: create.actionId } : target, [target, create]);
  const [selectedMethod, setSourceMethod] = React.useState<DeploymentSourceMethodV1>('gitIntegration');
  const sourceMethod = target?.sourceMethods.includes(selectedMethod) ? selectedMethod : target?.sourceMethods[0];
  const [platformMenuOpen, setPlatformMenuOpen] = React.useState(false);
  const [account, setAccount] =
    React.useState<QualifiedConnectedAccountRef | null>(null);
  const [values, setValues] =
    React.useState<Readonly<Record<string, unknown>>>(EMPTY_VALUES);
  // One page of choices per field; Previous walks back the cursors this field was asked with.
  const [cursors, setCursors] = React.useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const [outcome, setOutcome] = React.useState<PlatformInspectOutcome | null>(
    null,
  );
  const [busy, setBusy] = React.useState<'check' | 'link' | null>(null);
  const [linkRefused, setLinkRefused] = React.useState<string | null>(null);
  // The Account's own inventory decides whether it has any account for this platform; unknown until it is read.
  const accountId = props.lifetime.scope.accountId;
  const service = form?.service ?? null;
  const hasServiceAccount = useProfile((profile) => profile.id !== accountId || !service ? null
    : connectedAccountPurposeServiceTargets(profile.connectedAccountsV4 ?? [], [], service).accounts.length > 0);
  const needsConnect = target !== null && account === null && hasServiceAccount === false;
  const source =
    useProjectSource(props.lifetime, props.environment.projectSourceId).source
      ?.source ?? null;
  const repository = React.useMemo(
    () => readProjectRepositoryIdentityV1({ source }),
    [source],
  );

  const draft = React.useMemo(
    () =>
      form && account
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
      { inputHints: { fields: [...form.fields] } }, draft ?? values,
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
    enabled: draft !== null,
    serverId: props.lifetime.scope.serverId,
    accountLifetime: props.lifetime,
  });
  // One failed read is said once, at the sheet; an optional choice this target has nothing for is not drawn.
  const drawn = drawPlatformFields(fields, values, (field) => options.state(field), (field) => (cursors[field.path]?.length ?? 0) > 0);
  const visibleFields = drawn.fields;
  const missing = fields.some(
    (field) =>
      field.required && getValueAtPath(values, field.path) === undefined,
  );

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
  const patch = (next: Record<string, unknown>) => {
    const { values: kept, changedIndex: changed } = applyPlatformFieldPatch(effectiveFields, values, next);
    setValues(kept);
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
  // Add a token runs the one shared connect flow for this service; its account becomes this link's account,
  // and the platform's own choices and Check (what the token can do) follow in place.
  const connect = async () => {
    if (!target) return;
    const result = await presentConnectSheet({ scope: props.lifetime.scope, service: form?.service ?? target.service, intent: 'add' });
    if (result.kind === 'dismissed' || !props.lifetime.isCurrent()) return;
    setAccount(result.account);
    resetValues();
    setCursors({});
    resetFrom();
  };
  const check = async () => {
    if (!target || !draft || busy) return;
    setBusy('check');
    setLinkRefused(null);
    const result = await actions.inspectPlatformTarget(
      target.inspectActionId,
      draft,
      props.environment.controllerMachineId ? { externalActionTarget: { kind: 'machine', machineId: props.environment.controllerMachineId } } : undefined,
    );
    if (!shouldContinue()) return;
    setBusy(null);
    const inspected = readPlatformInspectOutcome(result, sourceMethod);
    setOutcome(inspected);
    props.onPrepared?.(inspected.kind === 'ready' ? inspected.provider : null);
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
      else setLinkRefused(result.error);
    } catch (error) {
      const read = readDeploymentActionError(error);
      if (read.kind === 'approval') {
        onClose();
        onApproval(read.artifactId);
        return;
      }
      setLinkRefused(read.kind === 'refused' ? read.code : 'unknown_error');
    } finally {
      setBusy(null);
    }
  };

  const createOrFinish = async () => {
    if (busy || (!provisioned && (pendingLink || unresolvedLink)) || outcomeUnknown || !props.environment.id || props.environment.revision === undefined) return;
    setBusy('link');
    setLinkRefused(null);
    try {
      let input: Parameters<Actions['link']>[0];
      if (provisioned) input = provisioned;
      else {
        if (!target || !create || !draft) return;
        const key = requestKey ?? randomUUID();
        setRequestKey(key);
        const { DeploymentTargetLinkCreateIntentInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
        const { v: _v, serverId: _serverId, environmentId: _environmentId, expectedRevision: _revision, ...providerCreate } = draft;
        const parsed = DeploymentTargetLinkCreateIntentInputV1Schema.safeParse({
          serverId: props.lifetime.scope.serverId, environmentId: props.environment.id,
          expectedRevision: props.environment.revision, requestKey: key, targetId: target.targetId,
          role: 'runtime', targetKind: target.targetKind, machines: [],
          source: { kind: 'plugin', contribution: { pluginId: target.pluginId, localId: target.targetId } }, providerCreate,
        });
        if (!parsed.success) { setLinkRefused('invalid_parameters'); return; }
        input = parsed.data;
      }
      const result = await actions.link(input, { confirmed: true });
      if (!shouldContinue()) return;
      if (result.ok) { setLinkSettlement(null); onClose(); return; }
      if (result.error === 'deployment_link_incomplete' || result.error === 'provider_scope_already_linked') setLinkSettlement(result);
      else setLinkRefused(result.error);
    } catch (error) {
      const read = readDeploymentActionError(error);
      if (read.kind === 'approval') { onClose(); onApproval(read.artifactId); return; }
      if (read.kind === 'refused' && isActionOutcomeUnknownErrorCodeV1(read.code) && !provisioned) setLinkSettlement({ ok: false, error: 'action_outcome_unknown' });
      else setLinkRefused(read.kind === 'refused' ? read.code : 'unknown_error');
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
  const footer = (
    <ModalCardFooterActions {...(props.onPrepared ? {} : { cancel: { onPress: onClose, testID: 'project-deployments.platform.cancel', disabled: busy !== null } })}>
      {provisioned || outcomeUnknown || duplicate || pendingLink || unresolvedLink ? null : <RoundButton
        testID={
          create ? 'project-deployments.platform.create' :
          ready && !props.onPrepared
            ? 'project-deployments.platform.link'
            : 'project-deployments.platform.check'
        }
        size="normal"
        loading={busy !== null}
        disabled={busy !== null || !draft || !target || missing || needsConnect || !drawn.canCheck}
        title={
          create ? t('projects.deployments.platformLink.create', { platform: target?.title ?? '' }) : ready && target && !props.onPrepared
            ? t('projects.deployments.platformLink.link', {
                platform: target.title,
              })
            : outcome
              ? t('projects.deployments.platformLink.checkAgain')
              : t('projects.deployments.platformLink.check')
        }
        onPress={() => {
          void (create ? createOrFinish() : ready && !props.onPrepared ? link() : check());
        }}
      />}
    </ModalCardFooterActions>
  );
  const { setChrome } = props;
  React.useEffect(() => {
    setChrome?.({ kind: 'card', footer });
  });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);

  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="project-deployments.platform" style={deploymentSheetStyles.body}>
        {props.onPrepared ? null : <Text style={deploymentSheetStyles.lead}>
          {t('projects.deployments.platformLink.lead')}
        </Text>}
        {reviewingCreate && !target ? null : platformsState.status === 'loading' ? (
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
            <ItemGroup header="none">
              {target.create && !props.onPrepared && props.environment.id && props.environment.revision !== undefined ? <SegmentedChoiceItem<'existing' | 'create'>
                testID="project-deployments.platform.mode" title={t('projects.deployments.platformLink.platform')}
                value={mode} disabled={busy !== null || reviewingCreate}
                options={[{ id: 'existing', label: t('projects.deployments.platformLink.modeExisting') },
                  { id: 'create', label: t('projects.deployments.platformLink.modeCreate') }]}
                onChange={(next) => { setMode(next); setAccount(null); resetValues(next === 'create' ? target.create?.fields ?? null : null); setCursors({}); resetFrom(); }}
              /> : null}
              {create && !reviewingCreate ? <Item title={t('projects.deployments.platformLink.createConsequences')} showChevron={false} /> : null}
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
              {create && draft && !disclosedProvider ? <DeploymentPlatformCredentialPrincipal principal={draft.credentialPrincipal}
                platform={target.title} scope={props.lifetime.scope} lifetime={props.lifetime}
                serverId={props.lifetime.scope.serverId} testIDPrefix="project-deployments.platform.access" /> : null}
              {create && !outcomeUnknown && props.environment.controllerMachineId ? <Item mode="info" testID="project-deployments.platform.controller"
                title={t(provisioned ? 'projects.deployments.platformLink.finishLinkingOnMachine' : 'projects.deployments.platformLink.createOnMachine')} detail={controllerLabel ?? props.environment.controllerMachineId} /> : null}
              {needsConnect ? null : <ConnectedAccountPurposeTargetChooser
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
                accountsOnly
                disabled={busy !== null || reviewingCreate}
                onChange={(next) => {
                  setAccount(next?.kind === 'account' ? next.account : null);
                  resetValues();
                  setCursors({});
                  resetFrom();
                }}
              />}
              {!create && sourceMethod ? <DeploymentSourceMethodChoice
                methods={target.sourceMethods}
                value={sourceMethod}
                disabled={busy !== null || reviewingCreate}
                testID="project-deployments.platform.sourceMethod"
                onChange={(method) => { setSourceMethod(method); resetFrom(); }}
              /> : null}
              {/* Each provider choice is a row of the same sheet: the row names it, the control draws no label. */}
              {draft
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
                              resolveFieldOptions={options.resolveOptions}
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
            </ItemGroup>
            {draft && drawn.failure ? (
              <SurfaceStateCard
                testID="project-deployments.platform.choicesFailed"
                size="line"
                kind="error"
                title={t('projects.deployments.platformLink.choicesFailed', { platform: target.title })}
                reason={t('projects.deployments.platformLink.choicesFailedBody')}
                diagnosticCode={drawn.failure.code}
                action={{ label: t('common.retry'), onPress: () => options.retry() }}
              />
            ) : null}
            {needsConnect ? (
              <EmptyState
                testID="project-deployments.platform.connect"
                layout="centered"
                icon={<PluginMark title={target.title} pluginId={target.pluginId} />}
                title={t('projects.deployments.platformLink.connectTitle', { platform: target.title })}
                subtitle={t('projects.deployments.platformLink.connectBody', { platform: target.title })}
                primaryAction={{
                  label: t('projects.deployments.platformLink.connectAction', { platform: target.title }),
                  onPress: connect,
                  testID: 'project-deployments.platform.connect.add',
                }}
              />
            ) : null}
            {/* One cause, one message: a failed choices read is the sheet's message, not a stale Check result too. */}
            {drawn.failure ? null : <DeploymentPlatformInspectState outcome={outcome}
              {...(props.onOpenRecoveryDestination ? { onOpenRecovery: (destination: DeploymentFailureRecoveryDestinationV1) => {
                onClose();
                props.onOpenRecoveryDestination?.(destination);
              } } : {})} />}
          </>
        )}
        {disclosedProvider ? <DeploymentPlatformCredentialDisclosure principal={disclosedProvider.credentialPrincipal}
          provider={disclosedProvider.providerIdentity} platform={target?.title ?? t('projects.deployments.platformLink.platform')} scope={props.lifetime.scope}
          lifetime={props.lifetime} serverId={props.lifetime.scope.serverId} testIDPrefix="project-deployments.platform.access" /> : null}
        {unresolvedLink && recoveryReadRefused ? <SurfaceStateCard testID="project-deployments.platform.recoveryUnavailable" size="line" kind="error"
          title={t('projects.deployments.platformLink.recoveryUnavailable')} diagnosticCode={recoveryReadRefused} /> : pendingLink || unresolvedLink ? <SurfaceStateCard testID="project-deployments.platform.pending" size="line" kind="loading"
          title={t('common.loading')} /> : null}
        {provisioned ? <SurfaceStateCard testID="project-deployments.platform.provisioned" size="line" kind="error"
          title={t('projects.deployments.platformLink.provisioned')}
          action={{ label: t('projects.deployments.platformLink.finishLinking'), onPress: () => { void createOrFinish(); }, disabled: busy !== null }} /> : null}
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
        {linkRefused ? (
          <SurfaceStateCard
            testID="project-deployments.platform.linkRefused"
            size="line"
            kind="error"
            title={t('projects.deployments.platformLink.linkRefused')}
            reason={readDeploymentRefusal(linkRefused).reason === 'permission'
              ? t('projects.deployments.platformLink.managersOnly')
              : t('projects.deployments.nothingChanged')}
            diagnosticCode={linkRefused}
          />
        ) : null}
        {/* Without card chrome (an embedding host), the footer ends the body. */}
        {setChrome ? null : footer}
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
  paging: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s8,
  },
}));
