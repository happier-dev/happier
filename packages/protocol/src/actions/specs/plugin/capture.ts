import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { defineActionSpecs } from '../definition.js';
import type { PreNormalizedActionSpec } from '../definition.js';


export const CAPTURE_VIEW_ACTION_SPECS = Object.freeze(defineActionSpecs([
  {
    id: 'capture.view', executionPlacement: 'client', approvalPolicy: { pluginCaptureWaiver: true, requiredSurfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'rpc', 'api', 'plugin'] }, approval: {result: 'required'},
    title: 'View host capture',
    description: 'Allow one mounted plugin viewer to view the exact current host capture source. Approval is required by default and may be waived for that plugin in Actions settings.',
    safety: 'safe',
    approvalResultCustody: 'live_only',
    projectObservationOutput: () => ({ admitted: true }),
    placements: [],
    surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: false, rpc: false },
    sideEffectClass: 'read',
    inputSchema: lazyZodSchema(() => z.strictObject({ sourceId: z.string().check(z.minLength(1)), sourceOccurrenceId: z.string().check(z.minLength(1)) })),
    outputSchema: lazyZodSchema(() => z.strictObject({ admitted: z.literal(true), sourceId: z.string().check(z.minLength(1)), sourceOccurrenceId: z.string().check(z.minLength(1)) })),
    inputHints: { fields: [] },
  } satisfies PreNormalizedActionSpec,
] as const));
