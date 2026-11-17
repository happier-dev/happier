import * as React from 'react';
import type {
  DatabaseDescriptorV1,
  DatabaseRelationV1,
} from '@happier-dev/database-protocol';
import {
  ErrorState,
  Item,
  ItemGroup,
  LoadingState,
  Popover,
  ScrollArea,
  Stack,
  Text,
  TextField,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import {
  useDatabaseRelations,
  useDatabaseSchemaRelations,
  useWorkbenchInstance,
  useWorkbenchLocation,
} from '../hooks.js';
import { sameRelation } from '../location.js';

const compactCount = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});
function rowsLabel(approxRows: string | null): string | undefined {
  if (approxRows === null) return undefined;
  const value = Number(approxRows);
  return Number.isFinite(value) ? compactCount.format(value) : approxRows;
}

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
  const [open, setOpen] = React.useState(false);
  const access = props.descriptor.access;
  if (!access) return null;
  const word = access.canWrite
    ? translate('plugins.database.access.canEdit', 'Can edit')
    : translate('plugins.database.access.readOnly', 'Read only');
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={word}
      triggerAccessibilityLabel={word}
      triggerAppearance="text"
      triggerSize="small"
      triggerDisclosure
      {...(access.canWrite ? {} : { triggerIcon: 'locked' as const })}
    >
      <Stack gap="small">
        <Text
          value={
            access.canWrite
              ? translate(
                  'plugins.database.access.canEditLine',
                  'You can edit rows here. Every change is reviewed before it’s applied.',
                )
              : translate(
                  'plugins.database.access.readOnlyLine',
                  'You can browse tables and run read-only SQL. Editing is off for this database.',
                )
          }
        />
        <Text
          tone="secondary"
          variant="meta"
          value={translate(
            'plugins.database.access.agentsNone',
            'Agents can’t use this database yet.',
          )}
        />
      </Stack>
    </Popover>
  );
}

/** One fact line under the name: engine and where it came from, the same facts the Dev servers row shows. */
export function databaseFacts(descriptor: DatabaseDescriptorV1): string {
  return [descriptor.engine, descriptor.origin.label]
    .filter(Boolean)
    .join(' · ');
}

/** The database identity the page leads with; the Session rail uses the same header as its picker trigger. */
export function DatabaseIdentity(
  props: Readonly<{ descriptor: DatabaseDescriptorV1 }>,
) {
  return (
    <Stack gap="xsmall">
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
      <AccessWord descriptor={props.descriptor} />
    </Stack>
  );
}

function SchemaGroup(
  props: Readonly<{
    targetKey: string;
    schema: string;
    query: string;
    expanded: boolean;
    onToggle: (schema: string) => void;
    selected: DatabaseRelationV1 | undefined;
    onOpen: (intent: RailIntent) => void;
    structure: boolean;
  }>,
) {
  const translate = usePluginTranslation();
  return (
    <>
      <Item
        title={props.schema}
        onPress={() => props.onToggle(props.schema)}
        accessibilityHint={
          props.expanded
            ? translate('plugins.database.rail.collapse', 'Hide tables')
            : translate('plugins.database.rail.expand', 'Show tables')
        }
      />
      {props.expanded ? (
        <SchemaRelations {...props} translate={translate} />
      ) : null}
    </>
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
    structure: boolean;
  }>,
) {
  const { relations, status, error, refresh } = useDatabaseSchemaRelations(
    props.targetKey,
    props.schema,
  );
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
      <ErrorState
        layout="line"
        kind="unavailable"
        title={props.translate(
          'plugins.database.rail.failed',
          'Tables could not be read',
        )}
        details={error instanceof Error ? error.message : undefined}
        onRetry={refresh}
        retryLabel={props.translate('plugins.database.retry', 'Try again')}
      />
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
        const kind =
          relation.kind === 'table'
            ? null
            : relation.kind === 'view'
              ? props.translate('plugins.database.rail.view', 'view')
              : props.translate(
                  'plugins.database.rail.matview',
                  'materialized view',
                );
        const rows = rowsLabel(relation.approxRows);
        return (
          <Item
            key={relation.name}
            title={relation.name}
            selected={sameRelation(props.selected, value)}
            {...(kind ? { subtitle: kind } : {})}
            {...(rows ? { detail: rows } : {})}
            onPress={() =>
              props.onOpen({
                relation: value,
                mode: props.structure ? 'structure' : 'data',
              })
            }
          />
        );
      })}
    </>
  );
}

/**
 * The workbench list column: Find a table, the database's own pages, then its schemas. The page and the Session
 * rail mount this one list; only what a press opens differs.
 */
export function WorkbenchRailList(
  props: Readonly<{
    targetKey: string;
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
  const { schemas, status, error, refresh } = useDatabaseRelations(
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
  const toggle = React.useCallback(
    (schema: string) =>
      setExpanded((held) => {
        const next = new Set(held);
        if (next.has(schema)) next.delete(schema);
        else next.add(schema);
        return next;
      }),
    [],
  );
  const mode = props.selected?.mode;
  return (
    <Stack gap="medium">
      <TextField
        label={translate('plugins.database.rail.find', 'Find a table')}
        placeholder={translate('plugins.database.rail.find', 'Find a table')}
        value={query}
        onChange={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <ItemGroup surface="none">
        {props.showOverview ? (
          <Item
            title={translate('plugins.database.rail.overview', 'Overview')}
            selected={mode === 'overview'}
            onPress={() => props.onOpen({ mode: 'overview' })}
          />
        ) : null}
        <Item
          title={translate('plugins.database.rail.console', 'Console')}
          selected={mode === 'console'}
          onPress={() => props.onOpen({ mode: 'console' })}
        />
        {props.showOverview ? (
          <Item
            title={translate('plugins.database.rail.insights', 'Insights')}
            selected={mode === 'insights'}
            onPress={() => props.onOpen({ mode: 'insights' })}
          />
        ) : null}
      </ItemGroup>
      {status === 'loading' && schemas.length === 0 ? (
        <LoadingState layout="line" rows={6} rowShape="compact" />
      ) : null}
      {status === 'unavailable' ? (
        <ErrorState
          layout="line"
          kind="unavailable"
          title={translate(
            'plugins.database.rail.schemasFailed',
            'Schemas could not be read',
          )}
          details={error instanceof Error ? error.message : undefined}
          onRetry={refresh}
          retryLabel={translate('plugins.database.retry', 'Try again')}
        />
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
      <ItemGroup surface="none">
        {schemas.map((schema) => (
          <SchemaGroup
            key={schema.name}
            targetKey={props.targetKey}
            schema={schema.name}
            query={query}
            expanded={expanded.has(schema.name) || query.trim().length > 0}
            onToggle={toggle}
            selected={props.selected?.relation}
            onOpen={props.onOpen}
            structure={mode === 'structure'}
          />
        ))}
      </ItemGroup>
    </Stack>
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
    <ScrollArea>
      <Stack gap="medium">
        <DatabaseIdentity descriptor={descriptor} />
        <WorkbenchRailList
          targetKey={props.targetKey}
          selected={selected}
          onOpen={open}
          showOverview
        />
      </Stack>
    </ScrollArea>
  );
}
