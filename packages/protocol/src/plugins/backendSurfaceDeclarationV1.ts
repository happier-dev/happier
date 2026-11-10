import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { PluginOptionalStringSchema } from './_shared.js';

export const BackendSurfaceKindV1Schema = lazyZodSchema(() => z.enum([
  'terminalRuntime',
  'attach',
  'handoff',
  'fork',
  'checkpoint',
]));
export type BackendSurfaceKindV1 = z.infer<typeof BackendSurfaceKindV1Schema>;

export const BackendSurfaceStaticSupportV1Schema = lazyZodSchema(() => z.enum([
  'unsupported',
  'supported',
  'conditional',
]));
export type BackendSurfaceStaticSupportV1 = z.infer<typeof BackendSurfaceStaticSupportV1Schema>;

export const AgentSurfaceAvailabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('available', [
  z.strictObject({
    available: z.literal(true),
  }),
  z.strictObject({
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
    retryable: z.optional(z.boolean()),
    safeMessage: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(1_000))),
  }),
]));
export type AgentSurfaceAvailabilityV1 = z.infer<typeof AgentSurfaceAvailabilityV1Schema>;

export const AttachSurfaceStaticMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  attachStrategy: z.enum(['terminal_host', 'provider_attach', 'remote_display']),
  topology: z.enum(['exclusive', 'shared']),
  locality: z.optional(z.enum(['same_machine', 'session_machine', 'network_reachable'])),
  maxClients: z.optional(z.nullable(z.number().check(z.int(), z.positive()))),
  requiresLocalAttachmentInfo: z.optional(z.boolean()),
  liveProbe: z.optional(z.enum(['none', 'optional', 'required'])),
}));
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

export const BackendSurfaceHandlerRefV1Schema = lazyZodSchema(() => z.looseObject({
  target: z.literal('daemon'),
  exportName: PluginOptionalStringSchema,
}));
export type BackendSurfaceHandlerRefV1 = z.infer<typeof BackendSurfaceHandlerRefV1Schema>;

const BackendSurfaceDeclarationBaseV1Schema = lazyZodSchema(() => z.strictObject({
  surfaceApiVersion: z._default(z.literal(1), 1),
  id: z.string().check(z.trim(), z.minLength(1)),
  operation: z.string().check(z.trim(), z.minLength(1)),
  support: z._default(BackendSurfaceStaticSupportV1Schema, 'supported'),
  handler: BackendSurfaceHandlerRefV1Schema,
}));

const TerminalRuntimeBackendSurfaceDeclarationV1Schema = lazyZodSchema(() => z.extend(BackendSurfaceDeclarationBaseV1Schema, {
  kind: z.literal('terminalRuntime'),
}));

const AttachBackendSurfaceDeclarationV1Schema = lazyZodSchema(() => z.extend(BackendSurfaceDeclarationBaseV1Schema, {
  kind: z.literal('attach'),
  staticMetadata: z.optional(AttachSurfaceStaticMetadataV1Schema),
}));

const HandoffBackendSurfaceDeclarationV1Schema = lazyZodSchema(() => z.extend(BackendSurfaceDeclarationBaseV1Schema, {
  kind: z.literal('handoff'),
}));

const ForkBackendSurfaceDeclarationV1Schema = lazyZodSchema(() => z.extend(BackendSurfaceDeclarationBaseV1Schema, {
  kind: z.literal('fork'),
}));

const CheckpointBackendSurfaceDeclarationV1Schema = lazyZodSchema(() => z.extend(BackendSurfaceDeclarationBaseV1Schema, {
  kind: z.literal('checkpoint'),
}));

export const BackendSurfaceDeclarationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  TerminalRuntimeBackendSurfaceDeclarationV1Schema,
  AttachBackendSurfaceDeclarationV1Schema,
  HandoffBackendSurfaceDeclarationV1Schema,
  ForkBackendSurfaceDeclarationV1Schema,
  CheckpointBackendSurfaceDeclarationV1Schema,
]));
export type BackendSurfaceDeclarationV1 = z.infer<typeof BackendSurfaceDeclarationV1Schema>;
