import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { EffectiveActionInputField } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { DeploymentEnvironmentCopyProvisionV1Schema, type DeploymentEnvironmentCopyProvisionV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentCopyV1';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { isRecord } from '@happier-dev/protocol/common/records';
import { environmentSecretBindingIdentityV1, type EnvironmentVariableBindingInputV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentBindingReplacementChoices } from './DeploymentBindingReplacementChoices';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { ActionInputFields, getValueAtPath } from '@/components/sessions/actions/ActionInputFields';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { useFirstConnection } from './useFirstConnection';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { useActionFieldCreation } from '@/components/sessions/actions/useActionFieldCreation';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import type { createDeploymentActions } from './deploymentActions';
import { useDeploymentTargetDeclarations } from './DeploymentPlatformTargetSheet';
import { buildPlatformTargetDraft, buildPlatformTargetLinkInput, applyPlatformFieldPatch, disclosePlatformFields } from './platformTargetLink';
import { buildPreviewBranchReadInput } from './previewDatabaseBranches';
import { managedDataConnections, managedDataLinkContent, managedDataTargets, readManagedDataAdoptionReceipt, type ManagedDataOperation, type ManagedDataTarget } from './managedData';
import { deploymentSheetStyles } from './deploymentSheet';
import { isActionExecuteFailure, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { readDeploymentActionError } from './deploymentActionOutcome';
import { useManagedDataForm } from './useManagedDataForm';

export type DeploymentManagedDataInput = Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  lifetime: ServerAccountScopeLifetime;
  actions: Pick<ReturnType<typeof createDeploymentActions>, 'inspectPlatformTarget' | 'link' | 'setBindings'>;
  linked?: DeploymentEnvironmentReadDetailV1['targetLinks'][number];
  onApproval: (artifactId: string) => void;
}>;

type Result = Readonly<{ value: unknown; input: Record<string, unknown>; role: ManagedDataOperation['role'] }>;

/** Provider-owned operations share the existing Action form, credential chooser and deployment front door. */
export function DeploymentManagedDataSheet(props: DeploymentManagedDataInput & CustomModalInjectedProps) {
  const { state, retry } = useDeploymentTargetDeclarations(props.lifetime);
  const shouldContinue = useMountedShouldContinue();
  const targets = React.useMemo(() => state.status === 'ready' ? managedDataTargets(state.declarations) : [], [state]);
  const linkedSource = props.linked?.targetLink.source;
  const linkedKey = linkedSource?.kind === 'plugin' ? `${linkedSource.contribution.pluginId}/${linkedSource.contribution.localId}` : null;
  const [targetKey, setTargetKey] = React.useState<string | null>(linkedKey);
  const target = targets.find(entry => entry.key === targetKey) ?? (linkedKey ? null : targets[0]) ?? null;
  const operations = target?.operations.filter(entry => props.linked || entry.role.startsWith('projects.')) ?? [];
  const [selectedRole, setRole] = React.useState<string | null>(null);
  // Adding a database starts from creating one; reading the provider's projects is the way to link an existing one.
  const operation = operations.find(entry => entry.role === selectedRole)
    ?? (props.linked ? undefined : operations.find(entry => entry.role === 'projects.provision')) ?? operations[0] ?? null;
  const { account, setAccount, setValues, seeded } = useManagedDataForm(operation, props.lifetime);
  // A fresh Account has no account for this provider yet: the one shared Connect flow adds the first (as platform-link).
  const firstConnection = useFirstConnection(props.lifetime, props.linked ? null : operation?.credential?.service ?? null,
    connected => { setAccount(connected); reset(); });
  const needsConnect = account === null && firstConnection.missing;
  const [results, setResults] = React.useState<Readonly<Record<string, Result>>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ActionExecuteFailure | null>(null);
  const [bound, setBound] = React.useState(false);
  const [replace, setReplace] = React.useState<readonly string[]>([]);
  const [operationOpen, setOperationOpen] = React.useState(false);
  const [cursors, setCursors] = React.useState<readonly string[]>([]);
  const [fieldCursors, setFieldCursors] = React.useState<Readonly<Record<string, readonly string[]>>>({});
  const [requestKey, setRequestKey] = React.useState(randomUUID);
  const adoption = readManagedDataAdoptionReceipt(results['projects.provision']?.value);
  const result = operation ? results[operation.role] : undefined;
  const value = result?.value;
  const saved = isRecord(value) && isRecord(value.connectionSave) ? value.connectionSave : value;
  const partial = isRecord(saved) && saved.status === 'partial';
  const complete = isRecord(saved) && saved.status === 'complete';
  const connections = managedDataConnections(value);
  const connectionBindings: EnvironmentVariableBindingInputV1[] = connections.map(connection => ({ purpose: 'variable',
    phase: 'runtime', name: connection.name, source: { kind: 'secret', ref: connection.ref, resourceRevision: connection.resourceRevision } }));
  const existingBindings = new Map((props.detail.content.bindings ?? []).map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
  const replaceKeys = connectionBindings.filter(binding => {
    const existing = existingBindings.get(environmentSecretBindingIdentityV1(binding));
    return existing !== undefined && !sameStrictJsonValue(existing, binding);
  }).map(binding => binding.name);
  const replacementsReviewed = replaceKeys.every(name => replace.includes(name));
  const uncertain = Object.values(results).some(entry => (entry.role === 'projects.provision' || entry.role === 'branches.create')
    && isRecord(entry.value) && entry.value.status === 'outcome_unknown');
  const optionsOperation = operations.find(entry => entry.role === 'projects.provisionOptions');
  const reviewing = operation?.role === 'projects.provision' && optionsOperation !== undefined && !results['projects.provisionOptions'];
  const runOperation = reviewing ? optionsOperation : operation;
  const linkedInput = props.linked ? buildPreviewBranchReadInput(props.detail, props.linked) : null;
  const draftFor = (entry: ManagedDataOperation): Record<string, unknown> | null => {
    const product = managedDataOperationOperands(entry, seeded, requestKey);
    if (props.linked) return linkedInput ? { ...product, ...linkedInput,
      ...(partial && result?.role === entry.role ? { previous: saved } : {}) } : null;
    if (!target || !entry.credential || !account) return null;
    return buildManagedDataActionDraft({ target, operation: entry, lifetime: props.lifetime,
      environment: props.detail.environment, account, values: seeded, requestKey });
  };
  const draft = operation ? draftFor(operation) : null;
  const fields = React.useMemo(() => operation ? disclosePlatformFields(resolveEffectiveActionInputFields(operation, seeded), seeded) : [], [operation, seeded]);
  const editableFields = adoption ? fields.filter(field => !Object.hasOwn(adoption.scope, field.path)) : fields;
  const requiredFields = reviewing && optionsOperation ? resolveEffectiveActionInputFields(optionsOperation, seeded) : fields;
  const missing = requiredFields.some(field => field.required && (getValueAtPath(seeded, field.path) === undefined
    || getValueAtPath(seeded, field.path) === ''));
  const blockedCreate = uncertain && (operation?.role === 'projects.provision' || operation?.role === 'branches.create');
  const provider = result ? managedDataLinkContent(result.input.credentialPrincipal, value) : null;
  const canLink = provider && (result?.role === 'projects.link' || result?.role === 'projects.provision' || result?.role === 'branches.create');
  const serviceName = result?.role === 'projects.link' && isRecord(value) && typeof value.serviceName === 'string' ? value.serviceName : undefined;
  const inspectedService = adoption && canLink ? provider.providerIdentity.providerResourceId : null;
  const nextCursor = isRecord(value) && typeof value.nextCursor === 'string' ? value.nextCursor : null;
  const reset = () => { setResults({}); setError(null); setBound(false); setReplace([]); setCursors([]); setFieldCursors({}); setRequestKey(randomUUID()); };
  const patch = (next: Record<string, unknown>, createdScope = false) => {
    const patched = applyPlatformFieldPatch(fields, seeded, next);
    setValues(createdScope ? { ...patched.values, ...next } : patched.values);
    setError(null); setBound(false); setReplace([]); setCursors([]); setFieldCursors({});
    if (adoption) {
      setResults(current => ({ 'projects.provision': current['projects.provision']! }));
      return;
    }
    // Reviewed creation options belong to these operands; uncertain effects and saved halves remain visible.
    setResults(current => Object.fromEntries(Object.entries(current).filter(([, entry]) => {
      const savedConnections = isRecord(entry.value) && isRecord(entry.value.connectionSave) ? entry.value.connectionSave : entry.value;
      return isRecord(entry.value) && (entry.value.status === 'outcome_unknown'
        || isRecord(savedConnections) && savedConnections.status === 'partial');
    })));
  };
  const approval = (artifactId: string) => { props.onClose(); props.onApproval(artifactId); };
  const run = async (page: readonly string[] = cursors) => {
    if (!runOperation || !target || busy || blockedCreate) return;
    // A partial save retries the exact reviewed resource and audience, carrying the provider continuation.
    const input = partial && result?.role === runOperation.role ? { ...result.input, previous: saved } : draftFor(runOperation);
    if (!input) return;
    setBusy(true); setError(null);
    try {
      const response = await props.actions.inspectPlatformTarget(runOperation.actionId,
        { ...input, ...(page.at(-1) ? { cursor: page.at(-1) } : {}) },
        { externalActionTarget: { kind: 'machine', machineId: props.detail.environment.controllerMachineId } });
      if (!shouldContinue()) return;
      if (!response.ok) {
        if (response.approvalArtifactId) approval(response.approvalArtifactId);
        else setError({ ...response, errorCode: response.code, error: response.code });
        return;
      }
      setCursors(page);
      setBound(false); setReplace([]);
      const next = { value: response.value, input, role: runOperation.role };
      const receipt = runOperation.role === 'projects.provision' ? readManagedDataAdoptionReceipt(response.value) : null;
      if (receipt && operations.some(entry => entry.role === 'projects.link')) {
        setValues({ ...seeded, ...receipt.scope, serviceId: undefined });
        setRole('projects.link');
        setFieldCursors({});
        setResults({ [runOperation.role]: next });
      } else {
        setResults(current => ({ ...current, [runOperation.role]: next }));
      }
    } catch (failure) {
      const outcome = readDeploymentActionError(failure);
      if (outcome.kind === 'approval') approval(outcome.artifactId);
      else if (outcome.kind === 'refused') setError(outcome.failure ?? { ok: false, errorCode: outcome.code, error: outcome.code });
    } finally { if (shouldContinue()) setBusy(false); }
  };
  const link = async () => {
    if (!target || !provider || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await props.actions.link(buildPlatformTargetLinkInput({
        target: { pluginId: target.pluginId, targetId: target.target.id, targetKind: target.target.targetKind },
        environment: props.detail.environment, provider, role: 'data', title: serviceName }), { confirmed: true });
      if (response.ok) props.onClose(); else setError(isActionExecuteFailure(response)
        ? response : { ok: false, errorCode: response.error, error: response.error, details: response });
    } catch (failure) {
      const outcome = readDeploymentActionError(failure);
      if (outcome.kind === 'approval') approval(outcome.artifactId); else if (outcome.kind === 'refused') setError(outcome.failure ?? { ok: false, errorCode: outcome.code, error: outcome.code });
    } finally { if (shouldContinue()) setBusy(false); }
  };
  const bind = async () => {
    if (busy || !complete || connections.length === 0 || !replacementsReviewed) return;
    setBusy(true); setError(null);
    try {
      const response = await props.actions.setBindings({ environmentId: props.detail.environment.id,
        expectedRevision: props.detail.environment.revision, set: connectionBindings, remove: [] });
      if (response.ok) setBound(true); else setError(isActionExecuteFailure(response)
        ? response : { ok: false, errorCode: response.error, error: response.error, details: response });
    } catch (failure) {
      const outcome = readDeploymentActionError(failure);
      if (outcome.kind === 'approval') approval(outcome.artifactId); else if (outcome.kind === 'refused') setError(outcome.failure ?? { ok: false, errorCode: outcome.code, error: outcome.code });
    } finally { if (shouldContinue()) setBusy(false); }
  };
  const footer = <ModalCardFooterActions cancel={{ onPress: props.onClose, disabled: busy }}>
    {canLink ? <RoundButton testID="managed-data.link" title={t('projects.deployments.managedData.link')}
      loading={busy} disabled={busy} onPress={() => { void link(); }} />
      // Until the provider is connected, Connect is the sheet's one action.
      : operation && !needsConnect ? <RoundButton testID="managed-data.run" title={reviewing ? t('projects.deployments.managedData.reviewCreate') : operation.title}
        loading={busy} disabled={busy || !draft || missing || Boolean(blockedCreate)}
        onPress={() => { void run(); }} /> : null}
  </ModalCardFooterActions>;
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  // Choices are what the person does, in their words: create, link, or find what is there. Reading creation
  // options is creation's own review step, never a choice beside it.
  const choices = operations.filter(entry => entry.role !== 'projects.provisionOptions' || !operations.some(other => other.role === 'projects.provision'))
    .map(entry => ({ id: entry.role, label: managedDataOperationLabel(entry) }))
    // Creating leads, linking follows, finding what is there comes last, whatever order the provider declared.
    .sort((a, b) => personOperationRank(a.id) - personOperationRank(b.id));
  return <ListPresentationProvider value="page" pageInsets="contained"><View testID="managed-data" style={deploymentSheetStyles.body}>
    {state.status === 'loading' ? <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />
      : state.status === 'failed' ? <SurfaceStateCard size="line" kind="error" title={t('common.unavailable')} diagnosticCode={state.code}
        action={{ label: t('common.retry'), onPress: retry }} />
      : !target || !operation ? <SurfaceStateCard size="line" kind="empty" title={t('projects.deployments.managedData.empty')} /> : <>
      {/* Where the database runs is the first choice, drawn as the providers themselves (lab database-createmanaged). */}
      {!props.linked && !adoption ? <ItemGroup title={t('projects.deployments.databaseProviderTitle')}>
        <SelectionTiles<string> testIdPrefix="managed-data.provider" surface="sheet" minimumColumns={1}
          accessibilityLabel={t('projects.deployments.databaseProviderTitle')}
          options={targets.map(entry => ({ id: entry.key, title: entry.title, disabled: busy || uncertain || partial,
            mark: <PluginMark title={entry.title} pluginId={entry.pluginId} /> }))}
          value={target.key}
          onChange={key => { if (!key || key === target.key) return; setTargetKey(key); setRole(null); setAccount(null); setValues({}); reset(); }} />
      </ItemGroup> : null}
      {adoption ? <ItemGroup testID="managed-data.adoption" title={t('projects.deployments.managedData.adoptionTitle')}
        description={t('projects.deployments.managedData.adoptionBody')}>
        <Item title={t('projects.deployments.managedData.adoptionWorkflow')} detail={adoption.workflowId} wrapDetail mode="info" />
        <Item title={t('projects.deployments.managedData.adoptionProject')} detail={adoption.scope.providerAccountId} wrapDetail mode="info" />
        <Item title={t('projects.deployments.managedData.adoptionEnvironment')} detail={adoption.scope.railwayEnvironmentId} wrapDetail mode="info" />
      </ItemGroup> : null}
      <ItemGroup header="none">
        {adoption ? null : choices.length <= 4 ? <SegmentedChoiceItem testID="managed-data.operation" title={t('projects.deployments.managedData.operation')}
          options={choices} value={operation.role} disabled={busy} onChange={role => { setRole(role); setCursors([]); setFieldCursors({}); setError(null); }} />
          : <DropdownMenu testID="managed-data.operation" open={operationOpen} onOpenChange={setOperationOpen}
            items={choices.map(choice => ({ id: choice.id, title: choice.label }))} selectedId={operation.role}
            onSelect={role => { setOperationOpen(false); setRole(role); setCursors([]); setFieldCursors({}); setError(null); }}
            itemTrigger={{ title: t('projects.deployments.managedData.operation'), showSelectedSubtitle: false, itemProps: { disabled: busy } }} />}
        {!props.linked && !adoption && operation.credential && !needsConnect ? <ConnectedAccountPurposeTargetChooser testID="managed-data.account"
          localizedTextPluginId={target.pluginId} accountsOnly disabled={busy || uncertain || partial} value={account ? { kind: 'account', account } : null}
          declaration={{ ...operation.credential, title: t('projects.deployments.platformLink.connection'), required: true }}
          onChange={next => { setAccount(next?.kind === 'account' ? next.account : null); reset(); }} /> : null}
        {/* The operation's fields read the provider through its account: they follow the first Connect. */}
        {needsConnect ? null : <ManagedDataActionFields fields={editableFields} operation={operation} input={seeded} draft={draft}
          declarations={state.status === 'ready' ? state.declarations : undefined} account={!props.linked && !adoption ? account : null}
          serviceRefresh={adoption !== null}
          lifetime={props.lifetime} busy={busy} editable={!busy && !partial} onPatch={patch}
          cursors={fieldCursors} setCursors={setFieldCursors} />}
      </ItemGroup>
      {needsConnect ? <ManagedDataFirstConnection target={target} onConnect={firstConnection.connect} /> : null}
      {uncertain ? <SurfaceStateCard testID="managed-data.unknown" size="line" kind="unavailable"
        title={t('projects.deployments.managedData.unknown')} reason={t('projects.deployments.managedData.recover')} /> : null}
      {partial ? <SurfaceStateCard testID="managed-data.partial" size="line" kind="unavailable"
        title={t('projects.deployments.managedData.partial')} /> : null}
      {inspectedService ? <ItemGroup title={t('projects.deployments.managedData.adoptionReview')}>
        <Item title={serviceName ?? inspectedService} detail={serviceName ? inspectedService : undefined} wrapDetail mode="info" />
      </ItemGroup> : !adoption && (value !== undefined || (reviewing === false && operation.role === 'projects.provision' && results['projects.provisionOptions'])) ? <ItemGroup title={t('projects.deployments.managedData.result')}>
        <Text selectable>{JSON.stringify(value ?? results['projects.provisionOptions']?.value, null, 2)}</Text>
        {cursors.length ? <Item testID="managed-data.page.previous" title={t('projects.deployments.pagePrevious')}
          disabled={busy} onPress={() => { void run(cursors.slice(0, -1)); }} /> : null}
        {nextCursor ? <Item testID="managed-data.page.next" title={t('projects.deployments.pageNext')}
          disabled={busy} onPress={() => { void run([...cursors, nextCursor]); }} /> : null}
      </ItemGroup> : null}
      {complete && !bound ? <DeploymentBindingReplacementChoices names={replaceKeys} selected={replace}
        testID="managed-data" disabled={busy} onChange={setReplace} /> : null}
      {connections.length ? <ItemGroup title={t('projects.deployments.managedData.connections')}>
        {connections.map(connection => <Item key={connection.name} testID={`managed-data.connection:${connection.name}`}
          title={connection.name} detail={t('projects.deployments.managedData.saved')} mode="info" />)}
        <Item testID="managed-data.bind" title={t(bound ? 'projects.deployments.managedData.bound' : 'projects.deployments.managedData.bind')}
          disabled={busy || !complete || bound || !replacementsReviewed} onPress={() => { void bind(); }} />
      </ItemGroup> : null}
    </>}
    {error ? <SurfaceStateCard testID="managed-data.failed" size="line" kind="error" title={t('common.unavailable')}
      reason={presentActionFailureOutcome(error, 'deployment').reason ?? undefined} diagnosticCode={error.errorCode} /> : null}
    {setChrome ? null : footer}
  </View></ListPresentationProvider>;
}

const PERSON_OPERATION_ORDER: readonly string[] = ['projects.provision', 'projects.link', 'projects.list'];
function personOperationRank(role: string): number {
  const rank = PERSON_OPERATION_ORDER.indexOf(role);
  return rank === -1 ? PERSON_OPERATION_ORDER.length : rank;
}

/** A provider operation in the person's words; roles without a host word keep the provider's own title. */
function managedDataOperationLabel(entry: ManagedDataOperation): string {
  switch (entry.role) {
    case 'projects.provision': return t('projects.deployments.managedData.operationCreate');
    case 'projects.link': return t('projects.deployments.managedData.operationLink');
    case 'projects.list': return t('projects.deployments.managedData.operationFind');
    default: return entry.title;
  }
}

/** Both managed-data operations and Duplicate consume the provider's declared Action fields. */
/** No account for this provider yet: the first Connect, composed as platform-link's (EmptyState + the shared Connect sheet). */
function ManagedDataFirstConnection(props: Readonly<{ target: ManagedDataTarget; onConnect: () => void }>) {
  const provider = props.target.title;
  return <EmptyState testID="managed-data.connect" layout="centered"
    icon={<PluginMark title={provider} pluginId={props.target.pluginId} />}
    title={t('projects.deployments.managedData.connectTitle', { provider })}
    subtitle={t('projects.deployments.managedData.connectBody', { provider })}
    primaryAction={{ label: t('projects.deployments.managedData.connectAction', { provider }), onPress: props.onConnect,
      testID: 'managed-data.connect.add' }} />;
}

function ManagedDataActionFields(props: Readonly<{
  fields: readonly EffectiveActionInputField[]; operation: ManagedDataOperation;
  input: Record<string, unknown>; draft: Record<string, unknown> | null;
  declarations: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[] | undefined;
  account: QualifiedConnectedAccountRef | null;
  lifetime: ServerAccountScopeLifetime; busy: boolean; editable: boolean; serviceRefresh?: boolean;
  onPatch: (patch: Record<string, unknown>, createdScope?: boolean) => void;
  cursors: Readonly<Record<string, readonly string[]>>;
  setCursors: React.Dispatch<React.SetStateAction<Readonly<Record<string, readonly string[]>>>>;
}>) {
  const requests = props.fields.map(field => ({ field, actionId: props.operation.actionId, draftInput: props.draft ?? props.input,
    ...(props.cursors[field.path]?.at(-1) ? { cursor: props.cursors[field.path]!.at(-1) } : {}) }));
  const options = useInputFieldOptions({ requests, enabled: props.draft !== null,
    serverId: props.lifetime.scope.serverId, accountLifetime: props.lifetime });
  const fieldCreation = useActionFieldCreation({
    declarations: props.declarations, lifetime: props.lifetime, enabled: props.draft !== null && props.account !== null, account: props.account,
    fields: resolveEffectiveActionInputFields(props.operation, props.input, { includeHidden: true }),
    values: props.input, onCreated: created => props.onPatch(created, true),
  });
  const resolveOptions = fieldCreation.withCreatedChoices(options.resolveOptions);
  return <>{props.fields.map(field => <React.Fragment key={field.path}>
    <Item title={field.title ?? field.path} showChevron={false} accessoryLayout={field.widget === 'json' ? 'stacked' : 'adaptive'}
      rightElement={<ActionInputFields fields={[field]} input={props.input} editable={props.editable} busy={props.busy} frame="none"
        resolveFieldOptions={resolveOptions} resolveChoiceAction={field => fieldCreation.choiceAction(field, resolveOptions)}
        onPatch={props.onPatch} resolveFieldTestID={entry => `managed-data.field:${entry.path}`} />} />
    {props.cursors[field.path]?.length ? <Item title={t('projects.deployments.pagePrevious')} disabled={props.busy}
      onPress={() => props.setCursors(current => ({ ...current, [field.path]: (current[field.path] ?? []).slice(0, -1) }))} /> : null}
    {options.state(field).nextCursor ? <Item title={t('projects.deployments.pageNext')} disabled={props.busy}
      onPress={() => props.setCursors(current => ({ ...current, [field.path]: [...current[field.path] ?? [], options.state(field).nextCursor!] }))} /> : null}
  </React.Fragment>)}
    {props.serviceRefresh ? <Item testID="managed-data.adoption.refresh" title={t('projects.deployments.managedData.adoptionRefresh')}
      disabled={props.busy} onPress={() => options.retry()} /> : null}
  </>;
}

export type ManagedDataProvisionDraft = DeploymentEnvironmentCopyProvisionV1;

/** Authors operands only. Creation owns execution after the destination Environment exists. */
export function DeploymentManagedDataProvisionEditor(props: Readonly<{
  lifetime: ServerAccountScopeLifetime;
  contribution: Readonly<{ pluginId: string; localId: string }>;
  disabled?: boolean;
  onChange: (draft: ManagedDataProvisionDraft | null) => void;
}>) {
  const { state, retry } = useDeploymentTargetDeclarations(props.lifetime);
  const target = React.useMemo(() => state.status === 'ready' ? managedDataTargets(state.declarations)
    .find(entry => entry.pluginId === props.contribution.pluginId && entry.target.id === props.contribution.localId) : undefined,
    [state, props.contribution.pluginId, props.contribution.localId]);
  const operation = target?.operations.find(entry => entry.role === 'projects.provision');
  const { account, setAccount, setValues, seeded } = useManagedDataForm(operation, props.lifetime);
  const [requestKey] = React.useState(randomUUID);
  const [cursors, setCursors] = React.useState<Readonly<Record<string, readonly string[]>>>({});
  const firstConnection = useFirstConnection(props.lifetime, operation?.credential?.service ?? null,
    connected => { setAccount(connected); setCursors({}); });
  const fields = React.useMemo(() => operation ? disclosePlatformFields(resolveEffectiveActionInputFields(operation, seeded), seeded) : [], [operation, seeded]);
  const draft = React.useMemo(() => target && operation?.credential && account ? buildManagedDataActionDraft({
    target, operation, lifetime: props.lifetime, environment: {}, account, values: seeded, requestKey,
  }) : null, [target, operation, account, props.lifetime, seeded, requestKey]);
  const missing = fields.some(field => field.required && (getValueAtPath(seeded, field.path) === undefined || getValueAtPath(seeded, field.path) === ''));
  const authored = React.useMemo(() => {
    if (!draft || missing || !target || !operation) return null;
    const parsed = DeploymentEnvironmentCopyProvisionV1Schema.safeParse({
      action: { pluginId: target.pluginId, localId: operation.action }, input: draft,
    });
    return parsed.success ? parsed.data : null;
  }, [draft, missing, target, operation]);
  React.useEffect(() => { props.onChange(authored); }, [authored, props.onChange]);
  if (state.status === 'loading') return <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />;
  if (state.status === 'failed') return <SurfaceStateCard size="line" kind="error" title={t('common.unavailable')}
    diagnosticCode={state.code} action={{ label: t('common.retry'), onPress: retry }} />;
  if (!target || !operation?.credential) return <SurfaceStateCard size="line" kind="unavailable" title={t('common.unavailable')}
    reason={t('projects.deployments.copy.dataEmptyUnavailable')} />;
  if (account === null && firstConnection.missing) return <ManagedDataFirstConnection target={target} onConnect={firstConnection.connect} />;
  return <>
    <ConnectedAccountPurposeTargetChooser testID="managed-data.account" localizedTextPluginId={target.pluginId} accountsOnly
      disabled={props.disabled} value={account ? { kind: 'account', account } : null}
      declaration={{ ...operation.credential, title: t('projects.deployments.platformLink.connection'), required: true }}
      onChange={next => { setAccount(next?.kind === 'account' ? next.account : null); setCursors({}); }} />
    <ManagedDataActionFields fields={fields} operation={operation} input={seeded} draft={draft} lifetime={props.lifetime}
      declarations={state.declarations} account={account}
      busy={props.disabled === true} editable={!props.disabled} cursors={cursors} setCursors={setCursors}
      onPatch={(patch, createdScope) => {
        const { values } = applyPlatformFieldPatch(fields, seeded, patch);
        setValues(createdScope ? { ...values, ...patch } : values);
        setCursors({});
      }} />
  </>;
}

function managedDataOperationOperands(operation: ManagedDataOperation, values: Readonly<Record<string, unknown>>, requestKey: string) {
  const properties = operation.declaration.inputSchema?.properties ?? {};
  return { ...Object.fromEntries(Object.entries(values).filter(([key]) => Object.hasOwn(properties, key))),
    ...(Object.hasOwn(properties, 'requestKey') ? { requestKey } : {}) };
}

function buildManagedDataActionDraft(input: Readonly<{
  target: ManagedDataTarget; operation: ManagedDataOperation; lifetime: ServerAccountScopeLifetime;
  environment: Readonly<{ id?: string; revision?: number }>;
  account: QualifiedConnectedAccountRef; values: Readonly<Record<string, unknown>>; requestKey: string;
}>) {
  if (!input.operation.credential) return null;
  return buildPlatformTargetDraft({ target: { pluginId: input.target.pluginId, inspectLocalId: input.operation.action,
    purpose: input.operation.credential.purpose }, ownerAccountId: input.lifetime.scope.accountId,
    serverId: input.lifetime.scope.serverId, environment: input.environment, account: input.account, repository: null,
    values: { ...managedDataOperationOperands(input.operation, input.values, input.requestKey), providerEnvironment: { kind: 'native', selection: {} } } });
}
