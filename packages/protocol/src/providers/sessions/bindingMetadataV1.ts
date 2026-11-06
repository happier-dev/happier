import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

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
import { ProviderGatewayPlacementV1Schema } from '../connections/v1.js';

import type { AgentProviderBindingLaunchMaterialization } from '../materialization/v1.js';
import {
  AgentSessionProviderBindingV1Schema,
  type AgentSessionProviderBindingV1,
} from './agentSessionProviderBindingV1.js';

export {
  AgentSessionProviderBindingUpstreamV1Schema,
  AgentSessionProviderBindingV1Schema,
  type AgentSessionProviderBinding,
  type AgentSessionProviderBindingUpstream,
  type AgentSessionProviderBindingV1,
} from './agentSessionProviderBindingV1.js';

export const ProviderConnectionDisplaySnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  providerName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  connectionName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  connectionRole: z.enum(['default', 'named']),
  connectionDisplayNameMode: z.enum(['automatic', 'custom']),
}));
export type ProviderConnectionDisplaySnapshotV1 = z.infer<typeof ProviderConnectionDisplaySnapshotV1Schema>;

const RuntimeBindingFingerprintV1Schema =
  lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512)));

const ProviderRuntimeBindingBasisCommonV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  agentTargetKey: ProviderAgentTargetKeySchema,
  connectionId: ProviderConnectionIdSchema,
  contributionKey: z.nullable(ProviderContributionKeySchema),
  runtimeCredentialTransport: z.nullable(ProviderCredentialTransportV1Schema),
  prepared: z.strictObject({
    v: z.literal(1),
    materialization: z.enum(['spawnEnv', 'engineConfig', 'configFile']),
    adapterBindingKey: z.optional(ProviderAdapterBindingKeyV1Schema),
  }),
  adapterVersion: z.number().check(z.int(), z.positive()),
  agentSupport: AgentProviderRequirementsV1Schema,
}));

const ProviderRuntimeExternalBindingBasisV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderRuntimeBindingBasisCommonV1Schema, {
    deployment: z.strictObject({ kind: z.literal('external') }),
    endpoint: z.strictObject({
      endpointTemplateId: ProviderLocalIdSchema,
      normalizedUrl: ProviderEndpointUrlSyntaxSchema,
      protocol: ProviderWireProtocolSchema,
      publicHeaders: ProviderPublicHeadersV1Schema,
    }),
    credentialAuthorization: z.strictObject({
      connectionSecurityFingerprint: RuntimeBindingFingerprintV1Schema,
      grantFingerprint: RuntimeBindingFingerprintV1Schema,
      selectedSecretBindingId: z.nullable(RuntimeBindingFingerprintV1Schema),
      selectedSecretRecordFingerprint:
        z.nullable(RuntimeBindingFingerprintV1Schema),
    }),
  })));

const ProviderRuntimeManagedBindingBasisV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderRuntimeBindingBasisCommonV1Schema, {
    deployment: z.pipe(z.strictObject({
      kind: z.literal('managedLocal'),
      gatewayPlacement: z.optional(ProviderGatewayPlacementV1Schema),
      implementationIdentity: asProtocolZod(PluginContributionIdentityV1Schema),
      managedRuntime: ProviderManagedRuntimeDeclarationV1Schema,
      purposeBindings: QualifiedConnectedAccountPurposeBindingsV1Schema,
    }), z.transform((deployment) => ({
      ...deployment,
      gatewayPlacement: deployment.gatewayPlacement ?? { kind: 'sessionMachine' as const },
      managedRuntime: resolveProviderManagedRuntimeDeclarationV1({
        implementationIdentity: deployment.implementationIdentity,
        managedRuntime: deployment.managedRuntime,
      }),
    }))),
    endpoint: z.strictObject({
      endpointTemplateId: ProviderLocalIdSchema,
      protocol: ProviderWireProtocolSchema,
      publicHeaders: ProviderPublicHeadersV1Schema,
    }),
    credentialAuthorization: z.strictObject({
      connectionSecurityFingerprint: RuntimeBindingFingerprintV1Schema,
      grantFingerprint: RuntimeBindingFingerprintV1Schema,
    }),
  })));

