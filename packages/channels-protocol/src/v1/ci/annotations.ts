import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { ForgeCiIdV1Schema, ForgeCiJobRefV1Schema } from './identity.js';

const coordinate = defineProtocolNumber({ integer: true, minimum: 1 });
export const ForgeCiAnnotationV1Schema = defineProtocolObject({ id: ForgeCiIdV1Schema, job: ForgeCiJobRefV1Schema, checkRunId: ForgeCiIdV1Schema, level: defineProtocolUnion([defineProtocolLiteral('notice'), defineProtocolLiteral('warning'), defineProtocolLiteral('error')]), message: defineProtocolString(), title: defineProtocolString().optional(), path: defineProtocolString().optional(), startLine: coordinate.optional(), endLine: coordinate.optional(), startColumn: coordinate.optional(), endColumn: coordinate.optional(), details: defineProtocolString().optional(), webUrl: defineProtocolString().optional() }, { policy: 'closed' });
export type ForgeCiAnnotationV1 = ReturnType<typeof ForgeCiAnnotationV1Schema.parse>;
export const ForgeCiAnnotationV1JsonSchema = /* @__PURE__ */ (() => ForgeCiAnnotationV1Schema.jsonSchema)();
