import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { seedInputByFieldHints } from '@happier-dev/protocol/inputs';
import { isRecord } from '@happier-dev/protocol/common/records';
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
import { managedDataConnections, managedDataLinkContent, managedDataTargets, type ManagedDataOperation } from './managedData';
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
  const uncertain = Object.values(results).some(entry => (entry.role === 'projects.provision' || entry.role === 'branches.create')
    && isRecord(entry.value) && entry.value.status === 'outcome_unknown');
  const optionsOperation = operations.find(entry => entry.role === 'projects.provisionOptions');
  const reviewing = operation?.role === 'projects.provision' && optionsOperation !== undefined && !results['projects.provisionOptions'];
  const runOperation = reviewing ? optionsOperation : operation;
  const seeded = React.useMemo(() => operation ? seedInputByFieldHints(operation, values) : values, [operation, values]);
  const linkedInput = props.linked ? buildPreviewBranchReadInput(props.detail, props.linked) : null;
  const draftFor = (entry: ManagedDataOperation): Record<string, unknown> | null => {
    const product = { ...Object.fromEntries(Object.entries(seeded).filter(([key]) => Object.hasOwn(entry.declaration.inputSchema?.properties ?? {}, key))),
      ...(Object.hasOwn(entry.declaration.inputSchema?.properties ?? {}, 'requestKey') ? { requestKey } : {}) };
    if (props.linked) return linkedInput ? { ...product, ...linkedInput,
      ...(partial && result?.role === entry.role ? { previous: saved } : {}) } : null;
    if (!target || !entry.credential || !account) return null;
    return buildPlatformTargetDraft({ target: { pluginId: target.pluginId, inspectLocalId: entry.action,
      purpose: entry.credential.purpose }, ownerAccountId: props.lifetime.scope.accountId,
      serverId: props.lifetime.scope.serverId, environment: props.detail.environment, account, repository: null,
      values: { ...product, providerEnvironment: { kind: 'production' } } });
  };
  const draft = operation ? draftFor(operation) : null;
  const fields = React.useMemo(() => operation ? disclosePlatformFields(resolveEffectiveActionInputFields(operation, seeded), seeded) : [], [operation, seeded]);
  const requests = fields.map(field => ({ field, actionId: operation?.actionId, draftInput: draft ?? seeded,
    ...(fieldCursors[field.path]?.at(-1) ? { cursor: fieldCursors[field.path]!.at(-1) } : {}) }));
  const options = useInputFieldOptions({ requests, enabled: draft !== null,
    serverId: props.lifetime.scope.serverId, accountLifetime: props.lifetime });
  const requiredFields = reviewing && optionsOperation ? resolveEffectiveActionInputFields(optionsOperation, seeded) : fields;
  const missing = requiredFields.some(field => field.required && (getValueAtPath(seeded, field.path) === undefined
    || getValueAtPath(seeded, field.path) === ''));
  const blockedCreate = uncertain && (operation?.role === 'projects.provision' || operation?.role === 'branches.create');
  const provider = result ? managedDataLinkContent(result.input.credentialPrincipal, value) : null;
  const canLink = provider && (result?.role === 'projects.link' || result?.role === 'projects.provision' || result?.role === 'branches.create');
  const nextCursor = isRecord(value) && typeof value.nextCursor === 'string' ? value.nextCursor : null;
  const reset = () => { setResults({}); setError(null); setBound(false); setCursors([]); setFieldCursors({}); setRequestKey(randomUUID()); };
  const patch = (next: Record<string, unknown>) => {
    const patched = applyPlatformFieldPatch(fields, seeded, next);
    setValues(patched.values); setError(null); setBound(false); setCursors([]); setFieldCursors({});
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
      setBound(false);
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
    if (busy || !complete || connections.length === 0) return;
    setBusy(true); setError(null);
    try {
      const response = await props.actions.setBindings({ environmentId: props.detail.environment.id,
        expectedRevision: props.detail.environment.revision, set: connections.map(connection => ({ purpose: 'variable',
          phase: 'runtime', name: connection.name, source: { kind: 'secret', ref: connection.ref, resourceRevision: connection.resourceRevision } })), remove: [] });
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
        {fields.map(field => <React.Fragment key={field.path}>
          <Item title={field.title ?? field.path} showChevron={false} accessoryLayout={field.widget === 'json' ? 'stacked' : 'adaptive'}
            rightElement={<ActionInputFields fields={[field]} input={seeded} editable={!busy && !partial} busy={busy} frame="none"
              resolveFieldOptions={options.resolveOptions} onPatch={patch} resolveFieldTestID={entry => `managed-data.field:${entry.path}`} />} />
          {fieldCursors[field.path]?.length ? <Item title={t('projects.deployments.pagePrevious')} disabled={busy}
            onPress={() => setFieldCursors(current => ({ ...current, [field.path]: (current[field.path] ?? []).slice(0, -1) }))} /> : null}
          {options.state(field).nextCursor ? <Item title={t('projects.deployments.pageNext')} disabled={busy}
            onPress={() => setFieldCursors(current => ({ ...current, [field.path]: [...current[field.path] ?? [], options.state(field).nextCursor!] }))} /> : null}
        </React.Fragment>)}
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
      {connections.length ? <ItemGroup title={t('projects.deployments.managedData.connections')}>
        {connections.map(connection => <Item key={connection.name} testID={`managed-data.connection:${connection.name}`}
          title={connection.name} detail={t('projects.deployments.managedData.saved')} mode="info" />)}
        <Item testID="managed-data.bind" title={t(bound ? 'projects.deployments.managedData.bound' : 'projects.deployments.managedData.bind')}
          disabled={busy || !complete || bound} onPress={() => { void bind(); }} />
      </ItemGroup> : null}
    </>}
    {error ? <SurfaceStateCard testID="managed-data.failed" size="line" kind="error" title={t('common.unavailable')} diagnosticCode={error} /> : null}
    {setChrome ? null : footer}
  </View></ListPresentationProvider>;
}
