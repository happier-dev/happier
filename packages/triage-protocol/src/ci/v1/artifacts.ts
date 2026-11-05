import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { ForgeCiIdV1Schema, ForgeCiRunRefV1Schema } from './identity.js';
import { ForgeCiTimestampV1Schema } from './runs.js';

export const ForgeCiArtifactV1Schema = defineProtocolObject({ id: ForgeCiIdV1Schema, run: ForgeCiRunRefV1Schema, name: defineProtocolString(), sizeBytes: defineProtocolNumber({ integer: true, minimum: 0 }).optional(), digest: defineProtocolString().optional(), expiresAtMs: ForgeCiTimestampV1Schema.optional(), availability: defineProtocolUnion([defineProtocolLiteral('available'), defineProtocolLiteral('expired'), defineProtocolLiteral('unknown')]) }, { policy: 'closed' });
export type ForgeCiArtifactV1 = ReturnType<typeof ForgeCiArtifactV1Schema.parse>;