export const ProviderRuntimeBindingBasisV1Schema = lazyZodSchema(() => z.union([
  ProviderRuntimeExternalBindingBasisV1Schema,
  ProviderRuntimeManagedBindingBasisV1Schema,
]));
export type ProviderRuntimeBindingBasisV1 = z.infer<
  typeof ProviderRuntimeBindingBasisV1Schema
>;

export const SessionProviderBindingMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  connectionId: ProviderConnectionIdSchema,
  contributionKey: z.nullable(ProviderContributionKeySchema),
  connectionRevision: z.number().check(z.int(), z.nonnegative()),
  model: z.optional(ProviderModelDescriptorV1Schema),
  managedPurposeBindings: z.optional(QualifiedConnectedAccountPurposeBindingsV1Schema),
  protocol: ProviderWireProtocolSchema,
  materialization: z.enum(['spawnEnv', 'engineConfig', 'configFile']),
  adapterBindingKey: z.optional(ProviderAdapterBindingKeyV1Schema),
  compatibilityFingerprint: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  bindingSecurityFingerprint: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  runtimeBindingBasis: z.optional(ProviderRuntimeBindingBasisV1Schema),
  displaySnapshot: ProviderConnectionDisplaySnapshotV1Schema,
}));
export type SessionProviderBindingMetadataV1 = z.infer<typeof SessionProviderBindingMetadataV1Schema>;

export const SessionProviderBindingSecurityChangeConfirmationV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  connectionId: ProviderConnectionIdSchema,
  previousBindingSecurityFingerprint: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  nextBindingSecurityFingerprint: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));
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

  return input.binding.bindingSecurityFingerprint === createSessionProviderBindingFingerprintV1(input.binding);
}

/** Reconstruct from retained facts, including records written before declaration drift was excluded from continuity. */
export function createSessionProviderBindingFingerprintV1(
  binding: SessionProviderBindingMetadataV1,
  purpose: 'binding' | 'continuity' = 'binding',
): string | null {
  const basis = binding.runtimeBindingBasis;
  const model = binding.model;
  if (!basis || !model) return null;

  try {
    const sharedFingerprintInput = {
      agentTargetKey: basis.agentTargetKey,
      connectionId: basis.connectionId,
      // Model admission owns model changes; continuity compares their source and destination.
      modelId: purpose === 'continuity' ? 'continuity:v1' : model.id,
      modelCapabilities: purpose === 'continuity' ? {} : {
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
      compatibilityFingerprint: purpose === 'continuity' ? 'continuity:v1' : binding.compatibilityFingerprint,
      adapterVersion: purpose === 'continuity' ? 1 : basis.adapterVersion,
    };
    return basis.deployment.kind === 'managedLocal'
      ? createProviderBindingSecurityFingerprintV1({
          ...sharedFingerprintInput,
          deployment: {
            kind: 'managedLocal',
            gatewayPlacement: basis.deployment.gatewayPlacement,
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
  } catch {
    return null;
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

/**
 * Projects the public Agent-facing view of one live Provider binding from the
 * canonical launch metadata. This is the single owner of that projection so
 * every Agent entry point (Session open and execution-run launch) reports the
 * same upstream and credential facts.
 */
export function projectAgentSessionProviderBindingV1(
  input: Readonly<{
    metadata: SessionProviderBindingMetadataV1;
    materialization: AgentProviderBindingLaunchMaterialization;
  }>,
): AgentSessionProviderBindingV1 {
  const basis = input.metadata.runtimeBindingBasis;
  if (!basis) {
    throw new Error('An authorized Provider binding requires its runtime binding basis');
  }
  if (!input.metadata.model) {
    throw new Error('An authorized Provider binding requires its launch model descriptor');
  }
  return AgentSessionProviderBindingV1Schema.parse({
    connectionId: input.metadata.connectionId,
    model: input.metadata.model,
    upstream: {
      protocol: basis.endpoint.protocol,
      normalizedUrl: 'normalizedUrl' in basis.endpoint
        ? basis.endpoint.normalizedUrl
        : null,
      credential: basis.runtimeCredentialTransport === null ? 'none' : 'apiKey',
    },
    materialization: input.materialization,
  });
}
