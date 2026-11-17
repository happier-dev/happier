import * as React from 'react';
import type { DatabaseRelationV1 } from '@happier-dev/database-protocol';
import {
  EmptyState,
  ErrorState,
  Item,
  ItemGroup,
  LoadingState,
  Stack,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import { useStructure, useWorkbenchLocation } from '../hooks.js';

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
  return (
    <Stack gap="large">
      <ItemGroup
        title={translate('plugins.database.structure.columns', 'Columns')}
      >
        {structure.columns.map((column) => (
          <Item
            key={column.name}
            title={column.name}
            subtitle={[
              column.type,
              column.nullable
                ? null
                : translate('plugins.database.structure.notNull', 'not null'),
              column.default
                ? translate(
                    'plugins.database.structure.default',
                    'default {value}',
                    { value: column.default },
                  )
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            {...(keyed.has(column.name)
              ? {
                  detail: translate(
                    'plugins.database.structure.primaryKey',
                    'Primary key',
                  ),
                }
              : {})}
          />
        ))}
      </ItemGroup>
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
