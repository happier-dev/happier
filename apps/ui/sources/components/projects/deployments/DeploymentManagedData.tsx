import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { EffectiveActionInputField } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { DeploymentEnvironmentCopyProvisionV1Schema, type DeploymentEnvironmentCopyProvisionV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentCopyV1';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { seedInputByFieldHints } from '@happier-dev/protocol/inputs';
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
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import type { createDeploymentActions } from './deploymentActions';
import { useDeploymentTargetDeclarations } from './DeploymentPlatformTargetSheet';
import { buildPlatformTargetDraft, buildPlatformTargetLinkInput, applyPlatformFieldPatch, disclosePlatformFields } from './platformTargetLink';
import { buildPreviewBranchReadInput } from './previewDatabaseBranches';
import { managedDataConnections, managedDataLinkContent, managedDataTargets, type ManagedDataOperation, type ManagedDataTarget } from './managedData';
import { deploymentSheetStyles } from './deploymentSheet';
import { readDeploymentActionError } from './deploymentActionOutcome';

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
  const [account, setAccount] = React.useState<QualifiedConnectedAccountRef | null>(null);
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [results, setResults] = React.useState<Readonly<Record<string, Result>>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [bound, setBound] = React.useState(false);
  const [replace, setReplace] = React.useState<readonly string[]>([]);
  const [providerOpen, setProviderOpen] = React.useState(false);
  const [operationOpen, setOperationOpen] = React.useState(false);
  const [cursors, setCursors] = React.useState<readonly string[]>([]);
  const [fieldCursors, setFieldCursors] = React.useState<Readonly<Record<string, readonly string[]>>>({});
  const [requestKey, setRequestKey] = React.useState(randomUUID);
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
  const seeded = React.useMemo(() => operation ? seedInputByFieldHints(operation, values) : values, [operation, values]);
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
  const requiredFields = reviewing && optionsOperation ? resolveEffectiveActionInputFields(optionsOperation, seeded) : fields;
  const missing = requiredFields.some(field => field.required && (getValueAtPath(seeded, field.path) === undefined
    || getValueAtPath(seeded, field.path) === ''));
  const blockedCreate = uncertain && (operation?.role === 'projects.provision' || operation?.role === 'branches.create');
  const provider = result ? managedDataLinkContent(result.input.credentialPrincipal, value) : null;
  const canLink = provider && (result?.role === 'projects.link' || result?.role === 'projects.provision' || result?.role === 'branches.create');
  const nextCursor = isRecord(value) && typeof value.nextCursor === 'string' ? value.nextCursor : null;
  const reset = () => { setResults({}); setError(null); setBound(false); setReplace([]); setCursors([]); setFieldCursors({}); setRequestKey(randomUUID()); };
  const patch = (next: Record<string, unknown>) => {
    const patched = applyPlatformFieldPatch(fields, seeded, next);
    setValues(patched.values); setError(null); setBound(false); setReplace([]); setCursors([]); setFieldCursors({});
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
        else setError(response.code);
        return;
      }
      setCursors(page);
      setBound(false); setReplace([]);
      setResults(current => ({ ...current, [runOperation.role]: { value: response.value, input, role: runOperation.role } }));
    } catch (failure) {
      const outcome = readDeploymentActionError(failure);
      if (outcome.kind === 'approval') approval(outcome.artifactId);
      else setError(outcome.kind === 'refused' ? outcome.code : 'unknown_error');
    } finally { if (shouldContinue()) setBusy(false); }
  };
  const link = async () => {
    if (!target || !provider || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await props.actions.link(buildPlatformTargetLinkInput({
        target: { pluginId: target.pluginId, targetId: target.target.id, targetKind: target.target.targetKind },
        environment: props.detail.environment, provider, role: 'data' }), { confirmed: true });
      if (response.ok) props.onClose(); else setError(response.error);
    } catch (failure) {
      const outcome = readDeploymentActionError(failure);
      if (outcome.kind === 'approval') approval(outcome.artifactId); else setError(outcome.kind === 'refused' ? outcome.code : 'unknown_error');
    } finally { if (shouldContinue()) setBusy(false); }
  };
  const bind = async () => {
    if (busy || !complete || connections.length === 0 || !replacementsReviewed) return;
    setBusy(true); setError(null);
    try {
      const response = await props.actions.setBindings({ environmentId: props.detail.environment.id,
        expectedRevision: props.detail.environment.revision, set: connectionBindings, remove: [] });
      if (response.ok) setBound(true); else setError(response.error);
    } catch (failure) {
      const outcome = readDeploymentActionError(failure);
      if (outcome.kind === 'approval') approval(outcome.artifactId); else setError(outcome.kind === 'refused' ? outcome.code : 'unknown_error');
    } finally { if (shouldContinue()) setBusy(false); }
  };
  const footer = <ModalCardFooterActions cancel={{ onPress: props.onClose, disabled: busy }}>
    {canLink ? <RoundButton testID="managed-data.link" title={t('projects.deployments.managedData.link')}
      loading={busy} disabled={busy} onPress={() => { void link(); }} />
      : operation ? <RoundButton testID="managed-data.run" title={reviewing ? t('projects.deployments.managedData.reviewCreate') : operation.title}
        loading={busy} disabled={busy || !draft || missing || Boolean(blockedCreate)}
        onPress={() => { void run(); }} /> : null}
  </ModalCardFooterActions>;
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  const choices = operations.map(entry => ({ id: entry.role, label: entry.title }));
  return <ListPresentationProvider value="page" pageInsets="contained"><View testID="managed-data" style={deploymentSheetStyles.body}>
    {state.status === 'loading' ? <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />
      : state.status === 'failed' ? <SurfaceStateCard size="line" kind="error" title={t('common.unavailable')} diagnosticCode={state.code}
        action={{ label: t('common.retry'), onPress: retry }} />
      : !target || !operation ? <SurfaceStateCard size="line" kind="empty" title={t('projects.deployments.managedData.empty')} /> : <>
      <ItemGroup header="none">
        {!props.linked ? <DropdownMenu testID="managed-data.provider" open={providerOpen} onOpenChange={setProviderOpen}
          items={targets.map(entry => ({ id: entry.key, title: entry.title }))} selectedId={target.key}
          onSelect={key => { setProviderOpen(false); setTargetKey(key); setRole(null); setAccount(null); setValues({}); reset(); }}
          itemTrigger={{ title: t('projects.deployments.databaseProviderTitle'), showSelectedSubtitle: false, itemProps: { disabled: busy || uncertain || partial } }} /> : null}
        {choices.length <= 4 ? <SegmentedChoiceItem testID="managed-data.operation" title={t('projects.deployments.managedData.operation')}
          options={choices} value={operation.role} disabled={busy} onChange={role => { setRole(role); setCursors([]); setFieldCursors({}); setError(null); }} />
          : <DropdownMenu testID="managed-data.operation" open={operationOpen} onOpenChange={setOperationOpen}
            items={choices.map(choice => ({ id: choice.id, title: choice.label }))} selectedId={operation.role}
            onSelect={role => { setOperationOpen(false); setRole(role); setCursors([]); setFieldCursors({}); setError(null); }}
            itemTrigger={{ title: t('projects.deployments.managedData.operation'), showSelectedSubtitle: false, itemProps: { disabled: busy } }} />}
        {!props.linked && operation.credential ? <ConnectedAccountPurposeTargetChooser testID="managed-data.account"
          localizedTextPluginId={target.pluginId} accountsOnly disabled={busy || uncertain || partial} value={account ? { kind: 'account', account } : null}
          declaration={{ ...operation.credential, title: t('projects.deployments.platformLink.connection'), required: true }}
          onChange={next => { setAccount(next?.kind === 'account' ? next.account : null); reset(); }} /> : null}
        <ManagedDataActionFields fields={fields} operation={operation} input={seeded} draft={draft}
          lifetime={props.lifetime} busy={busy} editable={!busy && !partial} onPatch={patch}
          cursors={fieldCursors} setCursors={setFieldCursors} />
      </ItemGroup>
      {uncertain ? <SurfaceStateCard testID="managed-data.unknown" size="line" kind="unavailable"
        title={t('projects.deployments.managedData.unknown')} reason={t('projects.deployments.managedData.recover')} /> : null}
      {partial ? <SurfaceStateCard testID="managed-data.partial" size="line" kind="unavailable"
        title={t('projects.deployments.managedData.partial')} /> : null}
      {value !== undefined || (reviewing === false && operation.role === 'projects.provision' && results['projects.provisionOptions']) ? <ItemGroup title={t('projects.deployments.managedData.result')}>
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
    {error ? <SurfaceStateCard testID="managed-data.failed" size="line" kind="error" title={t('common.unavailable')} diagnosticCode={error} /> : null}
    {setChrome ? null : footer}
  </View></ListPresentationProvider>;
}

/** Both managed-data operations and Duplicate consume the provider's declared Action fields. */
function ManagedDataActionFields(props: Readonly<{
  fields: readonly EffectiveActionInputField[]; operation: ManagedDataOperation;
  input: Record<string, unknown>; draft: Record<string, unknown> | null;
  lifetime: ServerAccountScopeLifetime; busy: boolean; editable: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  cursors: Readonly<Record<string, readonly string[]>>;
  setCursors: React.Dispatch<React.SetStateAction<Readonly<Record<string, readonly string[]>>>>;
}>) {
  const requests = props.fields.map(field => ({ field, actionId: props.operation.actionId, draftInput: props.draft ?? props.input,
    ...(props.cursors[field.path]?.at(-1) ? { cursor: props.cursors[field.path]!.at(-1) } : {}) }));
  const options = useInputFieldOptions({ requests, enabled: props.draft !== null,
    serverId: props.lifetime.scope.serverId, accountLifetime: props.lifetime });
  return <>{props.fields.map(field => <React.Fragment key={field.path}>
    <Item title={field.title ?? field.path} showChevron={false} accessoryLayout={field.widget === 'json' ? 'stacked' : 'adaptive'}
      rightElement={<ActionInputFields fields={[field]} input={props.input} editable={props.editable} busy={props.busy} frame="none"
        resolveFieldOptions={options.resolveOptions} onPatch={props.onPatch} resolveFieldTestID={entry => `managed-data.field:${entry.path}`} />} />
    {props.cursors[field.path]?.length ? <Item title={t('projects.deployments.pagePrevious')} disabled={props.busy}
      onPress={() => props.setCursors(current => ({ ...current, [field.path]: (current[field.path] ?? []).slice(0, -1) }))} /> : null}
    {options.state(field).nextCursor ? <Item title={t('projects.deployments.pageNext')} disabled={props.busy}
      onPress={() => props.setCursors(current => ({ ...current, [field.path]: [...current[field.path] ?? [], options.state(field).nextCursor!] }))} /> : null}
  </React.Fragment>)}</>;
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
  const [account, setAccount] = React.useState<QualifiedConnectedAccountRef | null>(null);
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [requestKey] = React.useState(randomUUID);
  const [cursors, setCursors] = React.useState<Readonly<Record<string, readonly string[]>>>({});
  const seeded = React.useMemo(() => operation ? seedInputByFieldHints(operation, values) : values, [operation, values]);
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
  return <>
    <ConnectedAccountPurposeTargetChooser testID="managed-data.account" localizedTextPluginId={target.pluginId} accountsOnly
      disabled={props.disabled} value={account ? { kind: 'account', account } : null}
      declaration={{ ...operation.credential, title: t('projects.deployments.platformLink.connection'), required: true }}
      onChange={next => { setAccount(next?.kind === 'account' ? next.account : null); setCursors({}); }} />
    <ManagedDataActionFields fields={fields} operation={operation} input={seeded} draft={draft} lifetime={props.lifetime}
      busy={props.disabled === true} editable={!props.disabled} cursors={cursors} setCursors={setCursors}
      onPatch={patch => { setValues(applyPlatformFieldPatch(fields, seeded, patch).values); setCursors({}); }} />
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
    values: { ...managedDataOperationOperands(input.operation, input.values, input.requestKey), providerEnvironment: { kind: 'production' } } });
}
