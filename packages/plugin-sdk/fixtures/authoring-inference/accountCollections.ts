import {
  definePlugin,
  type JsonValue,
} from '@happier-dev/plugin-sdk';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    defineAccountCollection,
    type PluginAccountCollectionDefinition,
    type PluginAccountCollectionForDefinition,
    type PluginAccountCollectionIndexes,
    type PluginAccountCollectionValue,
    type PluginCollectionBatchResult,
    type PluginCollectionIndexId,
    type PluginCollectionRow,
} from '@happier-dev/plugin-sdk/collections';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

type CollectionValue = Readonly<Record<string, JsonValue>>;
type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends (<T>() => T extends TRight ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;
type IsReadonlyArray<TValue extends readonly unknown[]> = TValue extends unknown[] ? false : true;

export const tasks = defineAccountCollection({
  id: 'tasks',
  schemaVersion: 1,
  schema: defineProtocolObject({
    id: defineProtocolString(),
    title: defineProtocolString(),
  }, { policy: 'closed' }),
  rowIdField: 'id',
  serverReadable: ['title'],
  identityFields: [],
  indexes: [{ id: 'by-title', fields: [{ field: 'title', direction: 'asc' }] }],
  uiQueries: [],
  relations: [],
});

type TypedTask = Readonly<{
  id: string;
  title: string;
  completed: boolean;
}>;

const typedTaskSchema = defineProtocolObject({
  id: defineProtocolString(),
  title: defineProtocolString(),
  completed: defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
  ]),
}, { policy: 'closed' });

const typedTasks = defineAccountCollection({
  id: 'typed-tasks',
  schemaVersion: 1,
  schema: typedTaskSchema,
  serverReadable: ['id'],
  identityFields: [],
  indexes: [],
  uiQueries: [],
  relations: [],
});

const composedTasks = defineAccountCollection({
  id: 'composed-tasks',
  schemaVersion: 1,
  schema: defineProtocolObject({
    id: defineProtocolString(),
    title: defineProtocolString(),
  }, { policy: 'closed' }),
  serverReadable: ['id'],
  identityFields: [],
  indexes: [],
  uiQueries: [],
  relations: [],
});

// Declarations are ordinary immutable author values. The same value must keep
// its schema and literal index information when used for manifest projection
// and when opened through the Account storage service.
const frozenTasksDefinition = {
  id: 'frozen-tasks',
  schemaVersion: 1,
  schema: typedTaskSchema,
  serverReadable: ['id'],
  identityFields: [],
  indexes: [{ id: 'by-title', fields: [{ field: 'title', direction: 'asc' }] }],
  uiQueries: [],
  relations: [],
} as const satisfies PluginAccountCollectionDefinition;
const frozenTasks = defineAccountCollection(frozenTasksDefinition);

type _LiteralValue = Expect<Equal<
  PluginAccountCollectionValue<typeof tasks>,
  Readonly<{ id: string; title: string }>
>>;
type _TypedValue = Expect<Equal<PluginAccountCollectionValue<typeof typedTasks>, TypedTask>>;
type _ComposedValue = Expect<Equal<
  PluginAccountCollectionValue<typeof composedTasks>,
  Readonly<{ id: string; title: string }>
>>;
type _TypedPutValue = Expect<Equal<
  Parameters<PluginAccountCollectionForDefinition<typeof typedTasks>['put']>[0],
  TypedTask
>>;
type _ComposedRowValue = Expect<Equal<
  Awaited<ReturnType<PluginAccountCollectionForDefinition<typeof composedTasks>['get']>>,
  PluginCollectionRow<Readonly<{ id: string; title: string }>> | null
>>;
type _FrozenValue = Expect<Equal<PluginAccountCollectionValue<typeof frozenTasks>, TypedTask>>;
type _FrozenIndexId = Expect<Equal<
  PluginCollectionIndexId<PluginAccountCollectionIndexes<typeof frozenTasks>>,
  'by-title'
>>;
type _BatchUpdatedResultsAreReadonly = Expect<Equal<
  IsReadonlyArray<Extract<PluginCollectionBatchResult<CollectionValue>, { status: 'updated' }>['results']>,
  true
>>;
type _BatchConflictsAreReadonly = Expect<Equal<
  IsReadonlyArray<Extract<PluginCollectionBatchResult<CollectionValue>, { status: 'conflict' }>['conflicts']>,
  true
>>;

export const plugin = definePlugin({
  id: 'example.account-collections',
  version: '0.1.0',
  accountCollections: {
    tasks,
  },
});

export const frozenPlugin = definePlugin({
  id: 'example.account-collections.frozen',
  version: '0.1.0',
  accountCollections: {
    'frozen-tasks': frozenTasks,
  },
});

declare const account: PluginAccountStorageScope;

const opened: PluginAccountCollectionForDefinition<typeof tasks> = account.collection(tasks);
const frozenOpened: PluginAccountCollectionForDefinition<typeof frozenTasks> = account.collection(frozenTasks);

void opened;
void frozenOpened;
void plugin.manifest;
void frozenPlugin.manifest;

if (false) {
  const scalarSchema = defineProtocolString();
  defineAccountCollection({
    id: 'scalar',
    schemaVersion: 1,
    // @ts-expect-error Collection logical values must be JSON objects.
    schema: scalarSchema,
    serverReadable: ['id'],
    indexes: [],
    uiQueries: [],
    relations: [],
  });

  const arraySchema = defineProtocolArray(defineProtocolString());
  defineAccountCollection({
    id: 'array',
    schemaVersion: 1,
    // @ts-expect-error Collection logical values must be JSON objects.
    schema: arraySchema,
    serverReadable: ['id'],
    indexes: [],
    uiQueries: [],
    relations: [],
  });

  const nullSchema = defineProtocolLiteral(null);
  defineAccountCollection({
    id: 'null',
    schemaVersion: 1,
    // @ts-expect-error Collection logical values must be JSON objects.
    schema: nullSchema,
    serverReadable: ['id'],
    indexes: [],
    uiQueries: [],
    relations: [],
  });

  definePlugin({
    id: 'example.account-collections.invalid',
    version: '0.1.0',
    accountCollections: {
      // @ts-expect-error Collection map keys must agree with the declaration's one canonical id.
      projects: tasks,
    },
  });
}
