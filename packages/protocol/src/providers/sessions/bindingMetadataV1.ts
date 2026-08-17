import { z } from 'zod';

import {
  ProviderModelDescriptorV1Schema,
} from '../../models/descriptor.js';
import { ProviderWireProtocolSchema } from '../capabilities/v1.js';
import {
  ProviderAgentTargetKeySchema,
  ProviderConnectionIdSchema,
  ProviderContributionKeySchema,
  ProviderLocalIdSchema,
} from '../ids.js';
import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '../../connect/connectedAccountPurposeBindings.js';
import { ProviderAdapterBindingKeyV1Schema } from './adapterBindingKeyV1.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import { ProviderPublicHeadersV1Schema } from '../publicHeadersSchema.js';
import { ProviderCredentialTransportV1Schema } from '../credentials/v1.js';
import { AgentProviderRequirementsV1Schema } from '../compatibility/v1.js';
import {
  createProviderBindingSecurityFingerprintV1,
} from '../securityFingerprintsV1.js';
import {
  ProviderManagedRuntimeDeclarationV1Schema,
  createProviderManagedPurposeBindingsEqualityKeyV1,
  resolveProviderManagedRuntimeDeclarationV1,
} from '../contributions/v1.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

export {
  AgentSessionProviderBindingV1Schema,
  type AgentSessionProviderBinding,
  type AgentSessionProviderBindingV1,
} from './agentSessionProviderBindingV1.js';

export const ProviderConnectionDisplaySnapshotV1Schema = z.object({
  providerName: z.string().trim().min(1).max(128),
  connectionName: z.string().trim().min(1).max(128),
  connectionRole: z.enum(['default', 'named']),
  connectionDisplayNameMode: z.enum(['automatic', 'custom']),
}).strict();
export type ProviderConnectionDisplaySnapshotV1 = z.infer<typeof ProviderConnectionDisplaySnapshotV1Schema>;

const RuntimeBindingFingerprintV1Schema =
  z.string().trim().min(1).max(512);

const ProviderRuntimeBindingBasisCommonV1Schema = z.object({
  v: z.literal(1),
  agentTargetKey: ProviderAgentTargetKeySchema,
  connectionId: ProviderConnectionIdSchema,
  contributionKey: ProviderContributionKeySchema.nullable(),
  runtimeCredentialTransport: ProviderCredentialTransportV1Schema.nullable(),
  prepared: z.object({
    v: z.literal(1),
    materialization: z.enum(['spawnEnv', 'engineConfig', 'configFile']),
    adapterBindingKey: ProviderAdapterBindingKeyV1Schema.optional(),
  }).strict(),
  adapterVersion: z.number().int().positive(),
  agentSupport: AgentProviderRequirementsV1Schema,
}).strict();

const ProviderRuntimeExternalBindingBasisV1Schema =
  ProviderRuntimeBindingBasisCommonV1Schema.extend({
    deployment: z.object({ kind: z.literal('external') }).strict(),
    endpoint: z.object({
      endpointTemplateId: ProviderLocalIdSchema,
      normalizedUrl: ProviderEndpointUrlSyntaxSchema,
      protocol: ProviderWireProtocolSchema,
      publicHeaders: ProviderPublicHeadersV1Schema,
    }).strict(),
    credentialAuthorization: z.object({
      connectionSecurityFingerprint: RuntimeBindingFingerprintV1Schema,
      grantFingerprint: RuntimeBindingFingerprintV1Schema,
      selectedSecretBindingId: RuntimeBindingFingerprintV1Schema.nullable(),
      selectedSecretRecordFingerprint:
        RuntimeBindingFingerprintV1Schema.nullable(),
    }).strict(),
  }).strict();

