import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '../plugins/actions/protocolComposableSchema.js';

const text = defineProtocolString({ minLength: 1 });
export const ScmFileViewedStateV1Schema = defineProtocolUnion([
  defineProtocolLiteral('viewed'), defineProtocolLiteral('unviewed'), defineProtocolLiteral('dismissed'),
]);
export type ScmFileViewedStateV1 = ProtocolSchemaOutput<typeof ScmFileViewedStateV1Schema>;

// The source owns classification. Preserve its non-secret code and pacing fact
// without importing a forge's business protocol into the shared SCM contract.
const unavailable = defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), failure: defineProtocolObject({
  class: text, code: text, detail: defineProtocolString().optional(),
  retryNotBeforeMs: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
}, { policy: 'closed' }) }, { policy: 'closed' });

/** One complete opened-source map, never a partially known page. */
export const ScmFileViewedReadResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('ready'), headOid: text,
    files: defineProtocolArray(defineProtocolObject({ path: text, state: ScmFileViewedStateV1Schema }, { policy: 'closed' })),
  }, { policy: 'closed' }), unavailable,
]);
export type ScmFileViewedReadResultV1 = ProtocolSchemaOutput<typeof ScmFileViewedReadResultV1Schema>;

/** Acknowledges the selected path; the source does not reread its own write. */
export const ScmFileViewedSetResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('ready'), path: text,
    state: defineProtocolUnion([defineProtocolLiteral('viewed'), defineProtocolLiteral('unviewed')]),
  }, { policy: 'closed' }), unavailable,
]);
export type ScmFileViewedSetResultV1 = ProtocolSchemaOutput<typeof ScmFileViewedSetResultV1Schema>;
