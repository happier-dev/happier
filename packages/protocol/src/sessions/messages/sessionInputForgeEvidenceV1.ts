import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '../../plugins/actions/protocolComposableSchema.js';

/** Descriptive external evidence only. Its containing input owns the byte budget. */
export const SessionInputForgeEvidenceV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  items: defineProtocolArray(defineProtocolObject({
    source: defineProtocolObject({
      kind: defineProtocolUnion([
        defineProtocolLiteral('pullRequest'), defineProtocolLiteral('hostedCi'),
        defineProtocolLiteral('releaseNotes'), defineProtocolLiteral('alert'),
        defineProtocolLiteral('localTerminal'), defineProtocolLiteral('entry'),
      ]),
      label: defineProtocolString(),
      url: defineProtocolString().optional(),
    }, { policy: 'closed' }),
    author: defineProtocolObject({
      kind: defineProtocolUnion([
        defineProtocolLiteral('person'), defineProtocolLiteral('bot'),
        defineProtocolLiteral('process'), defineProtocolLiteral('unknown'),
      ]),
      label: defineProtocolString().optional(),
    }, { policy: 'closed' }),
    text: defineProtocolString(),
  }, { policy: 'closed' }), { minItems: 1 }),
}, { policy: 'closed' });
export type SessionInputForgeEvidenceV1 = ReturnType<typeof SessionInputForgeEvidenceV1Schema.parse>;