const ProviderRuntimeManagedBindingBasisV1Schema =
  ProviderRuntimeBindingBasisCommonV1Schema.extend({
    deployment: z.object({
      kind: z.literal('managedLocal'),
      implementationIdentity: asProtocolZod(PluginContributionIdentityV1Schema),
      managedRuntime: ProviderManagedRuntimeDeclarationV1Schema,
      purposeBindings: QualifiedConnectedAccountPurposeBindingsV1Schema,
    }).strict().transform((deployment) => ({
      ...deployment,
      managedRuntime: resolveProviderManagedRuntimeDeclarationV1({
        implementationIdentity: deployment.implementationIdentity,
        managedRuntime: deployment.managedRuntime,
      }),
    })),
    endpoint: z.object({
      endpointTemplateId: ProviderLocalIdSchema,
      protocol: ProviderWireProtocolSchema,
      publicHeaders: ProviderPublicHeadersV1Schema,
    }).strict(),
    credentialAuthorization: z.object({
      connectionSecurityFingerprint: RuntimeBindingFingerprintV1Schema,
      grantFingerprint: RuntimeBindingFingerprintV1Schema,
    }).strict(),
  }).strict();

export const ProviderRuntimeBindingBasisV1Schema = z.union([
  ProviderRuntimeExternalBindingBasisV1Schema,
  ProviderRuntimeManagedBindingBasisV1Schema,
]);
export type ProviderRuntimeBindingBasisV1 = z.infer<
  typeof ProviderRuntimeBindingBasisV1Schema
>;

export const SessionProviderBindingMetadataV1Schema = z.object({
  v: z.literal(1),
  connectionId: ProviderConnectionIdSchema,
  contributionKey: ProviderContributionKeySchema.nullable(),
  connectionRevision: z.number().int().nonnegative(),
  model: ProviderModelDescriptorV1Schema.optional(),
  managedPurposeBindings: QualifiedConnectedAccountPurposeBindingsV1Schema.optional(),
  protocol: ProviderWireProtocolSchema,
  materialization: z.enum(['spawnEnv', 'engineConfig', 'configFile']),
  adapterBindingKey: ProviderAdapterBindingKeyV1Schema.optional(),
  compatibilityFingerprint: z.string().trim().min(1).max(256),
  bindingSecurityFingerprint: z.string().trim().min(1).max(256),
  runtimeBindingBasis: ProviderRuntimeBindingBasisV1Schema.optional(),
  displaySnapshot: ProviderConnectionDisplaySnapshotV1Schema,
}).strict();
export type SessionProviderBindingMetadataV1 = z.infer<typeof SessionProviderBindingMetadataV1Schema>;

export const SessionProviderBindingSecurityChangeConfirmationV1Schema = z.object({
  v: z.literal(1),
  sessionId: z.string().trim().min(1).max(256),
  connectionId: ProviderConnectionIdSchema,
  previousBindingSecurityFingerprint: z.string().trim().min(1).max(256),
  nextBindingSecurityFingerprint: z.string().trim().min(1).max(256),
}).strict();
export type SessionProviderBindingSecurityChangeConfirmationV1 = z.infer<
  typeof SessionProviderBindingSecurityChangeConfirmationV1Schema
>;

export const SESSION_PROVIDER_BINDING_METADATA_KEY_V1 = 'providerBindingV1' as const;

export type SessionProviderBindingMetadataStateV1 = Readonly<
  | { kind: 'absent' }
  | { kind: 'valid'; binding: SessionProviderBindingMetadataV1 }
  | { kind: 'invalid' }
>;

export function readSessionProviderBindingMetadataStateV1(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): SessionProviderBindingMetadataStateV1 {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, SESSION_PROVIDER_BINDING_METADATA_KEY_V1)) {
    return { kind: 'absent' };
  }
  const parsed = SessionProviderBindingMetadataV1Schema.safeParse(
    metadata[SESSION_PROVIDER_BINDING_METADATA_KEY_V1],
  );
  return parsed.success
    ? { kind: 'valid', binding: parsed.data }
    : { kind: 'invalid' };
}

