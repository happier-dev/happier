import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { DirectRouteGrantScopeV1Schema } from './directRouteGrantScopesV1.js';
import { createCanonicalJsonSigningInput } from '../../../crypto/canonicalJson.js';
import { DIRECT_ROUTE_GRANT_AUDIENCE_V1 } from './directRouteGrantV1.js';
import { PeerFlowKindV1Schema } from './flowKind.js';
import { AuthorizedPeerEndpointRouteKindV1Schema } from './routeKind.js';
import { decodeCanonicalBase64UrlFixedLength } from './strictBase64Url.js';
import { IrohEndpointIdV1Schema } from '../../../connectivity/iroh/endpointDescriptorV1.js';

export const PeerRouteEphemeralPublicKeyV2Schema = lazyZodSchema(() => fixedBase64UrlSchema(32));
export const PEER_ROUTE_EPHEMERAL_ED25519_KIND_V2 = 'ephemeral_ed25519' as const;

/** Machine/1 purposes bound to the existing grant flow and scope below. */
export const IROH_PEER_ROUTE_OPERATION_KINDS_V2 = ['finite_transfer', 'workspace_sync', 'tcp_tunnel'] as const;
export const IrohPeerRouteOperationKindV2Schema = lazyZodSchema(() => z.enum(IROH_PEER_ROUTE_OPERATION_KINDS_V2));

/** Closed application/transport identity of the party that opens `happier/machine/1`. */
export const IrohPeerInitiatorV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('machine'),
    machineId: z.string().check(z.minLength(1)),
    endpointId: IrohEndpointIdV1Schema,
  }),
  z.strictObject({
    kind: z.literal('account_client'),
    endpointId: IrohEndpointIdV1Schema,
  }),
]));

/** Closed target Machine identity and its currently published daemon transport identity. */
export const IrohPeerTargetV2Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  endpointId: IrohEndpointIdV1Schema,
}));

/** Signed machine/1 initiator/target relationship carried only by V2 `iroh_peer` grants. */
export const IrohPeerRouteBindingV2Schema = lazyZodSchema(() => z.strictObject({
  initiator: IrohPeerInitiatorV2Schema,
  target: IrohPeerTargetV2Schema,
  operationKind: IrohPeerRouteOperationKindV2Schema,
}).check(z.superRefine((binding, ctx) => {
  if (binding.initiator.kind === 'machine' && binding.initiator.machineId === binding.target.machineId) {
    ctx.addIssue({
      code: "custom",
      path: ['target', 'machineId'],
      message: 'Iroh initiator and target machines must be distinct',
    });
  }
  if (binding.initiator.endpointId === binding.target.endpointId) {
    ctx.addIssue({
      code: "custom",
      path: ['target', 'endpointId'],
      message: 'Iroh initiator and target endpoints must be distinct',
    });
  }
  if (binding.operationKind === 'workspace_sync' && binding.initiator.kind !== 'machine') {
    ctx.addIssue({
      code: "custom",
      path: ['initiator', 'kind'],
      message: 'Workspace sync requires a Machine initiator',
    });
  }
})));

export type IrohPeerRouteOperationKindV2 = z.infer<typeof IrohPeerRouteOperationKindV2Schema>;
export type IrohPeerInitiatorV2 = z.infer<typeof IrohPeerInitiatorV2Schema>;
export type IrohPeerTargetV2 = z.infer<typeof IrohPeerTargetV2Schema>;
export type IrohPeerRouteBindingV2 = z.infer<typeof IrohPeerRouteBindingV2Schema>;

/**
 * Iroh finite-transfer admission authorizes the carrier only. The prepared
 * transfer capability remains the sole operation and payload-size authority.
 */
export const IrohFiniteTransferCarrierGrantScopeV2Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('bounded_transfer'),
  mode: z.literal('carrier'),
}));

export const DirectRouteGrantScopeV2Schema = lazyZodSchema(() => z.union([
  DirectRouteGrantScopeV1Schema,
  IrohFiniteTransferCarrierGrantScopeV2Schema,
]));

export type DirectRouteGrantScopeV2 = z.infer<typeof DirectRouteGrantScopeV2Schema>;

