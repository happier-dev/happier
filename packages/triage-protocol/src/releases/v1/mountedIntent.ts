import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
  ForgeReleaseBooleanV1Schema,
  ForgeReleaseIdV1Schema,
} from './releases.js';
import { ForgeReleaseMakeLatestV1Schema } from './operations.js';

const closed = { policy: 'closed' } as const;
const field = defineProtocolUnion([
  defineProtocolLiteral('tagName'),
  defineProtocolLiteral('targetCommitish'),
  defineProtocolLiteral('previousTagName'),
  defineProtocolLiteral('configurationFilePath'),
  defineProtocolLiteral('name'),
  defineProtocolLiteral('body'),
]);
/**
 * Operandless page and editor commands. `close` asks the open editor or pane to close behind the unsaved-change
 * guard; `discard` and `keepEditing` answer that guard; `useRemote` adopts GitHub's changed draft; `checkStatus`
 * reads the exact known target of a write whose answer was lost; `generate` reads GitHub's proposed notes.
 */
export const ForgeReleaseMountedCommandV1Schema = defineProtocolUnion([
  defineProtocolLiteral('refresh'),
  defineProtocolLiteral('compose'),
  defineProtocolLiteral('close'),
  defineProtocolLiteral('discard'),
  defineProtocolLiteral('keepEditing'),
  defineProtocolLiteral('useRemote'),
  defineProtocolLiteral('checkStatus'),
  defineProtocolLiteral('generate'),
]);
export type ForgeReleaseMountedCommandV1 = ReturnType<
  typeof ForgeReleaseMountedCommandV1Schema.parse
>;
export const ForgeReleaseMountedIntentOperationV1Schema = defineProtocolUnion([
  defineProtocolObject(
    { kind: defineProtocolLiteral('setSearch'), query: defineProtocolString() },
    closed,
  ),
  defineProtocolObject(
    {
      kind: defineProtocolLiteral('setFilter'),
      state: defineProtocolUnion([
        defineProtocolLiteral('all'),
        defineProtocolLiteral('published'),
        defineProtocolLiteral('drafts'),
        defineProtocolLiteral('prereleases'),
      ]),
    },
    closed,
  ),
  defineProtocolObject(
    {
      kind: defineProtocolLiteral('setField'),
      field,
      value: defineProtocolString(),
    },
    closed,
  ),
  defineProtocolObject(
    {
      kind: defineProtocolLiteral('setPrerelease'),
      value: ForgeReleaseBooleanV1Schema,
    },
    closed,
  ),
  defineProtocolObject(
    {
      kind: defineProtocolLiteral('setMakeLatest'),
      value: ForgeReleaseMakeLatestV1Schema,
    },
    closed,
  ),
  defineProtocolObject(
    {
      kind: defineProtocolLiteral('setPreview'),
      value: ForgeReleaseBooleanV1Schema,
    },
    closed,
  ),
  defineProtocolObject(
    {
      kind: defineProtocolLiteral('selectRelease'),
      releaseId: ForgeReleaseIdV1Schema,
    },
    closed,
  ),
  defineProtocolObject(
    {
      kind: defineProtocolLiteral('setExpanded'),
      releaseId: ForgeReleaseIdV1Schema,
      value: ForgeReleaseBooleanV1Schema,
    },
    closed,
  ),
  defineProtocolObject(
    {
      kind: defineProtocolLiteral('applyGenerated'),
      mode: defineProtocolUnion([
        defineProtocolLiteral('use'),
        defineProtocolLiteral('replace'),
      ]),
    },
    closed,
  ),
  defineProtocolObject(
    {
      kind: defineProtocolLiteral('loadMore'),
      resource: defineProtocolUnion([
        defineProtocolLiteral('list'),
        defineProtocolLiteral('detail'),
        defineProtocolLiteral('assets'),
      ]),
    },
    closed,
  ),
  // The page's buttons without operands, through the same guards as the person's controls.
  defineProtocolObject(
    {
      kind: defineProtocolLiteral('command'),
      command: ForgeReleaseMountedCommandV1Schema,
    },
    closed,
  ),
]);
export type ForgeReleaseMountedIntentOperationV1 = ReturnType<
  typeof ForgeReleaseMountedIntentOperationV1Schema.parse
>;
export const ForgeReleaseMountedIntentInputV1Schema = defineProtocolObject(
  {
    mountId: defineProtocolString({ minLength: 1 }),
    operation: ForgeReleaseMountedIntentOperationV1Schema,
  },
  closed,
);
export const ForgeReleaseMountedIntentResultV1Schema = defineProtocolObject(
  {
    status: defineProtocolUnion([
      defineProtocolLiteral('applied'),
      defineProtocolLiteral('unavailable'),
      defineProtocolLiteral('rejected'),
    ]),
  },
  closed,
);
export type ForgeReleaseMountedIntentResultV1 = ReturnType<
  typeof ForgeReleaseMountedIntentResultV1Schema.parse
>;
