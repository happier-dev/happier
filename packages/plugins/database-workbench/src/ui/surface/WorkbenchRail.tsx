import * as React from 'react';
import type {
  DatabaseDescriptorV1,
  DatabaseRelationV1,
} from '@happier-dev/database-protocol';
import {
  ErrorState,
  Icon,
  LoadingState,
  Popover,
  Row,
  Stack,
  Text,
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
import { approxRowsLabel } from './sizes.js';
import { databaseEngineName } from './engines.js';
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
  return [databaseEngineName(descriptor.engine), descriptor.origin.label]
    .filter(Boolean)
    .join(' · ');
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
  const { relations, status, error, refresh, nextPage, previousPage } = useDatabaseSchemaRelations(
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
        const rows = approxRowsLabel(relation.approxRows);
        return (
          <NavigationList.Row
            key={relation.name}
            title={relation.name}
            // A table or view says what it is by its mark; the estimate is the row's one quiet fact.
            icon={relation.kind === 'table' ? 'table' : 'view'}
            selected={sameRelation(props.selected, value)}
            {...(rows ? { detail: rows } : {})}
            accessibilityLabel={relation.kind === 'table' ? relation.name : `${relation.name}, ${
              relation.kind === 'view'
                ? props.translate('plugins.database.rail.view', 'view')
                : props.translate('plugins.database.rail.matview', 'materialized view')}`}
            onPress={() =>
              props.onOpen({
                relation: value,
                mode: props.structure ? 'structure' : 'data',
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
      {schemas.map((schema) => {
        const open = expanded.has(schema.name) || searching;
        return (
          <NavigationList.Group
            key={schema.name}
            title={schema.name}
            expanded={open}
            onExpandedChange={(next) => setSchemaOpen(schema.name, next)}
          >
            {open ? (
              <SchemaRelations
                targetKey={props.targetKey}
                schema={schema.name}
                query={query}
                translate={translate}
                selected={props.selected?.relation}
                onOpen={props.onOpen}
                structure={mode === 'structure'}
              />
            ) : null}
          </NavigationList.Group>
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
