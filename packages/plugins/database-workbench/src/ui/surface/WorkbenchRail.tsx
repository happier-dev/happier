import * as React from 'react';
import type { DatabaseRelationV1 } from '@happier-dev/database-protocol';
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

/** The access word, once, in the rail header; the Popover says what it means (decision E). */
function AccessWord(props: Readonly<{ targetKey: string }>) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const [open, setOpen] = React.useState(false);
  const access = instance.target(props.targetKey).access;
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

function SchemaGroup(
  props: Readonly<{
    targetKey: string;
    schema: string;
    query: string;
    expanded: boolean;
    onToggle: (schema: string) => void;
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
        <SchemaRelations
          targetKey={props.targetKey}
          schema={props.schema}
          query={props.query}
          translate={translate}
        />
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
  }>,
) {
  const location = useWorkbenchLocation();
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
          ...(location.relation?.database
            ? { database: location.relation.database }
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
        return (
          <Item
            key={relation.name}
            title={relation.name}
            selected={sameRelation(location.relation, value)}
            {...(kind ? { subtitle: kind } : {})}
            {...(rowsLabel(relation.approxRows)
              ? { detail: rowsLabel(relation.approxRows) }
              : {})}
            onPress={() =>
              void location.navigate({
                relation: value,
                mode: location.mode === 'structure' ? 'structure' : 'data',
              })
            }
          />
        );
      })}
    </>
  );
}

/** Identity, access, Find a table, the database's own pages, then its schemas. */
export function WorkbenchRail(props: Readonly<{ targetKey: string }>) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const location = useWorkbenchLocation();
  const descriptor = instance.target(props.targetKey);
  const { schemas, status, error, refresh } = useDatabaseRelations(
    props.targetKey,
  );
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(location.relation ? [location.relation.schema] : []),
  );
  // The first schema opens by itself once known, unless the person already chose what is open.
  const firstSchema = schemas[0]?.name;
  React.useEffect(() => {
    if (firstSchema && expanded.size === 0) setExpanded(new Set([firstSchema]));
  }, [firstSchema]); // eslint-disable-line react-hooks/exhaustive-deps
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
  return (
    <ScrollArea>
      <Stack gap="medium">
        <Stack gap="xsmall">
          <Text variant="heading" value={descriptor.label} numberOfLines={1} />
          <Text
            variant="meta"
            tone="secondary"
            value={[descriptor.engine, descriptor.origin.label]
              .filter(Boolean)
              .join(' · ')}
            numberOfLines={1}
          />
          <AccessWord targetKey={props.targetKey} />
        </Stack>
        <TextField
          label={translate('plugins.database.rail.find', 'Find a table')}
          placeholder={translate('plugins.database.rail.find', 'Find a table')}
          value={query}
          onChange={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <ItemGroup surface="none">
          <Item
            title={translate('plugins.database.rail.overview', 'Overview')}
            selected={location.mode === 'overview'}
            onPress={() =>
              void location.navigate({ mode: 'overview', relation: undefined })
            }
          />
          <Item
            title={translate('plugins.database.rail.console', 'Console')}
            selected={location.mode === 'console'}
            onPress={() => void location.navigate({ mode: 'console' })}
          />
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
            />
          ))}
        </ItemGroup>
      </Stack>
    </ScrollArea>
  );
}
