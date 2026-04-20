import { z } from 'zod';

import { OptionalStringSchema } from './_shared.js';

export const BackendRuntimeAdapterKindV1Schema = z.enum([
  'terminalRuntime',
  'directSessions',
  'attach',
  'sessionHandoff',
]);
export type BackendRuntimeAdapterKindV1 = z.infer<typeof BackendRuntimeAdapterKindV1Schema>;

/**
 * Stable plugin-facing runtime-adapter operation catalog.
 *
 * These operation names are the public ABI identifiers that plugin manifests
 * declare. Hosts may choose which of these stable operations they currently
 * execute, but protocol parsing remains additive so unsupported/future
 * operations can be rejected by host semantic validation instead of failing the
 * base wire parse.
 */
export const BackendRuntimeAdapterOperationCatalogV1 = Object.freeze({
  terminalRuntime: Object.freeze({
    launch: 'launch',
    discoverIdentity: 'discoverIdentity',
    bindTranscript: 'bindTranscript',
  }),
  directSessions: Object.freeze({
    validateSource: 'validateSource',
    listCandidates: 'listCandidates',
    getActivity: 'getActivity',
    pageTranscript: 'pageTranscript',
    readAfterTranscript: 'readAfterTranscript',
    resolveTakeoverSpawnOptions: 'resolveTakeoverSpawnOptions',
    acquireFollowLease: 'acquireFollowLease',
    canonicalizeLinkedSession: 'canonicalizeLinkedSession',
    resolveLinkIdentity: 'resolveLinkIdentity',
  }),
  attach: Object.freeze({
    evaluateEligibility: 'evaluateEligibility',
    probeReachability: 'probeReachability',
    run: 'run',
  }),
  sessionHandoff: Object.freeze({
    exportBundle: 'exportBundle',
    importBundle: 'importBundle',
  }),
}) satisfies Readonly<Record<BackendRuntimeAdapterKindV1, Readonly<Record<string, string>>>>;

type BackendRuntimeAdapterOperationCatalogV1 = typeof BackendRuntimeAdapterOperationCatalogV1;
export type BackendRuntimeAdapterOperationV1<
  TKind extends BackendRuntimeAdapterKindV1 = BackendRuntimeAdapterKindV1,
> = BackendRuntimeAdapterOperationCatalogV1[TKind][keyof BackendRuntimeAdapterOperationCatalogV1[TKind]];

function normalizeBackendRuntimeAdapterOperation(value: unknown): string {
  return String(value ?? '').trim();
}

export function isSupportedBackendRuntimeAdapterOperationV1(params: Readonly<{
  kind: BackendRuntimeAdapterKindV1;
  operation: string;
}>): boolean {
  const normalizedOperation = normalizeBackendRuntimeAdapterOperation(params.operation);
  if (!normalizedOperation) {
    return false;
  }

  const supportedOperations = Object.values(
    BackendRuntimeAdapterOperationCatalogV1[params.kind],
  ) as readonly string[];
  return supportedOperations.includes(normalizedOperation);
}

export const BackendRuntimeAdapterHandlerRefV1Schema = z.object({
  target: z.literal('daemon'),
  exportName: OptionalStringSchema,
}).passthrough();
export type BackendRuntimeAdapterHandlerRefV1 = z.infer<typeof BackendRuntimeAdapterHandlerRefV1Schema>;

const BackendRuntimeAdapterBaseV1Schema = z.object({
  runtimeAdapterApiVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  operation: z.string().trim().min(1),
  handler: BackendRuntimeAdapterHandlerRefV1Schema,
  compatibility: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const TerminalRuntimeBackendRuntimeAdapterV1Schema = BackendRuntimeAdapterBaseV1Schema.extend({
  kind: z.literal('terminalRuntime'),
});

const DirectSessionsBackendRuntimeAdapterV1Schema = BackendRuntimeAdapterBaseV1Schema.extend({
  kind: z.literal('directSessions'),
});

const AttachBackendRuntimeAdapterV1Schema = BackendRuntimeAdapterBaseV1Schema.extend({
  kind: z.literal('attach'),
});

const SessionHandoffBackendRuntimeAdapterV1Schema = BackendRuntimeAdapterBaseV1Schema.extend({
  kind: z.literal('sessionHandoff'),
});

export const BackendRuntimeAdapterV1Schema = z.discriminatedUnion('kind', [
  TerminalRuntimeBackendRuntimeAdapterV1Schema,
  DirectSessionsBackendRuntimeAdapterV1Schema,
  AttachBackendRuntimeAdapterV1Schema,
  SessionHandoffBackendRuntimeAdapterV1Schema,
]);
export type BackendRuntimeAdapterV1 = z.infer<typeof BackendRuntimeAdapterV1Schema>;
