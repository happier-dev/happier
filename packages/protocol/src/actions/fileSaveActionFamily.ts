import { z } from 'zod/mini';
import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { DeploymentStageLogsReadInputV1Schema } from '../deployments/deploymentReadsV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const FileSaveInputSchema = z.strictObject({
  fileName: z.string().check(z.minLength(1)),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text'), text: z.string() }),
    z.strictObject({ kind: z.literal('deploymentLog'),
      reference: z.omit(DeploymentStageLogsReadInputV1Schema, { cursor: true, tail: true }) }),
  ]),
});
export type FileSaveInput = z.infer<typeof FileSaveInputSchema>;
export const FileSaveResultSchema = z.strictObject({ status: z.enum(['saved', 'canceled']) });

function createFileSaveActionSpecs() {
  return [{
    id: 'files.save', title: 'Save a text file',
    description: 'Save supplied text or a complete masked deployment step log on the answering client. Deployment log references reuse deployments.logs.read; clientId selects the answering app. Refuses without a client file handoff.',
    approval: { result: 'required' }, safety: 'safe', sideEffectClass: 'write',
    requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'files_save' },
    cli: { acceptsServerId: true, commands: [{ path: ['files', 'save'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: FileSaveInputSchema, outputSchema: FileSaveResultSchema,
    approvalInputCustody: 'live_only', projectObservationInput: () => ({}),
    approvalPresentation: { summary: () => 'Save a text file on the answering device. Its content stays private to this live invocation.' },
  }] as const satisfies readonly PreNormalizedActionSpec[];
}

export const FILE_SAVE_ACTION_SPECS: ReturnType<typeof createFileSaveActionSpecs> = lazyActionSpecArray(createFileSaveActionSpecs);
