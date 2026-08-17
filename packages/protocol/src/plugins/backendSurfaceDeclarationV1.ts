import { z } from 'zod';

import { PluginOptionalStringSchema } from './_shared.js';

export const BackendSurfaceKindV1Schema = z.enum([
  'terminalRuntime',
  'attach',
  'handoff',
  'fork',
  'checkpoint',
]);
export type BackendSurfaceKindV1 = z.infer<typeof BackendSurfaceKindV1Schema>;

export const BackendSurfaceStaticSupportV1Schema = z.enum([
  'unsupported',
  'supported',
  'conditional',
]);
export type BackendSurfaceStaticSupportV1 = z.infer<typeof BackendSurfaceStaticSupportV1Schema>;

export const BackendSurfaceAvailabilityV1Schema = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
  }).strict(),
  z.object({
    available: z.literal(false),
    reasonCode: z.enum([
      'provider_setting_disabled',
      'runtime_mode_unsupported',
      'session_state_unsupported',
      'cloud_plan_unavailable',
      'agent_unavailable',
      'missing_metadata',
      'unsupported',
      'evaluation_error',
    ]),
    retryable: z.boolean().optional(),
    safeMessage: z.string().trim().min(1).max(1_000).optional(),
  }).strict(),
]);
export type BackendSurfaceAvailabilityV1 = z.infer<typeof BackendSurfaceAvailabilityV1Schema>;

export const AttachSurfaceStaticMetadataV1Schema = z.object({
  attachStrategy: z.enum(['terminal_host', 'provider_attach', 'remote_display']),
  topology: z.enum(['exclusive', 'shared']),
  locality: z.enum(['same_machine', 'session_machine', 'network_reachable']).optional(),
  maxClients: z.number().int().positive().nullable().optional(),
  requiresLocalAttachmentInfo: z.boolean().optional(),
  liveProbe: z.enum(['none', 'optional', 'required']).optional(),
}).strict();
export type AttachSurfaceStaticMetadataV1 = z.infer<typeof AttachSurfaceStaticMetadataV1Schema>;

export const BackendSurfaceOperationCatalogV1 = Object.freeze({
  terminalRuntime: Object.freeze({
    evaluateAvailability: 'evaluateAvailability',
    launch: 'launch',
    discoverIdentity: 'discoverIdentity',
    resolveTranscriptBinding: 'resolveTranscriptBinding',
  }),
  attach: Object.freeze({
    evaluateAvailability: 'evaluateAvailability',
    attach: 'attach',
  }),
  handoff: Object.freeze({
    evaluateAvailability: 'evaluateAvailability',
    exportBundle: 'exportBundle',
    importBundle: 'importBundle',
  }),
  fork: Object.freeze({
    evaluateAvailability: 'evaluateAvailability',
    fork: 'fork',
    resolveReplayChildLaunch: 'resolveReplayChildLaunch',
  }),
  checkpoint: Object.freeze({
    evaluateAvailability: 'evaluateAvailability',
    list: 'list',
    resolveRestoreTarget: 'resolveRestoreTarget',
    checkpoint: 'checkpoint',
    restore: 'restore',
  }),
}) satisfies Readonly<Record<BackendSurfaceKindV1, Readonly<Record<string, string>>>>;

type BackendSurfaceOperationCatalogV1 = typeof BackendSurfaceOperationCatalogV1;
export type BackendSurfaceOperationV1<
  TKind extends BackendSurfaceKindV1 = BackendSurfaceKindV1,
> = BackendSurfaceOperationCatalogV1[TKind][keyof BackendSurfaceOperationCatalogV1[TKind]];

function normalizeBackendSurfaceOperation(value: unknown): string {
  return String(value ?? '').trim();
}

export function isSupportedBackendSurfaceOperationV1(params: Readonly<{
  kind: BackendSurfaceKindV1;
  operation: string;
}>): boolean {
  const normalizedOperation = normalizeBackendSurfaceOperation(params.operation);
  if (!normalizedOperation) {
    return false;
  }

  const supportedOperations = Object.values(
    BackendSurfaceOperationCatalogV1[params.kind],
  ) as readonly string[];
  return supportedOperations.includes(normalizedOperation);
}

export const BackendSurfaceHandlerRefV1Schema = z.object({
  target: z.literal('daemon'),
  exportName: PluginOptionalStringSchema,
}).passthrough();
export type BackendSurfaceHandlerRefV1 = z.infer<typeof BackendSurfaceHandlerRefV1Schema>;

const BackendSurfaceDeclarationBaseV1Schema = z.object({
  surfaceApiVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  operation: z.string().trim().min(1),
  support: BackendSurfaceStaticSupportV1Schema.default('supported'),
  handler: BackendSurfaceHandlerRefV1Schema,
  staticMetadata: z.record(z.string(), z.unknown()).optional(),
  compatibility: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const TerminalRuntimeBackendSurfaceDeclarationV1Schema = BackendSurfaceDeclarationBaseV1Schema.extend({
  kind: z.literal('terminalRuntime'),
});

const AttachBackendSurfaceDeclarationV1Schema = BackendSurfaceDeclarationBaseV1Schema.extend({
  kind: z.literal('attach'),
  staticMetadata: AttachSurfaceStaticMetadataV1Schema.optional(),
});

const HandoffBackendSurfaceDeclarationV1Schema = BackendSurfaceDeclarationBaseV1Schema.extend({
  kind: z.literal('handoff'),
});

const ForkBackendSurfaceDeclarationV1Schema = BackendSurfaceDeclarationBaseV1Schema.extend({
  kind: z.literal('fork'),
});

const CheckpointBackendSurfaceDeclarationV1Schema = BackendSurfaceDeclarationBaseV1Schema.extend({
  kind: z.literal('checkpoint'),
});

export const BackendSurfaceDeclarationV1Schema = z.discriminatedUnion('kind', [
  TerminalRuntimeBackendSurfaceDeclarationV1Schema,
  AttachBackendSurfaceDeclarationV1Schema,
  HandoffBackendSurfaceDeclarationV1Schema,
  ForkBackendSurfaceDeclarationV1Schema,
  CheckpointBackendSurfaceDeclarationV1Schema,
]);
export type BackendSurfaceDeclarationV1 = z.infer<typeof BackendSurfaceDeclarationV1Schema>;
