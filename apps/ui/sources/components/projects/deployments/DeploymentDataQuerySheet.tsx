import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { DeploymentDataQueryResultV1Schema, type DeploymentDataQueryResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDataQueryStatementV1Schema, type DeploymentDataQueryStatementV1,
  type DeploymentDataQuerySuccessV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { DeploymentSecretBindingSourceV1Schema, type DeploymentSecretBindingSourceV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { isRecord } from '@happier-dev/protocol/common/records';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { readDeploymentActionError } from './deploymentActionOutcome';

type DeploymentDataQuerySheetStatement = DeploymentDataQueryStatementV1 & Readonly<{ database?: string }>;

export type DeploymentDataQuerySheetInput = Readonly<{
  name: string;
  parameterHint: string;
  /** Managed query schemas may require an explicit database; native services already own theirs. */
  database?: Readonly<{ title: string; supportingText?: string }>;
  run: (statement: DeploymentDataQuerySheetStatement) => Promise<DeploymentDataQueryResultV1>;
  setup?: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    machineId: string;
    configure: (source: DeploymentSecretBindingSourceV1) => Promise<Readonly<{ ok: boolean; error?: string }>>;
    onApproval: (artifactId: string) => void;
  }>;
}>;

export function showDeploymentDataQuerySheet(input: DeploymentDataQuerySheetInput): void {
  showDeploymentSheet({ component: DeploymentDataQuerySheet, props: input,
    title: t('projects.deployments.databaseQuery.title'), testID: 'project-deployments.query.modal', bodyScroll: 'none', scrollHost: 'body' });
}

function cellText(value: DeploymentDataQuerySuccessV1['rows'][number][number]): string {
  return value === null ? 'NULL' : typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Both native and managed Actions feed this one lossless, virtualized result presentation. */
function DeploymentDataQueryRow(props: Readonly<{ columns: DeploymentDataQuerySuccessV1['columns'];
  row: DeploymentDataQuerySuccessV1['rows'][number]; index: number }>) {
  return <ItemGroup title={t('projects.deployments.databaseQuery.row', { number: props.index + 1 })}>
    {props.columns.map((column, index) => <Item key={index} mode="info" title={column.name}
      rightElement={<Text selectable testID={`project-deployments.query.cell.${props.index}.${index}`}>{cellText(props.row[index]!)}</Text>} />)}
  </ItemGroup>;
}

function DeploymentDataQuerySheet(props: DeploymentDataQuerySheetInput & CustomModalInjectedProps) {
  const id = 'project-deployments.query';
  const [sql, setSql] = React.useState('');
  const [paramsText, setParamsText] = React.useState('{}');
  const [database, setDatabase] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<DeploymentDataQueryResultV1 | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [setupDraft, setSetupDraft] = React.useState<Record<string, unknown>>({});
  const setup = props.setup;
  const secretHint = React.useMemo(() => ({ path: 'password', title: t('projects.deployments.databaseQuery.password'),
    widget: 'select' as const, inputType: { hostType: 'savedSecretReference' as const } }), []);
  const requests = React.useMemo(() => [{ field: secretHint }], [secretHint]);
  const options = useInputFieldOptions({ requests, enabled: Boolean(setup && setupOpen), accountLifetime: setup?.lifetime ?? null,
    serverId: setup?.lifetime.scope.serverId, machineId: setup?.machineId });
  const fields = resolveEffectiveActionInputFields({ inputHints: { fields: [secretHint] } }, setupDraft);
  const selection = setupDraft.password;
  const source = DeploymentSecretBindingSourceV1Schema.safeParse(isRecord(selection) ? { kind: 'secret', ...selection } : null);
  const success = result?.ok === true ? result : null;
  const refusal = result?.ok === false ? result : null;
  const refusalCode = refusal ? ('diagnostic' in refusal && refusal.diagnostic && 'code' in refusal.diagnostic
    ? refusal.diagnostic.code : null) ?? refusal.error : null;
  const rows = success?.rows ?? [];
  const run = async () => {
    if (busy) return;
    let params: unknown;
    try { params = JSON.parse(paramsText); } catch { setError('query_parameters_invalid'); return; }
    const statement = DeploymentDataQueryStatementV1Schema.safeParse({ sql, params });
    if (!statement.success) { setError('query_parameters_invalid'); return; }
    setBusy(true); setError(null); setResult(null);
    try { setResult(DeploymentDataQueryResultV1Schema.parse(await props.run({ ...statement.data,
      ...(props.database ? { database } : {}) }))); }
    catch (failure) { const outcome = readDeploymentActionError(failure); setError(outcome.kind === 'refused' ? outcome.code : 'query_unavailable'); }
    finally { setBusy(false); }
  };
  const configure = async () => {
    if (!setup || !source.success || busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await setup.configure(source.data);
      if (saved.ok) props.onClose(); else setError(saved.error ?? 'read_role_setup_required');
    } catch (failure) {
      const outcome = readDeploymentActionError(failure);
      if (outcome.kind === 'approval') { props.onClose(); setup.onApproval(outcome.artifactId); }
      else setError(outcome.kind === 'refused' ? outcome.code : 'read_role_setup_required');
    } finally { setBusy(false); }
  };
  const footer = <ModalCardFooterActions cancel={{ onPress: props.onClose, testID: `${id}.close`, disabled: busy }}>
    <RoundButton testID={`${id}.run`} title={t('projects.deployments.databaseQuery.run')} size="normal"
      disabled={busy || sql.trim().length === 0 || Boolean(props.database && database.trim().length === 0)} loading={busy} onPress={() => { void run(); }} />
  </ModalCardFooterActions>;
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  const header = <View style={deploymentSheetStyles.body}>
    <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.databaseQuery.description', { name: props.name })}</Text>
    {props.database ? <FieldItem label={props.database.title} {...(props.database.supportingText ? { supportingText: props.database.supportingText } : {})}>
      <FieldTextInput testID={`${id}.database`} value={database} onChangeText={setDatabase} editable={!busy}
        accessibilityLabel={props.database.title} autoCapitalize="none" />
    </FieldItem> : null}
    <FieldItem label={t('projects.deployments.databaseQuery.sql')} supportingText={props.parameterHint}>
      <FieldTextInput testID={`${id}.sql`} value={sql} onChangeText={setSql} multiline monospace editable={!busy}
        accessibilityLabel={t('projects.deployments.databaseQuery.sql')} autoCapitalize="none" />
    </FieldItem>
    <FieldItem label={t('projects.deployments.databaseQuery.parameters')}>
      <FieldTextInput testID={`${id}.params`} value={paramsText} onChangeText={setParamsText} multiline monospace editable={!busy}
        accessibilityLabel={t('projects.deployments.databaseQuery.parameters')} autoCapitalize="none" />
    </FieldItem>
    {setup ? <ItemGroup header="none">
      <Item testID={`${id}.setup`} title={t('projects.deployments.databaseQuery.setup')} onPress={() => setSetupOpen(value => !value)} />
      {setupOpen ? <View style={styles.setup}>
        <Text>{t('projects.deployments.databaseQuery.setupDescription')}</Text>
        <ActionInputFields fields={fields} input={setupDraft} editable={!busy} busy={busy} resolveFieldOptions={options.resolveOptions}
          onPatch={patch => setSetupDraft(value => ({ ...value, ...patch }))} resolveFieldTestID={() => `${id}.password`} />
        <RoundButton testID={`${id}.configure`} title={t('projects.deployments.databaseQuery.reviewSetup')} size="normal"
          disabled={busy || !source.success} onPress={() => { void configure(); }} />
      </View> : null}
    </ItemGroup> : null}
    {busy ? <SurfaceStateCard testID={`${id}.working`} kind="loading" size="line" title={t('projects.deployments.databaseQuery.working')} /> : null}
    {error || refusalCode ? <SurfaceStateCard testID={`${id}.refused`} kind="unavailable" size="line"
      title={t('projects.deployments.databaseQuery.unavailable')} diagnosticCode={error ?? refusalCode}
      {...(refusalCode === 'secret_missing' || refusalCode === 'read_role_setup_required' || refusalCode === 'read_role_unavailable'
        ? { reason: t('projects.deployments.databaseQuery.roleUnavailable') } : {})} /> : null}
    {success && !success.complete ? <SurfaceStateCard testID={`${id}.incomplete`} kind="unavailable" size="line"
      title={t('projects.deployments.databaseQuery.incomplete')} diagnosticCode={success.diagnostic?.code ?? null} /> : null}
    {success && rows.length === 0 ? <SurfaceStateCard testID={`${id}.empty`} kind="empty" size="line"
      title={t('projects.deployments.databaseQuery.empty')} /> : null}
  </View>;
  return <ListPresentationProvider value="page" pageInsets="contained">
    <View testID={id} style={styles.body}>
      <VirtualizedList data={rows} keyExtractor={(_, index) => String(index)} ListHeaderComponent={header}
        style={styles.list} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
        renderItem={({ item, index }) => success ? <DeploymentDataQueryRow columns={success.columns} row={item} index={index} /> : null} />
      {setChrome ? null : footer}
    </View>
  </ListPresentationProvider>;
}

const styles = StyleSheet.create(theme => ({
  body: { flex: 1, minHeight: 0 }, list: { flex: 1 },
  content: { paddingBottom: theme.space.s16 }, setup: { gap: theme.space.s12, padding: theme.space.s16 },
}));
