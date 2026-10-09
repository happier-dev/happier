import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { MachineInstallationProofV1Schema, MachineInstallationProofPayloadV1Schema, signMachineInstallationProof, type MachineInstallationProofPayloadV1 } from '../identity/installationIdentity.js';
import { ManagedControllerCurrentnessV1Schema, ManagedCommittedIdleEvidenceV1Schema, ManagedControllerContextOutputV1Schema } from './actionsV1.js';
import { ManagedWakeTargetV1Schema } from './managedIntentV1.js';
import { ManagedResourceV1Schema, ManagedNativeOperationReferenceV1Schema, type ManagedResourceV1, type ManagedNativeOperationReferenceV1 } from './providerFactsV1.js';
import { ManagedControllerV1Schema, ManagedMachineV1Schema, type ManagedControllerV1 } from './managedMachineV1.js';
import { ExternalActionExecutionAuthorizationV1Schema, type ExternalActionExecutionAuthorizationV1 } from '../../actions/externalActionApi.js';

export const MANAGED_POLICY_PROOF_HEADER = 'x-happier-managed-policy-proof';
/** Reserved Home-to-installed-controller preparation; it never carries Project input. */
export const MANAGED_FINITE_WAKE_RPC_METHOD = 'managed.wake.finite.v1';
export const ManagedFiniteWakeRequestV1Schema = lazyZodSchema(() => z.object({
  target: ManagedWakeTargetV1Schema,
  actionOrigin: ExternalActionExecutionAuthorizationV1Schema,
}).strict().refine(value => value.target.origin.kind === 'finite-command'
  && value.target.origin.actionRequestId === value.actionOrigin.binding.requestId));
/** A host-owned policy purpose, never an external caller's Action authority. */
export const ManagedPolicyPurposeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retention'), evidence: ManagedCommittedIdleEvidenceV1Schema.optional() }).strict(),
  z.object({ kind: z.literal('accepted-input-start'), target: z.lazy(() => ManagedWakeTargetV1Schema) }).strict(),
  z.object({ kind: z.literal('creation-cleanup') }).strict(),
]));
export type ManagedPolicyPurposeV1 = z.infer<typeof ManagedPolicyPurposeV1Schema>;
export const ManagedPolicyAdmissionInputV1Schema = lazyZodSchema(() => ManagedControllerCurrentnessV1Schema.extend({ purpose: ManagedPolicyPurposeV1Schema }).strict());
export type ManagedPolicyAdmissionInputV1 = z.infer<typeof ManagedPolicyAdmissionInputV1Schema>;
export const ManagedPolicyCensusInputV1Schema = lazyZodSchema(() => z.object({ homeId: z.string().min(1), controller: ManagedControllerV1Schema, proof: MachineInstallationProofV1Schema }).strict());
export const ManagedPolicyCensusOutputV1Schema = lazyZodSchema(() => z.object({ machines: z.array(ManagedMachineV1Schema), targets: z.array(ManagedWakeTargetV1Schema) }).strict());
export function createManagedPolicyCensusProofV1(input: Readonly<{ homeId: string; controller: ManagedControllerV1; custodianAccountId: string; privateKey: string | Uint8Array }>) {
  return signMachineInstallationProof({ payload: { version: 1, machineId: input.controller.machineId, installationId: input.controller.installationId,
    accountId: input.custodianAccountId, managedPolicyCensus: { homeId: input.homeId } }, privateKey: input.privateKey });
}
export const ManagedPolicyAdmissionOutputV1Schema = lazyZodSchema(() => ManagedControllerContextOutputV1Schema.extend({ replayed: z.boolean() }).strict());
export const ManagedPolicyProofV1Schema = lazyZodSchema(() => z.object({
  payload: MachineInstallationProofPayloadV1Schema, purpose: ManagedPolicyPurposeV1Schema, proof: MachineInstallationProofV1Schema,
  actionOrigin: ExternalActionExecutionAuthorizationV1Schema.optional(),
}).strict());
export type ManagedPolicyProofV1 = z.infer<typeof ManagedPolicyProofV1Schema>;

/** Digests are signature inputs for exact native identity, purpose and HTTP bytes, not new persisted state. */
export function managedPolicyDigestV1(kind: 'resource' | 'purpose' | 'body', value: unknown): string {
  return computeCanonicalDomainSeparatedDigest(`happier-managed-policy-${kind}-v1`, [createCanonicalJsonSigningInput(value)]);
}
/** The installed signer binds the causal request too; it cannot be swapped between native phases. */
export function managedPolicyPurposeDigestV1(purpose: ManagedPolicyPurposeV1, actionOrigin?: ExternalActionExecutionAuthorizationV1): string {
  return managedPolicyDigestV1('purpose', actionOrigin ? { purpose, actionOrigin } : purpose);
}
export function createManagedPolicyProofV1(input: Readonly<{
  correlation: z.infer<typeof ManagedControllerCurrentnessV1Schema>; purpose: ManagedPolicyPurposeV1;
  custodianAccountId: string; path: string; body: unknown; privateKey: string | Uint8Array;
  actionOrigin?: ExternalActionExecutionAuthorizationV1;
}> & (Readonly<{ resource: ManagedResourceV1; nativeOperation?: never }>
  | Readonly<{ resource?: never; nativeOperation: ManagedNativeOperationReferenceV1 }>)): ManagedPolicyProofV1 {
  const correlation = ManagedControllerCurrentnessV1Schema.parse(input.correlation);
  const purpose = ManagedPolicyPurposeV1Schema.parse(input.purpose);
  const actionOrigin = input.actionOrigin === undefined ? undefined : ExternalActionExecutionAuthorizationV1Schema.parse(input.actionOrigin);
  const nativeTarget = input.resource === undefined ? ManagedNativeOperationReferenceV1Schema.parse(input.nativeOperation)
    : ManagedResourceV1Schema.parse(input.resource);
  if (input.resource === undefined && purpose.kind !== 'creation-cleanup') throw new Error('Pending native policy requires creation cleanup.');
  const payload: MachineInstallationProofPayloadV1 = { version: 1,
    machineId: correlation.controller.machineId, installationId: correlation.controller.installationId,
    accountId: input.custodianAccountId, managedPolicy: {
      ...correlation, purpose: purpose.kind, resourceDigest: managedPolicyDigestV1('resource', nativeTarget),
      purposeDigest: managedPolicyPurposeDigestV1(purpose, actionOrigin), method: 'POST', path: input.path,
      bodyDigest: managedPolicyDigestV1('body', input.body),
    },
  };
  return { payload, purpose, ...(actionOrigin ? { actionOrigin } : {}), proof: signMachineInstallationProof({ payload, privateKey: input.privateKey }) };
}
export function encodeManagedPolicyProofV1(value: ManagedPolicyProofV1): string {
  return encodeBase64(new TextEncoder().encode(createCanonicalJsonSigningInput(ManagedPolicyProofV1Schema.parse(value))), 'base64url');
}
export function decodeManagedPolicyProofV1(value: string): ManagedPolicyProofV1 | undefined {
  try {
    const decoded = ManagedPolicyProofV1Schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(value, 'base64url'))));
    return encodeManagedPolicyProofV1(decoded) === value ? decoded : undefined;
  } catch { return undefined; }
}