type IrohPeerRouteGrantBindingFieldsV2 = Readonly<{
  machineId: string;
  flowKind: z.infer<typeof PeerFlowKindV1Schema>;
  routeKind: z.infer<typeof AuthorizedPeerEndpointRouteKindV1Schema>;
  endpointFingerprint?: string;
  scope: DirectRouteGrantScopeV2;
  iroh?: IrohPeerRouteBindingV2;
}>;

/** Canonical V2 payload/request invariant owner for the signed machine/1 relationship. */
function addIrohPeerRouteGrantBindingIssuesV2(
  payload: IrohPeerRouteGrantBindingFieldsV2,
  ctx: z.core.$RefinementCtx,
): void {
  if (payload.scope.kind === 'tcp_tunnel' && payload.scope.serviceExport
    && (payload.routeKind !== 'iroh_peer' || payload.iroh?.initiator.kind !== 'machine'
      || payload.iroh.operationKind !== 'tcp_tunnel')) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'serviceExport'], message: 'Service exports require the exact target and Machine-initiated Iroh TCP carrier.' });
  }
  if (payload.routeKind === 'iroh_peer') {
    const iroh = payload.iroh;
    if (!iroh) {
      ctx.addIssue({
        code: "custom",
        path: ['iroh'],
        message: 'Iroh peer grants require the machine/1 initiator/target binding',
      });
      return;
    }
    if (payload.machineId !== iroh.target.machineId) {
      ctx.addIssue({
        code: "custom",
        path: ['machineId'],
        message: 'Grant machineId must alias the Iroh binding target machine',
      });
    }
    if (payload.endpointFingerprint !== iroh.target.endpointId) {
      ctx.addIssue({
        code: "custom",
        path: ['endpointFingerprint'],
        message: 'Grant endpointFingerprint must alias the Iroh binding target endpoint',
      });
    }
    if (
      iroh.operationKind === 'finite_transfer'
      && (
        payload.flowKind !== 'bounded_transfer'
        || payload.scope.kind !== 'bounded_transfer'
        || payload.scope.mode !== 'carrier'
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ['iroh', 'operationKind'],
        message: 'Finite transfers require the carrier-only bounded_transfer scope',
      });
    }
    if (
      iroh.operationKind === 'tcp_tunnel'
      && (payload.flowKind !== 'tcp_tunnel' || payload.scope.kind !== 'tcp_tunnel')
    ) {
      ctx.addIssue({
        code: "custom",
        path: ['iroh', 'operationKind'],
        message: 'TCP tunnels require the signed tcp_tunnel destination scope',
      });
    }
    if (
      iroh.operationKind === 'workspace_sync'
      && (
        (payload.flowKind !== 'bounded_transfer' && payload.flowKind !== 'machine_rpc')
        || (payload.scope.kind === 'bounded_transfer' && payload.scope.mode === 'carrier')
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ['iroh', 'operationKind'],
        message: 'Workspace sync requires the bounded_transfer or machine_rpc flow',
      });
    }
  } else if (payload.iroh) {
    ctx.addIssue({
      code: "custom",
      path: ['iroh'],
      message: 'The machine/1 binding is only valid on iroh_peer grants',
    });
  } else if (payload.scope.kind === 'bounded_transfer' && payload.scope.mode === 'carrier') {
    ctx.addIssue({
      code: "custom",
      path: ['scope'],
      message: 'The carrier-only scope is valid only on iroh_peer grants',
    });
  }
}

function fixedBase64UrlSchema(decodedLength: number): z.ZodMiniString<string> {
  return z.string().check(z.refine((value) => decodeCanonicalBase64UrlFixedLength(value, decodedLength) !== null, `Expected canonical unpadded base64url encoding of ${decodedLength} bytes`));
}

