import * as React from 'react';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { DATABASE_ACCESS_SET_ACTION_ID_V1, DatabaseAccessSetResultV1Schema, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import type { DatabaseAccessSummaryV1, DatabaseAgentAccessV1, DatabaseDescriptorV1, DatabaseRelationV1 } from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import {
  Action,
  ErrorState,
  Icon,
  LoadingState,
  Field,
  Popover,
  Row,
  Select,
  Stack,
  Text,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1, useHostDatabaseWorkbench, type PluginActionExecution } from '@happier-dev/plugin-ui/hostApi';
import {
  useDatabaseAccess,
  useDatabaseRelations,
  useDatabaseSchemaRelations,
  useWorkbenchInstance,
  useWorkbenchLocation,
} from '../hooks.js';
import { sameRelation } from '../location.js';
import { workbenchTargetKey } from '../workbench.js';
import { approxRowsLabel } from './sizes.js';
import { CatalogueReadFailure } from './CatalogueReadFailure.js';
import { databaseFacts } from './engines.js';
import { CataloguePagination } from './CataloguePagination.js';
import { NavigationList } from '@happier-dev/plugin-ui/components';


/** What a rail press asks for; the page navigates in place, the Session rail opens a details tab. */
export type RailIntent = Readonly<
  | { mode: 'overview' }
  | { mode: 'console' }
  | { mode: 'insights' }
  | { mode: 'data' | 'structure'; relation: DatabaseRelationV1 }
>;

/** The access word, once, at the database identity (decision E); the Popover says what it means. */
export function AccessWord(
  props: Readonly<{ descriptor: DatabaseDescriptorV1 }>,
) {
  const translate = usePluginTranslation();
  const host = useHostDatabaseWorkbench();
  const [open, setOpen] = React.useState(false);
  const { target, origin } = props.descriptor;
  const targetKey = workbenchTargetKey(target);
  const selected = useDatabaseAccess(targetKey, open);
  const policy = selected.value?.setBy === 'environment' ? selected.value : null;
  const { environmentTarget, summary: access } = selected;
  if (!access) return null;
  const unavailable = selected.status === 'unavailable' || selected.status === 'stale';
  const failure = isPluginError(selected.error) ? selected.error : undefined;
  const word = unavailable
    ? translate('plugins.database.access.unavailable', 'Access unavailable')
    : selected.canWrite
    ? translate('plugins.database.access.canEdit', 'Can edit')
    : translate('plugins.database.access.readOnly', 'Read only');
  return <>
    {environmentTarget ? host?.renderEnvironmentAccessObserver?.({
      target: environmentTarget, environment: origin.environment,
      policyEnvironmentId: policy?.environmentId, onChanged: selected.refresh,
    }) : null}
    <Popover
      open={open}
      onOpenChange={next => {
        if (next && !environmentTarget && selected.status !== 'loading') selected.refresh();
        setOpen(next);
      }}
      trigger={word}
      triggerAccessibilityLabel={word}
      triggerAppearance="text"
      triggerSize="small"
      triggerDisclosure
      // On a phone the loaded choices need the width: the host's sheet, not a popover over the rail.
      sheet={{ title: translate('plugins.database.access.title', 'Database access') }}
    >
      <Stack gap="small">
        {unavailable ? <ErrorState layout="line" kind="unavailable"
          title={failure?.data.message ?? (failure?.code === 'machine_unavailable' && !environmentTarget
            ? translate('plugins.database.access.machineUnavailable', 'Access is stored on the Machine, which is unavailable.')
            : translate('plugins.database.access.readUnavailable', 'Database access could not be read'))}
          details={failure?.code}
          onRetry={selected.refresh} retryLabel={translate('plugins.database.retry', 'Try again')} /> :
          <Text value={databaseAccessLine(translate, access)} />}
        {open && selected.status === 'loading' ? <LoadingState layout="line" rows={1} /> : null}
        {open && !unavailable && selected.value?.setBy === 'machine'
          ? <MachineAgentAccess key={targetKey} targetKey={targetKey} level={selected.value.agentAccess} /> : null}
        {open && !unavailable && policy && environmentTarget ? host?.renderEnvironmentAccessSettings?.({
          target: environmentTarget, policy,
        }) ?? <Text tone="secondary" variant="meta"
          value={translate('plugins.database.access.setByEnvironment', 'Agent access is managed by the Environment.')} /> : null}
      </Stack>
    </Popover>
  </>;
}

function databaseAccessLine(t: PluginTranslate, access: DatabaseAccessSummaryV1): string {
  if (access.canWrite) {
    return t('plugins.database.access.canEditLine', 'You can edit rows here. Every change is reviewed before it’s applied.');
  }
  switch (access.reason) {
    case 'database_editing_off':
      return t('plugins.database.access.editingOff', 'Database editing is off for this Environment.');
    case 'database_not_an_editor':
      return t('plugins.database.access.notEditor', 'You aren’t in this Environment’s database editors.');
    case 'database_agent_access_none':
      return t('plugins.database.access.agentsOff', 'Agents can’t use this database.');
    case 'database_agent_access_read_only':
      return t('plugins.database.access.agentsRead', 'Agents can read this database.');
    default:
      return t('plugins.database.access.readOnlyLine', 'You can browse tables and run read-only SQL.');
  }
}

const setAgentAccess = databaseActionLocalIdV1(DATABASE_ACCESS_SET_ACTION_ID_V1);

function MachineAgentAccess({ targetKey, level }: Readonly<{ targetKey: string; level: DatabaseAgentAccessV1 }>) {
  const t = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const [draft, setDraft] = React.useState<DatabaseAgentAccessV1 | null>(null);
  const [notice, setNotice] = React.useState<Readonly<{ text: string; error?: true; pending?: true; execution?: never }>
    | Readonly<{ execution: PluginActionExecution; pending?: never }>
    | null>(null);
  const selected = draft ?? level;
  const choices = {
    none: t('plugins.database.access.level.none', 'None'),
    read: t('plugins.database.access.level.read', 'Read'),
    readWriteAsk: t('plugins.database.access.level.ask', 'Read and write (asks first)'),
    readWriteNoApproval: t('plugins.database.access.level.write', 'Read and write (no approval)'),
  } satisfies Record<DatabaseAgentAccessV1, string>;
  const input = projectNativeJsonValueForTransport({
    target: instance.target(targetKey).target, agentAccess: selected,
  });
  function settle(execution: PluginUiActionControlExecution) {
    const result = projectPluginActionControlExecutionV1(execution, t);
    if (isPluginActionConfirmationDeclined(result)) return;
    if (result.status === 'success') {
      if (isPluginActionApprovalRequestCreated(result.result)) {
        setNotice({ text: t('plugins.database.access.pending', 'Waiting for approval.'), pending: true });
        return;
      }
      const reply = DatabaseAccessSetResultV1Schema.safeParse(result.result);
      if (reply.success) {
        const resource = instance.access(targetKey);
        const current = resource.get().data;
        if (current?.setBy === 'machine') resource.accept({ ...current, agentAccess: reply.data.agentAccess });
        setDraft(previous => previous === selected ? null : previous);
        setNotice(null);
        return;
      }
    }
    setNotice('code' in result ? { execution: result }
      : { text: t('plugins.database.access.changeFailed', 'The access change could not be confirmed.'), error: true });
  }
  const agentsTitle = t('plugins.database.access.agents', 'Agents');
  return <Stack gap="small">
    {/* The Environment's own agent choice and this one are one concept, titled "Agents". Four long options make it
        the shared field select (the control table); in a sheet or popover its title stands above it. The select says
        the level, so no line under it repeats (or, before Save, contradicts) it. */}
    <Field label={agentsTitle}>
      <Select presentation="field" label={agentsTitle} value={selected} disabled={notice?.pending}
        options={(Object.keys(choices) as DatabaseAgentAccessV1[]).map(agentAccess => ({ value: agentAccess, label: choices[agentAccess] }))}
        onChange={value => { const next = (Object.keys(choices) as DatabaseAgentAccessV1[]).find(key => key === value); if (next) setDraft(next); }} />
    </Field>
    <Action.Control action={setAgentAccess} title={t('plugins.database.access.save', 'Save')}
      disabled={selected === level || notice?.pending}
      reviewedInput={input}
      controller={{ prepare: () => ({ input }), onSettled: settle }} />
    {notice?.execution ? <Action.Failure execution={notice.execution} />
      : notice?.error ? <ErrorState layout="line" title={notice.text} />
      : notice ? <Text tone="secondary" variant="meta" value={notice.text} /> : null}
  </Stack>;
}

/** The database identity the page leads with; the Session rail uses the same header as its picker trigger. */
export function DatabaseIdentity(
  props: Readonly<{
    descriptor: DatabaseDescriptorV1;
    /** Inside another control (the rail tab's picker) the access word is said, not pressed. */
    accessAsText?: boolean;
  }>,
) {
  const translate = usePluginTranslation();
  const access = props.descriptor.access;
  return (
    <Row gap="small" align="flex-start">
      {/* The database's mark leads its name; the facts and access stand under the name (lab dbRail). */}
      <Icon name="database" tone="secondary" />
      <Stack gap="xsmall" grow>
      <Text
        variant="heading"
        value={props.descriptor.label}
        numberOfLines={1}
      />
      <Text
        variant="meta"
        tone="secondary"
        value={databaseFacts(props.descriptor)}
        numberOfLines={1}
      />
      {props.accessAsText ? (
        access ? (
          <Text
            variant="meta"
            tone="secondary"
            value={
              access.canWrite
                ? translate('plugins.database.access.canEdit', 'Can edit')
                : translate('plugins.database.access.readOnly', 'Read only')
            }
          />
        ) : null
      ) : (
        <AccessWord descriptor={props.descriptor} />
      )}
      </Stack>
    </Row>
  );
}

/**
 * An open schema's group: its count is the relations its first page read, said only when that page is the whole
 * schema. An unopened schema reads nothing, so it shows no count (no catalogue-count query, DBW-UILOGIC 23:39Z).
 */
function OpenSchemaGroup(
  props: Readonly<{
    targetKey: string;
    schema: string;
    onExpandedChange: (expanded: boolean) => void;
    children: React.ReactNode;
  }>,
) {
  const { relations, nextPageAfter, status } = useDatabaseSchemaRelations(props.targetKey, props.schema);
  const count = (status === 'ready' || status === 'empty') && nextPageAfter === undefined ? relations.length : undefined;
  return (
    <NavigationList.Group
      title={props.schema}
      {...(count === undefined ? {} : { count })}
      expanded
      onExpandedChange={props.onExpandedChange}
    >
      {props.children}
    </NavigationList.Group>
  );
}

/** Mounted only while its schema is open: unopened schemas read nothing. */
function SchemaRelations(
  props: Readonly<{
    targetKey: string;
    schema: string;
    query: string;
    translate: PluginTranslate;
    selected: DatabaseRelationV1 | undefined;
    onOpen: (intent: RailIntent) => void;
    mode: RailIntent['mode'] | undefined;
  }>,
) {
  const { relations, status, error, refresh, nextPage, previousPage } = useDatabaseSchemaRelations(
    props.targetKey,
    props.schema,
  );
  const relationIsCurrent = props.mode === 'data' || props.mode === 'structure';
  const needle = props.query.trim().toLowerCase();
  const shown = needle
    ? relations.filter((relation) =>
        relation.name.toLowerCase().includes(needle),
      )
    : relations;
  if (status === 'loading' && relations.length === 0)
    return <LoadingState layout="line" rows={4} rowShape="compact" />;
  if (status === 'unavailable') {
    return (
      <CatalogueReadFailure error={error} refresh={refresh} />
    );
  }
  return (
    <>
      {shown.map((relation) => {
        const value: DatabaseRelationV1 = {
          ...(props.selected?.database
            ? { database: props.selected.database }
            : {}),
          schema: props.schema,
          name: relation.name,
        };
        const rows = approxRowsLabel(relation.approxRows);
        return (
          <NavigationList.Row
            key={relation.name}
            title={relation.name}
            // A table or view says what it is by its mark; the estimate is the row's one quiet fact.
            icon={relation.kind === 'table' ? 'table' : 'view'}
            selected={relationIsCurrent && sameRelation(props.selected, value)}
            {...(rows ? { detail: rows } : {})}
            accessibilityLabel={relation.kind === 'table' ? relation.name : `${relation.name}, ${
              relation.kind === 'view'
                ? props.translate('plugins.database.rail.view', 'view')
                : props.translate('plugins.database.rail.matview', 'materialized view')}`}
            onPress={() =>
              props.onOpen({
                relation: value,
                mode: props.mode === 'structure' ? 'structure' : 'data',
              })
            }
          />
        );
      })}
      <CataloguePagination kind="tables" nextPage={nextPage} previousPage={previousPage} />
    </>
  );
}

/**
 * The workbench list column: the database's identity (`header`), Find a table, the database's own pages, then its
 * schemas, each folding its tables. The page and the Session rail mount this one column (the shell's navigation
 * column anatomy); only what a press opens differs.
 */
export function WorkbenchRailList(
  props: Readonly<{
    targetKey: string;
    /** What names the column: the database's identity, or the Session rail's picker. */
    header: React.ReactNode;
    /** What is open now; nothing is selected when nothing is open. */
    selected: Readonly<{
      mode: RailIntent['mode'];
      relation?: DatabaseRelationV1;
    }> | null;
    onOpen: (intent: RailIntent) => void;
    showOverview: boolean;
  }>,
) {
  const translate = usePluginTranslation();
  const { schemas, status, error, refresh, nextPage, previousPage } = useDatabaseRelations(
    props.targetKey,
  );
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () =>
      new Set(props.selected?.relation ? [props.selected.relation.schema] : []),
  );
  // The first schema opens by itself once known, unless the person already chose what is open.
  const firstSchema = schemas[0]?.name;
  React.useEffect(() => {
    if (firstSchema)
      setExpanded((held) => (held.size === 0 ? new Set([firstSchema]) : held));
  }, [firstSchema]);
  const setSchemaOpen = React.useCallback(
    (schema: string, open: boolean) =>
      setExpanded((held) => {
        const next = new Set(held);
        if (open) next.add(schema);
        else next.delete(schema);
        return next;
      }),
    [],
  );
  const mode = props.selected?.mode;
  const searching = query.trim().length > 0;
  return (
    <NavigationList
      titleControl={props.header}
      search={{
        value: query,
        onValueChange: setQuery,
        label: translate('plugins.database.rail.find', 'Find a table'),
      }}
    >
      <NavigationList.Group first>
        {props.showOverview ? (
          <NavigationList.Row
            title={translate('plugins.database.rail.overview', 'Overview')}
            icon="file"
            selected={mode === 'overview'}
            onPress={() => props.onOpen({ mode: 'overview' })}
          />
        ) : null}
        <NavigationList.Row
          title={translate('plugins.database.rail.console', 'Console')}
          icon="terminal"
          selected={mode === 'console'}
          onPress={() => props.onOpen({ mode: 'console' })}
        />
        {props.showOverview ? (
          <NavigationList.Row
            title={translate('plugins.database.rail.insights', 'Insights')}
            icon="chart"
            selected={mode === 'insights'}
            onPress={() => props.onOpen({ mode: 'insights' })}
          />
        ) : null}
      </NavigationList.Group>
      {status === 'loading' && schemas.length === 0 ? (
        <LoadingState layout="line" rows={6} rowShape="compact" />
      ) : null}
      {status === 'unavailable' ? (
        <CatalogueReadFailure error={error} refresh={refresh} />
      ) : null}
      {status === 'empty' ? (
        <Text
          tone="secondary"
          variant="meta"
          value={translate(
            'plugins.database.rail.noSchemas',
            'This database has no schemas yet',
          )}
        />
      ) : null}
      {schemas.map((schema) => {
        const open = expanded.has(schema.name) || searching;
        const onExpandedChange = (next: boolean) => setSchemaOpen(schema.name, next);
        return open ? (
          <OpenSchemaGroup key={schema.name} targetKey={props.targetKey} schema={schema.name} onExpandedChange={onExpandedChange}>
            <SchemaRelations
              targetKey={props.targetKey}
              schema={schema.name}
              query={query}
              translate={translate}
              selected={props.selected?.relation}
              onOpen={props.onOpen}
              mode={mode}
            />
          </OpenSchemaGroup>
        ) : (
          <NavigationList.Group key={schema.name} title={schema.name} expanded={false} onExpandedChange={onExpandedChange} />
        );
      })}
      <CataloguePagination kind="schemas" nextPage={nextPage} previousPage={previousPage} />
    </NavigationList>
  );
}

/** The page's rail: identity, then the list; presses navigate the page in place. */
export function WorkbenchRail(props: Readonly<{ targetKey: string }>) {
  const instance = useWorkbenchInstance();
  const location = useWorkbenchLocation();
  const descriptor = instance.target(props.targetKey);
  const open = React.useCallback(
    (intent: RailIntent) => {
      void location.navigate(
        intent.mode === 'overview'
          ? { mode: 'overview', relation: undefined }
          : intent.mode === 'console' || intent.mode === 'insights'
            ? { mode: intent.mode }
            : { mode: intent.mode, relation: intent.relation },
      );
    },
    [location],
  );
  const selected = React.useMemo(
    () => ({
      mode: location.mode,
      ...(location.relation ? { relation: location.relation } : {}),
    }),
    [location.mode, location.relation],
  );
  return (
    <WorkbenchRailList
      targetKey={props.targetKey}
      header={<DatabaseIdentity descriptor={descriptor} />}
      selected={selected}
      onOpen={open}
      showOverview
    />
  );
}
