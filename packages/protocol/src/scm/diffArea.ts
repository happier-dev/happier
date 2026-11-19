import type { z } from '../zodRuntimePolicy.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { defineProtocolLiteral, defineProtocolUnion } from '../plugins/actions/protocolComposableSchema.js';

export const ScmDiffAreaProtocolSchema = defineProtocolUnion([
  defineProtocolLiteral('included'), defineProtocolLiteral('pending'), defineProtocolLiteral('both'),
]);
export const ScmDiffAreaSchema = asProtocolZod(ScmDiffAreaProtocolSchema);
export type ScmDiffArea = z.infer<typeof ScmDiffAreaSchema>;
