import * as React from 'react';
import type { DatabaseRelationV1 } from '@happier-dev/plugin-sdk/database';
import {
  CodeBlock,
  EmptyState,
  ErrorState,
  Item,
  ItemGroup,
  LoadingState,
  Row,
  Stack,
  Text,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  Collection,
  useHappierCollection,
  type CollectionAnatomy,
} from '@happier-dev/plugin-ui/components';
import { useStructure, useWorkbenchLocation } from '../hooks.js';

type StructureColumn = ReturnType<typeof useStructure>['columns'][number];
const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Columns are records people compare down a column (lab dbBrowse/structure): a table of name, type, whether a value
 * is required and its default, the key and reference said beside the type.
 */
function ColumnsTable(
  props: Readonly<{
    columns: readonly StructureColumn[];
    primaryKey: ReadonlySet<string>;
    references: ReadonlyMap<string, string>;
  }>,
) {
  const translate = usePluginTranslation();
  const model = useHappierCollection({
    items: props.columns,
    keyOf: (column) => column.name,
    openKey: null,
    onOpenChange: () => {},
  });
  const anatomy = React.useMemo<CollectionAnatomy<StructureColumn>>(() => {
    const text = (value: string, tone?: 'secondary') => (
      <Text variant="body" {...(tone ? { tone } : {})} value={value} numberOfLines={1} />
    );
    const typeLine = (column: StructureColumn) => {
      const key = props.primaryKey.has(column.name)
        ? translate('plugins.database.structure.primaryKey', 'Primary key')
        : props.references.get(column.name);
      return key ? `${column.type} · ${key}` : column.type;
    };
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: (column) => column.name,
      titleIdentifier: true,
      // Narrow (phone), the Type column drops: the row says its type and key under the name (lab structurep).
      byline: (column, layout) => (layout?.fieldColumns ? null : typeLine(column)),
      fields: [
        {
          key: 'type',
          title: translate('plugins.database.structure.type', 'Type'),
          minWidth: 200,
          priority: 4,
          render: (column) => text(typeLine(column), 'secondary'),
        },
        {
          key: 'null',
          title: translate('plugins.database.structure.nullTitle', 'Null'),
          minWidth: 88,
          priority: 2,
          render: (column) =>
            column.nullable
              ? text(translate('plugins.database.structure.nullable', 'nullable'), 'secondary')
              : text(translate('plugins.database.structure.required', 'required')),
        },
        {
          key: 'default',
          title: translate('plugins.database.structure.defaultTitle', 'Default'),
          minWidth: 160,
          priority: 1,
          render: (column) => text(column.default ?? '—', 'secondary'),
        },
      ],
      accessibilityLabel: (column) => column.name,
      columnTitles: { title: translate('plugins.database.structure.name', 'Name') },
    };
  }, [props.primaryKey, props.references, translate]);
  return (
    <Collection
      accessibilityLabel={translate('plugins.database.structure.columns', 'Columns')}
      title={translate('plugins.database.structure.columns', 'Columns')}
      header={(slots) => (
        <Row gap="small" align="center">
          {slots.title}
          <Text tone="secondary" variant="heading" value={String(props.columns.length)} />
        </Row>
      )}
      model={model}
      anatomy={anatomy}
      presentation="table"
      detail="none"
      collapsedGroups={EMPTY_SET}
      scroll="page"
      minListWidth={420}
      minDetailWidth={320}
      preferredListRatio={1}
    />
  );
}

/** Columns, keys, references and indexes: read once per relation and held for the session. */
export function RelationStructure(
  props: Readonly<{ relation: DatabaseRelationV1 }>,
) {
  const translate = usePluginTranslation();
  const location = useWorkbenchLocation();
  const structure = useStructure(props.relation);
  if (structure.status === 'loading')
    return <LoadingState layout="line" rows={6} />;
  if (structure.status === 'unsupported') {
    return (
      <ErrorState
        kind="unavailable"
        title={translate(
          'plugins.database.structure.failed',
          'Structure could not be read',
        )}
        details={
          structure.error instanceof Error ? structure.error.message : undefined
        }
        onRetry={structure.refresh}
        retryLabel={translate('plugins.database.retry', 'Try again')}
      />
    );
  }
  if (structure.status === 'empty')
    return (
      <EmptyState
        layout="line"
        title={translate(
          'plugins.database.structure.empty',
          'This relation has no columns',
        )}
      />
    );
  const keyed = new Set(structure.primaryKey);
  const references = new Map(
    structure.foreignKeys.flatMap((key) =>
      key.columns.map((column, index) => [
        column,
        `→ ${key.target.name}.${key.targetColumns[index] ?? ''}`,
      ] as const),
    ),
  );
  return (
    <Stack gap="large">
      {structure.viewDefinition ? (
        // D27 #7: a view's query as code. Changing it belongs in a migration, not an edit here.
        <Stack gap="small">
          <CodeBlock
            code={structure.viewDefinition}
            language="sql"
            copyLabel={translate('plugins.database.structure.copyDefinition', 'Copy definition')}
          />
          <Text
            tone="secondary"
            variant="meta"
            value={translate(
              'plugins.database.structure.viewNote',
              'Rows come from this query. To change what it shows, change the view in a migration.',
            )}
          />
        </Stack>
      ) : null}
      {structure.viewDefinition ? null : (
        // A view's Definition is its query alone (lab p7AddNow/viewDef); its columns head its Data.
        <ColumnsTable columns={structure.columns} primaryKey={keyed} references={references} />
      )}
      {structure.foreignKeys.length > 0 ? (
        <ItemGroup
          title={translate(
            'plugins.database.structure.references',
            'References',
          )}
        >
          {structure.foreignKeys.map((key) => (
            <Item
              key={`${key.columns.join(',')}>${key.target.schema}.${key.target.name}`}
              title={key.columns.join(', ')}
              subtitle={`${key.target.schema}.${key.target.name} (${key.targetColumns.join(', ')})`}
              onPress={() =>
                void location.navigate({ relation: key.target, mode: 'data' })
              }
            />
          ))}
        </ItemGroup>
      ) : null}
      {structure.indexes.length > 0 ? (
        <ItemGroup
          title={translate('plugins.database.structure.indexes', 'Indexes')}
        >
          {structure.indexes.map((index) => (
            <Item
              key={index.name}
              title={index.name}
              subtitle={index.columns
                .map((part) =>
                  part.kind === 'column' ? part.column : part.expression,
                )
                .join(', ')}
              {...(index.unique
                ? {
                    detail: translate(
                      'plugins.database.structure.unique',
                      'Unique',
                    ),
                  }
                : {})}
            />
          ))}
        </ItemGroup>
      ) : null}
    </Stack>
  );
}
