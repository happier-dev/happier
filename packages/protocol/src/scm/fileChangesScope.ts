import type { z } from '../zodRuntimePolicy.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaInput, type ProtocolSchemaOutput } from '../plugins/actions/protocolComposableSchema.js';

/** The three File-page Changes scopes. Turn identity is explicit, never inferred from an ordinal. */
export const FileChangesScopeProtocolSchema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('turn'), turnId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('session') }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('workingTree') }, { policy: 'closed' }),
]);
export type FileChangesScope = ProtocolSchemaOutput<typeof FileChangesScopeProtocolSchema>;
export const FileChangesScopeSchema: z.ZodMiniType<FileChangesScope, ProtocolSchemaInput<typeof FileChangesScopeProtocolSchema>> = asProtocolZod(FileChangesScopeProtocolSchema);