export const DirectRouteGrantPayloadV2Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(2),
    grantId: z.string().check(z.minLength(1)),
    grantFamilyId: z.optional(z.string().check(z.minLength(1))),
    accountId: z.string().check(z.minLength(1)),
    /** Home-stamped credential authority for a private human continuation, never caller input. */
    callerAuthority: z.optional(z.enum(['present_user', 'account_automation'])),
    machineId: z.string().check(z.minLength(1)),
    flowKind: PeerFlowKindV1Schema,
    routeKind: AuthorizedPeerEndpointRouteKindV1Schema,
    scope: DirectRouteGrantScopeV2Schema,
    iat: z.number().check(z.int(), z.nonnegative()),
    exp: z.nullable(z.number().check(z.int(), z.positive())),
    aud: z.literal(DIRECT_ROUTE_GRANT_AUDIENCE_V1),
    endpointFingerprint: z.optional(z.string().check(z.minLength(1))),
    iroh: z.optional(IrohPeerRouteBindingV2Schema),
    proofKind: z.literal(PEER_ROUTE_EPHEMERAL_ED25519_KIND_V2),
    ephemeralPublicKeyBase64Url: PeerRouteEphemeralPublicKeyV2Schema,
  }).check(z.superRefine((payload, ctx) => {
    if (payload.scope.kind !== payload.flowKind) {
      ctx.addIssue({
        code: "custom",
        path: ['scope', 'kind'],
        message: 'Grant scope kind must match flow kind',
      });
    }
    const preview = payload.scope.kind === 'tcp_tunnel' ? payload.scope.preview : undefined;
    if (payload.exp === null && (!preview || payload.routeKind !== 'iroh_peer')) {
      ctx.addIssue({ code: "custom", path: ['exp'], message: 'Only registration-bound Iroh previews may omit expiry' });
    }
    if (preview && (payload.exp !== null || payload.machineId !== preview.machineId
      || payload.scope.kind !== 'tcp_tunnel' || payload.scope.allowedPorts.length !== 1
      || payload.scope.allowedPorts[0] !== preview.target.port || payload.routeKind !== 'iroh_peer')) {
      ctx.addIssue({ code: "custom", path: ['scope', 'preview'], message: 'Preview grants bind one registered target and its lifetime' });
    }
    if (payload.exp !== null && payload.exp <= payload.iat) {
      ctx.addIssue({
        code: "custom",
        path: ['exp'],
        message: 'Grant expiry must be after issue time',
      });
    }
    addIrohPeerRouteGrantBindingIssuesV2(payload, ctx);
  })));

export const DirectRouteGrantSignatureV2Schema = lazyZodSchema(() => z.strictObject({
    keyId: z.string().check(z.minLength(1)),
    alg: z.literal('Ed25519'),
    valueBase64Url: fixedBase64UrlSchema(64),
  }));

export const SignedDirectRouteGrantV2Schema = lazyZodSchema(() => z.strictObject({
    payload: DirectRouteGrantPayloadV2Schema,
    signature: DirectRouteGrantSignatureV2Schema,
  }));

export const DirectRouteGrantRequestV2Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(2),
    kind: z.literal(PEER_ROUTE_EPHEMERAL_ED25519_KIND_V2),
    ephemeralPublicKeyBase64Url: PeerRouteEphemeralPublicKeyV2Schema,
    machineId: z.string().check(z.minLength(1)),
    flowKind: PeerFlowKindV1Schema,
    routeKind: AuthorizedPeerEndpointRouteKindV1Schema,
    endpointFingerprint: z.string().check(z.minLength(1)),
    ttlMs: z.number().check(z.int(), z.positive()),
    scope: DirectRouteGrantScopeV2Schema,
    iroh: z.optional(IrohPeerRouteBindingV2Schema),
  }).check(z.superRefine((request, ctx) => {
    if (request.scope.kind !== request.flowKind) {
      ctx.addIssue({
        code: "custom",
        path: ['scope', 'kind'],
        message: 'Grant request scope kind must match flow kind',
      });
    }
    addIrohPeerRouteGrantBindingIssuesV2(request, ctx);
  })));

export type DirectRouteGrantPayloadV2 = z.infer<typeof DirectRouteGrantPayloadV2Schema>;
export type DirectRouteGrantSignatureV2 = z.infer<typeof DirectRouteGrantSignatureV2Schema>;
export type SignedDirectRouteGrantV2 = z.infer<typeof SignedDirectRouteGrantV2Schema>;
export type DirectRouteGrantRequestV2 = z.infer<typeof DirectRouteGrantRequestV2Schema>;

export function createDirectRouteGrantSigningInputV2(payload: DirectRouteGrantPayloadV2): string {
  return createCanonicalJsonSigningInput(DirectRouteGrantPayloadV2Schema.parse(payload));
}

export function createSignedDirectRouteGrantDigestInputV2(grant: SignedDirectRouteGrantV2): Uint8Array {
  const parsed = SignedDirectRouteGrantV2Schema.parse(grant);
  return new TextEncoder().encode(createCanonicalJsonSigningInput(parsed));
}
