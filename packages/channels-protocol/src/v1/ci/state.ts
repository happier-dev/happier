import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

const nonterminalPhase = defineProtocolUnion([defineProtocolLiteral('queued'), defineProtocolLiteral('running'), defineProtocolLiteral('waiting')]);
const terminalOutcome = defineProtocolUnion([defineProtocolLiteral('success'), defineProtocolLiteral('failure'), defineProtocolLiteral('cancelled'), defineProtocolLiteral('skipped'), defineProtocolLiteral('neutral'), defineProtocolLiteral('timed_out'), defineProtocolLiteral('action_required'), defineProtocolLiteral('startup_failure'), defineProtocolLiteral('stale'), defineProtocolLiteral('unknown')]);
const bucket = defineProtocolUnion([defineProtocolLiteral('passed'), defineProtocolLiteral('failed'), defineProtocolLiteral('pending'), defineProtocolLiteral('neutral'), defineProtocolLiteral('unknown')]);
const facts = { nativeLabel: defineProtocolString(), outcomeBucket: bucket };
export const ForgeCiStateV1Schema = defineProtocolUnion([
    defineProtocolObject({ ...facts, phase: nonterminalPhase, outcome: defineProtocolLiteral(null) }, { policy: 'closed' }),
    defineProtocolObject({ ...facts, phase: defineProtocolLiteral('completed'), outcome: terminalOutcome }, { policy: 'closed' }),
    defineProtocolObject({ ...facts, phase: defineProtocolLiteral('unknown'), outcome: defineProtocolLiteral('unknown') }, { policy: 'closed' }),
]);
export type ForgeCiStateV1 = ReturnType<typeof ForgeCiStateV1Schema.parse>;
export const ForgeCiStateV1JsonSchema = /* @__PURE__ */ (() => ForgeCiStateV1Schema.jsonSchema)();