export function sessionProviderBindingMetadataMatchesRuntimeBasisV1(
  input: Readonly<{
    selection: Readonly<{
      agentTargetKey: string;
      providerConnectionId: string | null;
    }>;
    binding: SessionProviderBindingMetadataV1;
  }>,
): boolean {
  const basis = input.binding.runtimeBindingBasis;
  const model = input.binding.model;
  if (!basis || !model) return false;
  const structuralFactsMatch = input.selection.agentTargetKey === basis.agentTargetKey
    && input.selection.providerConnectionId === basis.connectionId
    && input.binding.connectionId === basis.connectionId
    && input.binding.contributionKey === basis.contributionKey
    && input.binding.protocol === basis.endpoint.protocol
    && input.binding.materialization === basis.prepared.materialization
    && (input.binding.adapterBindingKey ?? null)
      === (basis.prepared.adapterBindingKey ?? null)
    && (input.binding.managedPurposeBindings
      ? createProviderManagedPurposeBindingsEqualityKeyV1(
          input.binding.managedPurposeBindings,
        )
      : null)
      === (
        basis.deployment.kind === 'managedLocal'
          ? createProviderManagedPurposeBindingsEqualityKeyV1(
              basis.deployment.purposeBindings,
            )
          : null
      );
  if (!structuralFactsMatch) return false;

  try {
    const sharedFingerprintInput = {
      agentTargetKey: basis.agentTargetKey,
      connectionId: basis.connectionId,
      modelId: model.id,
      modelCapabilities: {
        ...(model.capabilities?.reasoningControls
          ? { reasoningControls: model.capabilities.reasoningControls }
          : {}),
      },
      endpointTemplateId: basis.endpoint.endpointTemplateId,
      protocol: basis.endpoint.protocol,
      publicHeaders: basis.endpoint.publicHeaders,
      materialization: basis.prepared.materialization,
      ...(basis.prepared.adapterBindingKey
        ? { adapterBindingKey: basis.prepared.adapterBindingKey }
        : {}),
      ...(basis.runtimeCredentialTransport
        ? {
            credentialDestination:
              basis.runtimeCredentialTransport.destination,
          }
        : {}),
      compatibilityFingerprint: input.binding.compatibilityFingerprint,
      adapterVersion: basis.adapterVersion,
    };
    const expectedFingerprint = basis.deployment.kind === 'managedLocal'
      ? createProviderBindingSecurityFingerprintV1({
          ...sharedFingerprintInput,
          deployment: {
            kind: 'managedLocal',
            implementationIdentity:
              basis.deployment.implementationIdentity,
            managedRuntime: basis.deployment.managedRuntime,
          },
        })
      : 'normalizedUrl' in basis.endpoint
        ? createProviderBindingSecurityFingerprintV1({
            ...sharedFingerprintInput,
            endpointUrl: basis.endpoint.normalizedUrl,
          })
        : null;
    if (expectedFingerprint === null) return false;
    return input.binding.bindingSecurityFingerprint === expectedFingerprint;
  } catch {
    return false;
  }
}

export function readSessionProviderBindingMetadataV1(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): SessionProviderBindingMetadataV1 | null {
  const state = readSessionProviderBindingMetadataStateV1(metadata);
  return state.kind === 'valid' ? state.binding : null;
}

export function applySessionProviderBindingMetadataV1<T extends Readonly<Record<string, unknown>>>(
  metadata: T,
  binding: SessionProviderBindingMetadataV1 | null,
): T & Readonly<Record<string, unknown>> {
  const next = { ...metadata } as Record<string, unknown>;
  if (binding) {
    next[SESSION_PROVIDER_BINDING_METADATA_KEY_V1] = SessionProviderBindingMetadataV1Schema.parse(binding);
  } else {
    delete next[SESSION_PROVIDER_BINDING_METADATA_KEY_V1];
  }
  return next as T & Readonly<Record<string, unknown>>;
}
