import { z } from 'zod/mini';
import { defineActionSpecs, type PreNormalizedActionSpec } from './actionSpecs.js';
import type { ActionId } from './actionIds.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

const metadata = {
  title: 'Declaration inference fixture',
  safety: 'safe',
  placements: [],
  approval: { result: 'optional' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  inputSchema: z.strictObject({ query: z.string() }),
  outputSchema: z.strictObject({ count: z.number() }),
} as const;

// Generated families occupy a variadic prefix in the production catalog.
const generatedFamily: readonly PreNormalizedActionSpec[] = [];
const family = defineActionSpecs([
  ...(generatedFamily satisfies readonly PreNormalizedActionSpec[]),
  {
    ...metadata,
    id: 'review.apply',
    // @ts-expect-error Plugin exposure is derived; a declaration cannot grant it.
    surfaces: { ...metadata.surfaces, plugin: true },
  } satisfies PreNormalizedActionSpec,
  { ...metadata, id: 'action.spec.search' } satisfies PreNormalizedActionSpec,
  { ...metadata, id: 'action.spec.get', surfaces: { ...metadata.surfaces, api: false } } satisfies PreNormalizedActionSpec,
] as const);

// The catalog filters widened factory ids before indexing literal rows.
type LiteralRow<T> = T extends { readonly id: infer Id }
  ? ActionId extends Id ? never : T
  : never;
type LiteralTupleRows<TSpecs extends readonly unknown[]> = {
  [Index in keyof TSpecs]: LiteralRow<TSpecs[Index]>;
}[number];
type Rows = LiteralTupleRows<typeof family>;
type Buckets = { [Row in Rows as Row['id']]: Row };
type HealthyId = Assert<Equal<Buckets['action.spec.search']['id'], 'action.spec.search'>>;
type HealthyInput = Assert<Equal<Buckets['action.spec.search']['inputSchema'], typeof metadata.inputSchema>>;
type HealthyOutput = Assert<Equal<Buckets['action.spec.search']['outputSchema'], typeof metadata.outputSchema>>;
type ApiExclusion = Assert<Equal<Buckets['action.spec.get']['surfaces']['api'], false>>;
type HealthyRowIsValid = Assert<Buckets['action.spec.search'] extends PreNormalizedActionSpec ? true : false>;

// A deferred family is an array of correlated rows rather than a fixed tuple.
// Projecting its keys together would mix every row's input and result schema.
const unionFamily: readonly (
  | (typeof metadata & { id: 'action.spec.search' })
  | (Omit<typeof metadata, 'inputSchema' | 'outputSchema'> & {
      id: 'action.spec.get';
      inputSchema: z.ZodMiniString;
      outputSchema: z.ZodMiniBoolean;
    })
)[] = [];
const unionProjection = defineActionSpecs(unionFamily);
type SearchRow = Extract<(typeof unionProjection)[number], { id: 'action.spec.search' }>;
type GetRow = Extract<(typeof unionProjection)[number], { id: 'action.spec.get' }>;
type CorrelatedSearchInput = Assert<Equal<SearchRow['inputSchema'], typeof metadata.inputSchema>>;
type CorrelatedGetResult = Assert<Equal<GetRow['outputSchema'], z.ZodMiniBoolean>>;
