import * as React from 'react';
import {
  IconButton,
  Icon,
  PageHeader,
  Row,
  Select,
  Stack,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import { CollectionConditionTokens } from '@happier-dev/plugin-ui/components';
import {
  useDatabaseSchemaRelations,
  useWorkbenchInstance,
  useWorkbenchLocation,
} from '../hooks.js';
import { bytesLabel, formatCount } from './sizes.js';

/**
 * A relation's identity (name over schema, rows and size) and its one toolbar: the Data/Structure switch, then what
 * narrows and orders the rows (`filters`, the sort token), then `trailing` (Export) at its end; Refresh stands at the
 * title's end, where the lab keeps the relation's own actions. The row wraps on a phone (lab dbBrowse/grid, gridp).
 */
export function RelationHeader(
  props: Readonly<{
    targetKey: string;
    /** The rows' filters (tokens + Filter), in Data. */
    filters?: React.ReactNode;
    /** The row actions, in Data. */
    trailing?: React.ReactNode;
  }>,
) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const location = useWorkbenchLocation();
  const relation = location.relation!;
  const previous = location.fkTrail.at(-1);
  // The relation's own facts from the schema page the rail already reads: its estimate and its size (lab grid).
  const summary = useDatabaseSchemaRelations(
    props.targetKey,
    relation.schema,
  ).relations.find((candidate) => candidate.name === relation.name) as
    | (ReturnType<typeof useDatabaseSchemaRelations>['relations'][number] & {
        size?: { bytes: string };
      })
    | undefined;
  const rows = formatCount(summary?.approxRows, { approximate: true, full: true });
  const size = bytesLabel(summary?.size?.bytes);
  // A view's structure is its query, so its second mode reads Definition (lab p7AddNow/viewDef).
  const isView = summary?.kind === 'view' || summary?.kind === 'matview';
  const modes = React.useMemo(
    () => [
      { value: 'data', label: translate('plugins.database.mode.data', 'Data') },
      {
        value: 'structure',
        label: isView
          ? translate('plugins.database.mode.definition', 'Definition')
          : translate('plugins.database.mode.structure', 'Structure'),
      },
    ],
    [isView, translate],
  );
  const sort = location.mode === 'data' ? location.sort[0] : undefined;
  const sortTokens = React.useMemo(
    () =>
      sort
        ? [
            {
              id: 'sort',
              label: sort.column,
              valueLabel:
                sort.direction === 'desc'
                  ? translate('plugins.database.sort.descending', 'descending')
                  : translate('plugins.database.sort.ascending', 'ascending'),
            },
          ]
        : [],
    [sort, translate],
  );
  return (
    <Stack gap="small">
      <PageHeader
        title={relation.name}
        meta={[
          { key: 'schema', text: relation.schema },
          ...(isView
            ? [
                {
                  key: 'kind',
                  text: translate('plugins.database.rail.view', 'view'),
                },
              ]
            : []),
          ...(rows
            ? [
                {
                  key: 'rows',
                  text: translate(
                    'plugins.database.directory.rowsLine',
                    '{rows} rows',
                    { rows },
                  ),
                },
              ]
            : []),
          ...(size ? [{ key: 'size', text: size }] : []),
        ]}
        {...(previous
          ? {
              // D27 #3: a reference jump keeps the way back to the row it came from.
              leading: (
                <IconButton
                  accessibilityLabel={translate(
                    'plugins.database.reference.back',
                    'Back to {table}',
                    {
                      table: previous.relation.name,
                    },
                  )}
                  icon={<Icon name="back" />}
                  onPress={() => void location.back()}
                />
              ),
            }
          : {})}
        actions={
          <IconButton
            accessibilityLabel={translate('plugins.database.refresh', 'Refresh')}
            icon={<Icon name="refresh" />}
            onPress={() => instance.refresh(props.targetKey, relation)}
          />
        }
      />
      <Row gap="small" align="center" wrap>
        <Select
          label={translate('plugins.database.mode.label', 'View')}
          presentation="segmented"
          options={modes}
          value={location.mode}
          onChange={(value) =>
            void location.navigate({
              mode: value === 'structure' ? 'structure' : 'data',
            })
          }
        />
        {props.filters}
        {sortTokens.length > 0 ? (
          <CollectionConditionTokens
            testIDPrefix="database-sort"
            tokens={sortTokens}
            onRemove={() => void location.navigate({ sort: [] })}
            labels={{
              remove: (column) =>
                translate(
                  'plugins.database.sort.clear',
                  'Clear sort by {column}',
                  { column },
                ),
              save: '',
            }}
          />
        ) : null}
        <Stack grow />
        {props.trailing}
      </Row>
    </Stack>
  );
}
