import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  PROVIDER_WIRE_PROTOCOL_LIMITS_V1,
  ProviderCompatibilityCapabilitiesV1Schema,
  ProviderCompatibilityOverridesV1Schema,
  ProviderWireProtocolSchema,
} from '../capabilities/v1.js';
import {
  ProviderCatalogDeclarationV1Schema,
  providerCatalogProbeReportsModelLoadStateV1,
} from '../catalog/descriptorV1.js';
import { ProviderApiKeyCredentialRequirementV1Schema, ProviderCredentialDestinationV1Schema } from '../credentials/v1.js';
import { createProviderFingerprintV1 } from '../fingerprints.js';
import { ProviderDetectionDescriptorV1Schema } from '../detection/descriptorV1.js';
import { ProviderLocalIdSchema } from '../ids.js';
import { ProviderOriginRelativePathSchema } from '../originRelativePathSchema.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import { ProviderHttpsUrlSchema } from '../httpsUrlSchema.js';
import { ProviderPublicHeadersV1Schema } from '../publicHeadersSchema.js';
import { ProviderEndpointPolicyV1Shape } from '../endpointPolicyV1.js';
export { ProviderEndpointAddressConstraintV1Schema, ProviderModelIdPatternV1Schema, ProviderPublicHeaderHintsV1Schema, providerEndpointPolicySecurityFactsV1 } from '../endpointPolicyV1.js';
import { ProviderModelIdSchema } from '../ids.js';
import { ProviderAgentTargetKeySchema } from '../ids.js';
import { EnvironmentVariableSchema } from '../../profiles/environmentVariables.js';
import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
  type PluginContributionIdentityV1,
} from '../../plugins/contributionIdentity.js';
import { ProviderManagedPurposeOperationRestrictionV1Schema } from '../managedPurposeOperationRestrictionV1.js';
import { PluginLocalizedStringV2Schema, type PluginLocalizedStringV2 } from '../../plugins/contributions/publicTypes.js';
import type { ConnectedServiceCredentialKind } from '../../connect/connectedServiceCredentialKind.js';
import {
  ConnectedAccountPurposeDeclarationV1Schema,
  ConnectedAccountPurposeDeclarationsV1Schema,
  type PluginConnectedAccountMaterializationKind,
} from '../../connect/connectedAccountPurposes.js';
import {
  ConnectedAccountRequestAuthMaterializationV1Schema,
  ConnectedAccountRequestAuthUsesV1Schema,
  type ConnectedAccountRequestAuthUseV1,
} from '../../connect/connectedAccountRequestAuth.js';
import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  qualifiedPurposeKey,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '../../connect/connectedAccountPurposeBindings.js';
import { compareProviderCanonicalStringsV1 } from '../canonicalOrderV1.js';
import type { ProviderConnectionV1 } from '../connections/v1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";
import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';
import { ConnectedServiceQuotaMeterV1Schema } from '../../connect/connectedServiceSchemas.js';

const LegacyProfileEnvironmentNameSchema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Z_][A-Z0-9_]*$/u), z.maxLength(128)));

export const ProviderLegacyProfileMigrationDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  sourceProfileId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  descriptorRevision: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)), 1),
  implicitModelAliasReplacements: z._default(z.array(z.strictObject({
    legacyModelId: ProviderModelIdSchema,
    replacementModelId: ProviderModelIdSchema,
  })).check(z.maxLength(16)), []),
  credentialBinding: z.optional(z.strictObject({
    legacyEnvVarName: LegacyProfileEnvironmentNameSchema,
    credentialSlotId: ProviderLocalIdSchema,
  })),
  primaryModel: z.optional(z.strictObject({
    agentTargetKey: ProviderAgentTargetKeySchema,
    legacyEnvVarName: LegacyProfileEnvironmentNameSchema,
    defaultModelId: ProviderModelIdSchema,
    legacyProcessEnvAlias: z.optional(LegacyProfileEnvironmentNameSchema),
  })),
  migratedEnvironmentVariables: z._default(z.array(EnvironmentVariableSchema).check(z.maxLength(64)), []),
  retainedEnvironmentVariables: z._default(z.array(EnvironmentVariableSchema).check(z.maxLength(64)), []),
}).check(z.superRefine((value, ctx) => {
  const names = [...value.migratedEnvironmentVariables, ...value.retainedEnvironmentVariables].map((entry) => entry.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: 'custom', path: ['retainedEnvironmentVariables'], message: 'Legacy environment dispositions must be unique' });
  }
  if (value.primaryModel && !value.migratedEnvironmentVariables.some((entry) => entry.name === value.primaryModel?.legacyEnvVarName)) {
    ctx.addIssue({ code: 'custom', path: ['primaryModel', 'legacyEnvVarName'], message: 'Primary model environment must have a migrated disposition' });
  }
  const legacyIds = value.implicitModelAliasReplacements.map((entry) => entry.legacyModelId);
  if (new Set(legacyIds).size !== legacyIds.length) {
    ctx.addIssue({ code: 'custom', path: ['implicitModelAliasReplacements'], message: 'Implicit model aliases must be unique' });
  }
  value.implicitModelAliasReplacements.forEach((entry, index) => {
    if (entry.legacyModelId === entry.replacementModelId) {
      ctx.addIssue({ code: 'custom', path: ['implicitModelAliasReplacements', index], message: 'Implicit model alias replacement must change the model id' });
    }
  });
})));
export type ProviderLegacyProfileMigrationDescriptorV1 = z.infer<typeof ProviderLegacyProfileMigrationDescriptorV1Schema>;

export const ProviderEndpointTemplateV1Schema = lazyZodSchema(() => z.strictObject({
  id: ProviderLocalIdSchema,
  protocol: ProviderWireProtocolSchema,
  baseUrl: z.optional(ProviderEndpointUrlSyntaxSchema),
  localUrlCandidates: z.optional(z.array(ProviderEndpointUrlSyntaxSchema).check(z.minLength(1), z.maxLength(16))),
  publicHeaders: z.optional(ProviderPublicHeadersV1Schema),
  ...ProviderEndpointPolicyV1Shape,
  capabilities: ProviderCompatibilityCapabilitiesV1Schema,
}).check(z.superRefine((value, ctx) => {
  if ([Boolean(value.baseUrl), Boolean(value.localUrlCandidates), value.requiresEndpointOverride === true].filter(Boolean).length !== 1) {
    ctx.addIssue({ code: 'custom', message: 'Exactly one endpoint location is required' });
  }
})));
export type ProviderEndpointTemplateV1 = z.infer<typeof ProviderEndpointTemplateV1Schema>;

export const ProviderInlineCompletionOperationV1Schema = lazyZodSchema(() => z.strictObject({
  id: ProviderLocalIdSchema,
  mode: z.enum(['native-fim', 'raw-fim-template', 'chat-fallback', 'next-edit-codec']),
  codec: z.optional(z.literal('rewrite-window-v1')),
  endpointTemplateId: ProviderLocalIdSchema,
  path: ProviderOriginRelativePathSchema,
  wireFormat: z.enum(['ollama-generate', 'openai-text-completions', 'openai-chat', 'openai-responses', 'anthropic']),
}).check(z.refine(value => (value.mode === 'next-edit-codec') === (value.codec !== undefined), 'Only a dedicated next-edit operation selects a codec')));
export type ProviderInlineCompletionOperationV1 = z.infer<typeof ProviderInlineCompletionOperationV1Schema>;

export const ProviderModelLoadDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  endpointTemplateId: ProviderLocalIdSchema,
  path: ProviderOriginRelativePathSchema,
  request: z.literal('json-model-id-v1'),
  confirmation: z.literal('refresh-catalog-load-state'),
  preflightPolicy: z.enum(['advisory', 'required']),
}));
export type ProviderModelLoadDescriptorV1 = z.infer<typeof ProviderModelLoadDescriptorV1Schema>;

export const ProviderManagedConnectedAccountPurposeBindingPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  // V1 intentionally supports only the current author need: at least one
  // declared purpose must be bound. A literal avoids inventing arbitrary
  // cardinality policy while optional Providers remain valid with zero.
  minimumBound: z.literal(1),
}));
export type ProviderManagedConnectedAccountPurposeBindingPolicyV1 = z.infer<
  typeof ProviderManagedConnectedAccountPurposeBindingPolicyV1Schema
>;

/** Presentation only: no endpoint, materialization or request-auth authority. */
export const ProviderManagedUnavailableConnectedAccountPurposeV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: ConnectedAccountPurposeDeclarationV1Schema.shape.purpose,
  service: ConnectedAccountPurposeDeclarationV1Schema.shape.service,
  title: ConnectedAccountPurposeDeclarationV1Schema.shape.title,
  unavailableReason: PluginLocalizedStringV2Schema,
}));

const ProviderConnectedAccountDeclarationsV1Schema = lazyZodSchema(() => z.strictObject({
  connectedAccounts: z.optional(z.array(z.extend(ConnectedAccountPurposeDeclarationV1Schema, {
    /** Passive copy for a restriction enforced by the family's operation owner. */
    operationRestriction: z.optional(ProviderManagedPurposeOperationRestrictionV1Schema),
    /** Exact Provider endpoints supported by this upstream purpose; absent means no broker route. */
    endpointTemplateIds: z.optional(z.array(ProviderLocalIdSchema).check(z.minLength(1))),
    /** Credential-free compatibility catalog for this exact upstream service, never account entitlement. */
    staticModels: z.optional(z.array(ProviderModelDescriptorV1Schema)),
    /** Exact installed source that owns this service's account-aware model catalog. */
    catalogObservation: z.optional(z.union([
      z.strictObject({ provider: asProtocolZod(PluginContributionIdentityV1Schema) }),
      z.strictObject({ agent: asProtocolZod(PluginContributionIdentityV1Schema),
        /** Exact native selector namespace removed before Provider catalog use. */
        modelIdPrefix: z.optional(ProviderModelIdSchema),
      }),
    ])),
  })).check(z.superRefine((declarations, context) => {
    const checked = ConnectedAccountPurposeDeclarationsV1Schema.safeParse(
      declarations.map(({ endpointTemplateIds: _endpoints, staticModels: _models, catalogObservation: _observation, operationRestriction: _restriction, ...declaration }) => declaration),
    );
    if (!checked.success) checked.error.issues.forEach((issue) => context.addIssue({ ...issue }));
    declarations.forEach((declaration, index) => {
      if (declaration.staticModels === undefined) return;
      const catalog = ProviderCatalogDeclarationV1Schema.safeParse({
        source: 'static', manualModelPolicy: 'catalog-only', staticModels: declaration.staticModels,
      });
      if (!catalog.success) catalog.error.issues.forEach((issue) => context.addIssue({
        ...issue, path: [index, ...issue.path],
      }));
    });
  }))),
  requestAuthUses: z.optional(ConnectedAccountRequestAuthUsesV1Schema),
}));

const ProviderManagedRuntimeV1Fields = lazyZodSchema(() => z.strictObject({
  kind: z.literal('managed'),
  /** The managed runtime always supplies its declared client credential. */
  credentialRequired: z.optional(z.literal(true)),
  /** Opts connected-account request-auth consumers into daemon connection custody. */
  sharing: z.optional(z.literal('connectionMachine')),
  /** Implements the private exact-source envelope consumed by the host broker. */
  sourceEnvelopeTransport: z.optional(z.literal('cpx-v1')),
  dependencies: z.optional(z.array(asProtocolZod(PluginContributionLocalIdSchema)).check(z.maxLength(16))),
  unavailableConnectedAccounts: z.optional(z.readonly(z.array(ProviderManagedUnavailableConnectedAccountPurposeV1Schema))),
  connectedAccountPurposeBindingPolicy:
    z.optional(ProviderManagedConnectedAccountPurposeBindingPolicyV1Schema),
  endpointTemplateIds: z.array(ProviderLocalIdSchema).check(z.minLength(1), z.maxLength(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)),
}));

export const ProviderManagedRuntimeDeclarationV1Schema = lazyZodSchema(() => (
  ProviderManagedRuntimeV1Fields.check(z.superRefine((value, context) =>
    validateManagedRuntimeV1(value, issue => context.addIssue(issue))))
));
export type ProviderManagedRuntimeDeclarationV1 = z.infer<typeof ProviderManagedRuntimeDeclarationV1Schema>;

type AddProviderDeclarationIssue = (issue: { code: 'custom'; path: (string | number)[]; message: string }) => void;

function validateManagedRuntimeV1(
  value: z.infer<typeof ProviderManagedRuntimeV1Fields>,
  addIssue: AddProviderDeclarationIssue,
): void {
  const dependencies = value.dependencies ?? [];
  if (new Set(dependencies).size !== dependencies.length) {
    addIssue({ code: 'custom', path: ['dependencies'], message: 'Managed Provider dependencies must be unique' });
  }
  if (new Set(value.endpointTemplateIds).size !== value.endpointTemplateIds.length) {
    addIssue({ code: 'custom', path: ['endpointTemplateIds'], message: 'Managed Provider endpoint-template ids must be unique' });
  }
}

type ProviderConnectedAccountDeclarationsV1 = z.infer<typeof ProviderConnectedAccountDeclarationsV1Schema>;

function validateProviderConnectedAccountDeclarationsV1(
  value: ProviderConnectedAccountDeclarationsV1,
  allowedEndpointIds: ReadonlySet<string>,
  addIssue: AddProviderDeclarationIssue,
): void {
  const declarationsByPurpose = new Map(
    (value.connectedAccounts ?? []).map((declaration) => [
      declaration.purpose,
      declaration,
    ]),
  );
  for (const [index, declaration] of (value.connectedAccounts ?? []).entries()) {
    const purposeEndpoints = new Set<string>();
    for (const endpointTemplateId of declaration.endpointTemplateIds ?? []) {
      if (!allowedEndpointIds.has(endpointTemplateId) || purposeEndpoints.has(endpointTemplateId)) {
        addIssue({ code: 'custom', path: ['connectedAccounts', index, 'endpointTemplateIds'], message: 'Provider purpose endpoints must be declared and unique within the purpose' });
      }
      purposeEndpoints.add(endpointTemplateId);
    }
  }
  for (const [index, use] of (value.requestAuthUses ?? []).entries()) {
    const declaration = declarationsByPurpose.get(use.purpose);
    if (!declaration) {
      addIssue({
        code: 'custom',
        path: ['requestAuthUses', index, 'purpose'],
        message: 'Provider request-auth purpose must be declared by connectedAccounts',
      });
      continue;
    }
    if (declaration.materializationKinds?.includes(use.materialization.kind) !== true) {
      addIssue({
        code: 'custom',
        path: ['requestAuthUses', index, 'materialization', 'kind'],
        message: 'Provider request-auth materialization kind must be explicitly declared by its connected-account purpose',
      });
    }
  }
}

function validateManagedPurposeBindingPolicyV1(
  policy: ProviderManagedConnectedAccountPurposeBindingPolicyV1 | undefined,
  connectedAccounts: ProviderConnectedAccountDeclarationsV1['connectedAccounts'],
  path: (string | number)[],
  addIssue: AddProviderDeclarationIssue,
): void {
  if (policy && !connectedAccounts?.length) {
    addIssue({
      code: 'custom',
      path: [...path, 'connectedAccountPurposeBindingPolicy'],
      message: 'Managed Provider purpose binding policy requires a declared connected-account purpose',
    });
  }
}

/** Managed binding metadata stores the derived declarations with the runtime. */
export const ProviderManagedRuntimeSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  ...ProviderManagedRuntimeV1Fields.shape,
  ...ProviderConnectedAccountDeclarationsV1Schema.shape,
}).check(z.superRefine((value, context) => {
  validateManagedRuntimeV1(value, issue => context.addIssue(issue));
  validateManagedPurposeBindingPolicyV1(value.connectedAccountPurposeBindingPolicy, value.connectedAccounts, [], issue => context.addIssue(issue));
  validateProviderConnectedAccountDeclarationsV1(value, new Set(value.endpointTemplateIds), issue => context.addIssue(issue));
})));
export type ProviderManagedRuntimeSnapshotV1 = z.infer<typeof ProviderManagedRuntimeSnapshotV1Schema>;

export type ProviderConnectedAccountPurposeDeclarationV1 = NonNullable<ProviderConnectedAccountDeclarationsV1['connectedAccounts']>[number];

export type ResolvedProviderConnectedAccountPurposeDeclarationV1 =
  Readonly<{
    purpose: string;
    service: PluginContributionIdentityV1;
    title?: PluginLocalizedStringV2;
    required?: boolean;
    materializationKinds?: PluginConnectedAccountMaterializationKind[];
    credentialKinds?: ConnectedServiceCredentialKind[];
    endpointTemplateIds?: string[];
    staticModels?: ProviderConnectedAccountPurposeDeclarationV1['staticModels'];
    catalogObservation?: ProviderConnectedAccountPurposeDeclarationV1['catalogObservation'];
    operationRestriction?: ProviderConnectedAccountPurposeDeclarationV1['operationRestriction'];
  }>;

export type ResolvedProviderManagedConnectedAccountPurposeDeclarationV1 = ResolvedProviderConnectedAccountPurposeDeclarationV1;

export type ResolvedProviderConnectedAccountDeclarationsV1 = Readonly<{
  connectedAccounts: ResolvedProviderConnectedAccountPurposeDeclarationV1[];
  requestAuthUses: ConnectedAccountRequestAuthUseV1[];
}>;

export type ResolvedProviderManagedRuntimeDeclarationV1 = ResolvedProviderConnectedAccountDeclarationsV1 & Readonly<{
  kind: 'managed';
  credentialRequired?: true;
  sharing?: 'connectionMachine';
  sourceEnvelopeTransport?: 'cpx-v1';
  dependencies: string[];
  unavailableConnectedAccounts?: ReadonlyArray<Readonly<{
    purpose: string;
    service: PluginContributionIdentityV1;
    title?: PluginLocalizedStringV2;
    unavailableReason: PluginLocalizedStringV2;
  }>>;
  connectedAccountPurposeBindingPolicy?:
    ProviderManagedConnectedAccountPurposeBindingPolicyV1;
  endpointTemplateIds: string[];
}>;

/** Saved purpose intent admission shared by Account authoring and machine realization. */
export function resolveManagedPurposeBindingIntentsV1(
  connection: Pick<ProviderConnectionV1, 'purposeBindingDefaults'>,
  deployment: Readonly<{ implementationIdentity: PluginContributionIdentityV1; managedRuntime: ResolvedProviderManagedRuntimeDeclarationV1 }>,
): QualifiedConnectedAccountPurposeBindingsV1 | 'unbound' | null {
  const defaults = connection.purposeBindingDefaults ?? {};
  const declarationsByPurpose = new Map(deployment.managedRuntime.connectedAccounts.map(declaration => [declaration.purpose, declaration]));
  for (const [purpose, target] of Object.entries(defaults)) {
    const declaration = declarationsByPurpose.get(purpose);
    const service = target.kind === 'account' ? target.account.service : target.service;
    if (!declaration || declaration.service.pluginId !== service.pluginId || declaration.service.localId !== service.localId) return null;
  }
  if (Object.keys(defaults).length === 0 && (deployment.managedRuntime.connectedAccounts.some(declaration => declaration.required === true)
    || deployment.managedRuntime.connectedAccountPurposeBindingPolicy?.minimumBound === 1)) {
    // Empty configuration is editable, never runtime authority.
    return 'unbound';
  }
  if (deployment.managedRuntime.connectedAccounts.some(declaration => declaration.required === true && defaults[declaration.purpose] === undefined)) return null;
  const parsed = QualifiedConnectedAccountPurposeBindingsV1Schema.safeParse({ v: 1,
    bindings: Object.entries(defaults).map(([purpose, target]) => ({ purpose: { consumer: deployment.implementationIdentity, purpose }, target })) });
  return parsed.success ? parsed.data : null;
}

function canonicalProviderManagedPurposeBindingsV1(
  input: QualifiedConnectedAccountPurposeBindingsV1,
): QualifiedConnectedAccountPurposeBindingsV1 {
  const parsed = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(input);
  return {
    v: 1,
    bindings: [...parsed.bindings].sort((left, right) =>
      compareProviderCanonicalStringsV1(
        qualifiedPurposeKey(left.purpose),
        qualifiedPurposeKey(right.purpose),
      )),
  };
}

/**
 * Stable equality representation for a managed Provider's exact qualified
 * connected-account purpose bindings. Bindings are keyed by qualified purpose,
 * so their declaration order carries no runtime meaning.
 */
export function createProviderManagedPurposeBindingsEqualityKeyV1(
  input: QualifiedConnectedAccountPurposeBindingsV1,
): string {
  return JSON.stringify(canonicalProviderManagedPurposeBindingsV1(input));
}

/** Qualify contribution-local Connected Account references at the Provider boundary. */
export function resolveProviderConnectedAccountDeclarationsV1({ identity, definition }: Readonly<{
  identity: PluginContributionIdentityV1;
  definition: ProviderConnectedAccountDeclarationsV1;
}>): ResolvedProviderConnectedAccountDeclarationsV1 {
  const connectedAccounts:
    ResolvedProviderConnectedAccountPurposeDeclarationV1[] = (
      definition.connectedAccounts ?? []
    ).map((declaration) => {
      const service = PluginContributionIdentityV1Schema.parse(
        typeof declaration.service === 'string'
          ? {
              pluginId: identity.pluginId,
              localId: declaration.service,
            }
          : declaration.service,
      );
      const materializationKinds = declaration.materializationKinds
        ? [...declaration.materializationKinds].sort(
            compareProviderCanonicalStringsV1,
          )
        : undefined;
      if (materializationKinds) Object.freeze(materializationKinds);
      const credentialKinds = declaration.credentialKinds
        ? [...declaration.credentialKinds].sort(compareProviderCanonicalStringsV1)
        : undefined;
      if (credentialKinds) Object.freeze(credentialKinds);
      const purposeEndpointTemplateIds = declaration.endpointTemplateIds
        ? [...declaration.endpointTemplateIds].sort(compareProviderCanonicalStringsV1)
        : undefined;
      if (purposeEndpointTemplateIds) Object.freeze(purposeEndpointTemplateIds);
      const staticModels = declaration.staticModels?.map((model) => Object.freeze(model));
      if (staticModels) Object.freeze(staticModels);
      return Object.freeze({
        purpose: declaration.purpose,
        service: Object.freeze(service),
        ...(declaration.title === undefined
          ? {}
          : { title: declaration.title }),
        ...(declaration.required === undefined
          ? {}
          : { required: declaration.required }),
        ...(materializationKinds === undefined
          ? {}
          : { materializationKinds }),
        ...(credentialKinds === undefined ? {} : { credentialKinds }),
        ...(purposeEndpointTemplateIds === undefined ? {} : { endpointTemplateIds: purposeEndpointTemplateIds }),
        ...(staticModels === undefined ? {} : { staticModels }),
        ...(declaration.catalogObservation === undefined ? {} : { catalogObservation: Object.freeze(declaration.catalogObservation) }),
        ...(declaration.operationRestriction === undefined ? {} : { operationRestriction: Object.freeze(declaration.operationRestriction) }),
      });
    }).sort((left, right) =>
      compareProviderCanonicalStringsV1(left.purpose, right.purpose));
  const requestAuthUses: ConnectedAccountRequestAuthUseV1[] = (
    definition.requestAuthUses ?? []
  ).map((use) => Object.freeze({
    purpose: use.purpose,
    materialization: Object.freeze({
      ...use.materialization,
      ...(use.materialization.queryParameterNames === undefined ? {} : {
        queryParameterNames: Object.freeze([...use.materialization.queryParameterNames].sort(compareProviderCanonicalStringsV1)),
      }),
      headerNames: Object.freeze([
        ...use.materialization.headerNames,
      ].sort(compareProviderCanonicalStringsV1)),
    }),
  })).sort((left, right) =>
    compareProviderCanonicalStringsV1(left.purpose, right.purpose));
  Object.freeze(connectedAccounts);
  Object.freeze(requestAuthUses);
  return Object.freeze({ connectedAccounts, requestAuthUses });
}

/** Parse the runtime and its purpose facts from a managed binding snapshot. */
export function resolveProviderManagedRuntimeDeclarationV1(input: Readonly<{
  implementationIdentity: PluginContributionIdentityV1;
  managedRuntime:
    | ProviderManagedRuntimeSnapshotV1
    | ResolvedProviderManagedRuntimeDeclarationV1;
}>): ResolvedProviderManagedRuntimeDeclarationV1 {
  const implementationIdentity = PluginContributionIdentityV1Schema.parse(
    input.implementationIdentity,
  );
  const parsed = ProviderManagedRuntimeSnapshotV1Schema.parse(
    input.managedRuntime,
  );
  return normalizeProviderManagedRuntimeV1(implementationIdentity, parsed,
    resolveProviderConnectedAccountDeclarationsV1({ identity: implementationIdentity, definition: parsed }));
}

function normalizeProviderManagedRuntimeV1(
  implementationIdentity: PluginContributionIdentityV1,
  parsed: ProviderManagedRuntimeDeclarationV1,
  { connectedAccounts, requestAuthUses }: ResolvedProviderConnectedAccountDeclarationsV1,
): ResolvedProviderManagedRuntimeDeclarationV1 {
  const dependencies = [...(parsed.dependencies ?? [])].sort(
    compareProviderCanonicalStringsV1,
  );
  const endpointTemplateIds = [...parsed.endpointTemplateIds];
  const unavailableConnectedAccounts = parsed.unavailableConnectedAccounts?.map(declaration => Object.freeze({
    ...declaration,
    service: Object.freeze(PluginContributionIdentityV1Schema.parse(typeof declaration.service === 'string'
      ? { pluginId: implementationIdentity.pluginId, localId: declaration.service } : declaration.service)),
  }));
  if (unavailableConnectedAccounts) Object.freeze(unavailableConnectedAccounts);
  const connectedAccountPurposeBindingPolicy =
    parsed.connectedAccountPurposeBindingPolicy === undefined
      ? undefined
      : Object.freeze({ ...parsed.connectedAccountPurposeBindingPolicy });
  Object.freeze(dependencies);
  Object.freeze(endpointTemplateIds);
  return Object.freeze({
    kind: 'managed',
    ...(parsed.credentialRequired === undefined ? {} : { credentialRequired: parsed.credentialRequired }),
    ...(parsed.sharing === undefined ? {} : { sharing: parsed.sharing }),
    ...(parsed.sourceEnvelopeTransport === undefined ? {} : { sourceEnvelopeTransport: parsed.sourceEnvelopeTransport }),
    dependencies,
    ...(unavailableConnectedAccounts === undefined ? {} : { unavailableConnectedAccounts }),
    connectedAccounts,
    ...(connectedAccountPurposeBindingPolicy === undefined
      ? {}
      : { connectedAccountPurposeBindingPolicy }),
    requestAuthUses,
    endpointTemplateIds,
  });
}

/** Derive the managed binding snapshot from the single Provider declaration. */
export function resolveProviderManagedRuntimeFromContributionV1(input: Readonly<{
  implementationIdentity: PluginContributionIdentityV1;
  definition: ProviderConnectedAccountDeclarationsV1 & Readonly<{ managedRuntime: ProviderManagedRuntimeDeclarationV1 }>;
  connectedAccountDeclarations?: ResolvedProviderConnectedAccountDeclarationsV1;
}>): ResolvedProviderManagedRuntimeDeclarationV1 {
  return normalizeProviderManagedRuntimeV1(input.implementationIdentity, input.definition.managedRuntime,
    input.connectedAccountDeclarations ?? resolveProviderConnectedAccountDeclarationsV1({
      identity: input.implementationIdentity, definition: input.definition,
    }));
}

/**
 * Stable equality representation for a managed Provider declaration.
 * Endpoint-template order is intentionally retained: it is the declared
 * runtime request order, unlike the purpose-keyed fields. Presentation titles
 * are omitted because they do not change runtime behavior.
 */
export function createProviderManagedRuntimeDeclarationEqualityKeyV1(input: Readonly<{
  implementationIdentity: PluginContributionIdentityV1;
  managedRuntime:
    | ProviderManagedRuntimeSnapshotV1
    | ResolvedProviderManagedRuntimeDeclarationV1;
}>): string {
  const implementationIdentity = PluginContributionIdentityV1Schema.parse(
    input.implementationIdentity,
  );
  const managedRuntime = resolveProviderManagedRuntimeDeclarationV1({
    implementationIdentity,
    managedRuntime: input.managedRuntime,
  });
  const { unavailableConnectedAccounts: _unavailable, ...runtimeEffects } = managedRuntime;
  return JSON.stringify({
    implementationIdentity,
    managedRuntime: {
      ...runtimeEffects,
      connectedAccounts: managedRuntime.connectedAccounts.map(
        ({ title: _title, operationRestriction: _restriction, ...declaration }) => declaration,
      ),
    },
  });
}

/**
 * Stable equality representation for the managed binding facts that guard a
 * live Provider runtime.
 */
export function createProviderManagedRuntimeBindingEqualityKeyV1(input: Readonly<{
  implementationIdentity: PluginContributionIdentityV1;
  managedRuntime:
    | ProviderManagedRuntimeSnapshotV1
    | ResolvedProviderManagedRuntimeDeclarationV1;
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
}>): string {
  return JSON.stringify({
    declaration: createProviderManagedRuntimeDeclarationEqualityKeyV1({
      implementationIdentity: input.implementationIdentity,
      managedRuntime: input.managedRuntime,
    }),
    purposeBindings: createProviderManagedPurposeBindingsEqualityKeyV1(
      input.purposeBindings,
    ),
  });
}

/** The equality facts contain private purpose bindings. Only their opaque
 * digest may leave the Account's catalog owner in signed carrier authority. */
export function createProviderManagedRuntimeBindingFingerprintV1(
  input: Parameters<typeof createProviderManagedRuntimeBindingEqualityKeyV1>[0],
): string {
  return createProviderFingerprintV1('managed-runtime-binding',
    createProviderManagedRuntimeBindingEqualityKeyV1(input));
}

export const ProviderUsageSourceV1Schema = lazyZodSchema(() => z.strictObject({
  id: ProviderLocalIdSchema,
  endpointTemplateId: ProviderLocalIdSchema,
  path: ProviderOriginRelativePathSchema,
  parser: ProviderLocalIdSchema,
  /** Reuse the declared purpose's materialization and forward only these headers. */
  connectedAccount: z.optional(z.strictObject({
    purpose: ConnectedAccountPurposeDeclarationV1Schema.shape.purpose,
    headerNames: ConnectedAccountRequestAuthMaterializationV1Schema.shape.headerNames,
    /** Project only meters that apply to the selected Connected Account's reported plan. */
    omitMetersByPlan: z.optional(z.readonly(z.array(z.strictObject({
      planLabel: z.string().check(z.trim(), z.minLength(1)),
      meterIds: z.readonly(z.array(ProviderLocalIdSchema)),
    })))),
  })),
  /** Optional billing access; an unbound slot omits this source. */
  billingCredential: z.optional(z.strictObject({
    slotId: ProviderLocalIdSchema,
    title: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    keyUrl: z.optional(ProviderHttpsUrlSchema),
    destination: ProviderCredentialDestinationV1Schema,
  })),
}));
export type ProviderUsageSourceV1 = z.infer<typeof ProviderUsageSourceV1Schema>;
export const ProviderUsageParseResultV1Schema = lazyZodSchema(() => z.strictObject({
  meters: z.array(ConnectedServiceQuotaMeterV1Schema),
}));
export type ProviderUsageParseResultV1 = z.infer<typeof ProviderUsageParseResultV1Schema>;

export const ProviderContributionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  id: ProviderLocalIdSchema,
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  icon: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  websiteUrl: z.optional(ProviderHttpsUrlSchema),
  kind: z.enum(['frontier', 'aggregator', 'cloud', 'local']),
  // One endpoint per protocol, so this bound follows the protocol-declaration
  // bound rather than the bundled protocol count.
  endpointTemplates: z.array(ProviderEndpointTemplateV1Schema).check(z.minLength(1), z.maxLength(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)),
  credential: z.optional(ProviderApiKeyCredentialRequirementV1Schema),
  catalog: ProviderCatalogDeclarationV1Schema,
  modelLoad: z.optional(ProviderModelLoadDescriptorV1Schema),
  inlineCompletion: z.optional(z.array(ProviderInlineCompletionOperationV1Schema)),
  usageSources: z.optional(z.array(ProviderUsageSourceV1Schema)),
  /** Endpoints whose terminal usage carries a plugin-decoded charged USD amount. */
  requestCost: z.optional(z.strictObject({
    endpointTemplateIds: z.array(ProviderLocalIdSchema).check(z.minLength(1)),
  })),
  discovery: z.optional(ProviderDetectionDescriptorV1Schema),
  ...ProviderConnectedAccountDeclarationsV1Schema.shape,
  managedRuntime: z.optional(ProviderManagedRuntimeDeclarationV1Schema),
  compatibilityOverrides: z.optional(ProviderCompatibilityOverridesV1Schema),
  legacyProfileMigrations: z.optional(z.array(ProviderLegacyProfileMigrationDescriptorV1Schema).check(z.maxLength(8))),
}).check(z.superRefine((value, ctx) => {
  const endpointIds = new Set<string>();
  const protocols = new Set<string>();
  value.endpointTemplates.forEach((endpoint, index) => {
    if (endpointIds.has(endpoint.id)) ctx.addIssue({ code: 'custom', path: ['endpointTemplates', index, 'id'], message: 'Duplicate endpoint id' });
    if (protocols.has(endpoint.protocol)) ctx.addIssue({ code: 'custom', path: ['endpointTemplates', index, 'protocol'], message: 'Only one endpoint per protocol is allowed' });
    endpointIds.add(endpoint.id);
    protocols.add(endpoint.protocol);
    if (value.kind !== 'local' && !value.discovery && endpoint.localUrlCandidates) {
      ctx.addIssue({ code: 'custom', path: ['endpointTemplates', index, 'localUrlCandidates'], message: 'Local URL candidates require a local contribution or discovery descriptor' });
    }
    if (endpoint.localUrlCandidates
      && new Set(endpoint.localUrlCandidates).size !== endpoint.localUrlCandidates.length) {
      ctx.addIssue({ code: 'custom', path: ['endpointTemplates', index, 'localUrlCandidates'], message: 'Local URL candidates must be unique after normalization' });
    }
  });
  value.credential?.transports.forEach((transport, index) => {
    transport.protocols.forEach((protocol) => {
      if (!protocols.has(protocol)) ctx.addIssue({ code: 'custom', path: ['credential', 'transports', index, 'protocols'], message: 'Credential transport protocol is undeclared' });
    });
  });
  const usageIds = new Set<string>();
  const costEndpoints = value.requestCost?.endpointTemplateIds ?? [];
  if (new Set(costEndpoints).size !== costEndpoints.length || costEndpoints.some(id => !endpointIds.has(id))) {
    ctx.addIssue({ code: 'custom', path: ['requestCost', 'endpointTemplateIds'], message: 'Request cost endpoints must be unique declared endpoints' });
  }
  const billingSlots = new Map<string, string>();
  value.usageSources?.forEach((source, index) => {
    if (usageIds.has(source.id) || !endpointIds.has(source.endpointTemplateId)) {
      ctx.addIssue({ code: 'custom', path: ['usageSources', index], message: 'Usage source ids must be unique and name a declared endpoint' });
    }
    usageIds.add(source.id);
    if (source.connectedAccount) {
      const { purpose, headerNames } = source.connectedAccount;
      const family = value.connectedAccounts?.find(candidate => candidate.purpose === purpose);
      const use = value.requestAuthUses?.find(candidate => candidate.purpose === purpose);
      if (source.billingCredential || !family?.endpointTemplateIds?.includes(source.endpointTemplateId)
        || !use || headerNames.some(name => !use.materialization.headerNames.includes(name))) {
        ctx.addIssue({ code: 'custom', path: ['usageSources', index, 'connectedAccount'],
          message: 'Account usage must use a declared purpose, its endpoint and its materialized headers' });
      }
    }
    if (source.billingCredential) {
      const { slotId } = source.billingCredential;
      const descriptor = JSON.stringify(source.billingCredential);
      if (slotId === (value.credential?.slotId ?? 'apiKey') || (billingSlots.has(slotId) && billingSlots.get(slotId) !== descriptor)) {
        ctx.addIssue({ code: 'custom', path: ['usageSources', index, 'billingCredential'], message: 'Billing slots must be distinct from the connection key and have one descriptor' });
      }
      billingSlots.set(slotId, descriptor);
    }
  });
  const operationIds = new Set<string>();
  value.inlineCompletion?.forEach((operation, index) => {
    const endpoint = value.endpointTemplates.find(candidate => candidate.id === operation.endpointTemplateId);
    if (!endpoint || operationIds.has(operation.id)) {
      ctx.addIssue({ code: 'custom', path: ['inlineCompletion', index], message: 'Inline completion operation ids must be unique and name a declared endpoint' });
    }
    operationIds.add(operation.id);
    if (endpoint && value.credential && value.credential.transports.filter(transport => transport.protocols.includes(endpoint.protocol) && transport.uses.includes('runtime')).length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['inlineCompletion', index], message: 'Inline completion requires one runtime credential transport' });
    }
    const protocol = operation.wireFormat === 'ollama-generate' ? 'ollama-native' : operation.wireFormat === 'openai-text-completions' ? 'openai-completions' : operation.wireFormat;
    if (endpoint && endpoint.protocol !== protocol) {
      ctx.addIssue({ code: 'custom', path: ['inlineCompletion', index], message: 'Inline completion wire format must match its endpoint protocol' });
    }
    if (operation.mode === 'chat-fallback' && !['openai-chat', 'openai-responses', 'anthropic'].includes(operation.wireFormat)
      || operation.mode !== 'chat-fallback' && ['openai-chat', 'openai-responses', 'anthropic'].includes(operation.wireFormat)) {
      ctx.addIssue({ code: 'custom', path: ['inlineCompletion', index], message: 'Inline completion mode must match its wire format' });
    }
  });
  if ('probes' in value.catalog) {
    value.catalog.probes.forEach((probe, index) => {
      if (!endpointIds.has(probe.endpointTemplateId)) ctx.addIssue({ code: 'custom', path: ['catalog', 'probes', index, 'endpointTemplateId'], message: 'Catalog probe endpoint is not declared' });
    });
  }
  if (value.modelLoad) {
    if (value.kind !== 'local') ctx.addIssue({ code: 'custom', path: ['modelLoad'], message: 'Model loading is local-contribution only' });
    if (!endpointIds.has(value.modelLoad.endpointTemplateId)) ctx.addIssue({ code: 'custom', path: ['modelLoad', 'endpointTemplateId'], message: 'Model load endpoint is not declared' });
    const loadEndpoint = value.endpointTemplates.find((endpoint) => endpoint.id === value.modelLoad?.endpointTemplateId);
    const hasManagementTransport = !value.credential || Boolean(loadEndpoint && value.credential.transports.some((transport) =>
      transport.uses.includes('management') && transport.protocols.includes(loadEndpoint.protocol)));
    if (!hasManagementTransport) ctx.addIssue({ code: 'custom', path: ['modelLoad'], message: 'Authenticated model loading requires a management credential transport' });
    const hasLoadStateParser = 'probes' in value.catalog && value.catalog.probes.some((probe) =>
      probe.endpointTemplateId === value.modelLoad?.endpointTemplateId
      && providerCatalogProbeReportsModelLoadStateV1(probe));
    if (!hasLoadStateParser) ctx.addIssue({ code: 'custom', path: ['modelLoad'], message: 'Model loading requires a catalog parser that reports load state' });
  }
  if (value.discovery) {
    if (!endpointIds.has(value.discovery.availabilityProbe.endpointTemplateId)) {
      ctx.addIssue({ code: 'custom', path: ['discovery', 'availabilityProbe', 'endpointTemplateId'], message: 'Discovery availability endpoint is not declared' });
    }
    if (value.discovery.catalogFallback && !endpointIds.has(value.discovery.catalogFallback.endpointTemplateId)) {
      ctx.addIssue({ code: 'custom', path: ['discovery', 'catalogFallback', 'endpointTemplateId'], message: 'Discovery catalog fallback endpoint is not declared' });
    }
    if (value.discovery.catalogFallback && (
      !('probes' in value.catalog)
      || !value.catalog.probes.some((probe) => probe.endpointTemplateId === value.discovery?.catalogFallback?.endpointTemplateId)
    )) {
      ctx.addIssue({ code: 'custom', path: ['discovery', 'catalogFallback', 'endpointTemplateId'], message: 'Discovery catalog fallback requires an authorized catalog probe on the same endpoint' });
    }
  }
  // A managed dynamic catalog has no durable endpoint URL to carry accidental
  // source drift. Its declared semantic source version is therefore part of
  // every managed request/catalog fingerprint. External endpoint catalogs do
  // not have a host-owned source registry to version here.
  if (value.managedRuntime && 'probes' in value.catalog) {
    if (value.catalog.sourceRegistryVersion === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['catalog', 'sourceRegistryVersion'],
        message: 'Managed Provider dynamic catalog requires a semantic source registry version',
      });
    }
  }
  value.compatibilityOverrides?.forEach((override, index) => {
    if (!protocols.has(override.protocol)) {
      ctx.addIssue({
        code: 'custom',
        path: ['compatibilityOverrides', index, 'protocol'],
        message: 'Compatibility override protocol is not declared by an endpoint',
      });
    }
  });
  validateProviderConnectedAccountDeclarationsV1(value,
    value.managedRuntime ? new Set(value.managedRuntime.endpointTemplateIds) : endpointIds,
    issue => ctx.addIssue(issue));
  validateManagedPurposeBindingPolicyV1(value.managedRuntime?.connectedAccountPurposeBindingPolicy, value.connectedAccounts,
    ['managedRuntime'], issue => ctx.addIssue(issue));
  value.managedRuntime?.endpointTemplateIds.forEach((endpointTemplateId, index) => {
    if (!endpointIds.has(endpointTemplateId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['managedRuntime', 'endpointTemplateIds', index],
        message: 'Managed Provider endpoint template is not declared',
      });
    }
  });
  const migrationSourceIds = new Set<string>();
  value.legacyProfileMigrations?.forEach((descriptor, index) => {
    if (migrationSourceIds.has(descriptor.sourceProfileId)) {
      ctx.addIssue({ code: 'custom', path: ['legacyProfileMigrations', index, 'sourceProfileId'], message: 'Legacy profile migration ids must be unique' });
    }
    migrationSourceIds.add(descriptor.sourceProfileId);
    if (descriptor.credentialBinding) {
      const slotId = value.credential?.slotId ?? 'apiKey';
      if (!value.credential || descriptor.credentialBinding.credentialSlotId !== slotId) {
        ctx.addIssue({ code: 'custom', path: ['legacyProfileMigrations', index, 'credentialBinding', 'credentialSlotId'], message: 'Legacy credential binding must reference the contribution credential slot' });
      }
    }
    const staticModelIds = new Set('staticModels' in value.catalog
      ? value.catalog.staticModels.map((model) => model.id)
      : []);
    descriptor.implicitModelAliasReplacements.forEach((replacement, replacementIndex) => {
      if (!staticModelIds.has(replacement.replacementModelId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['legacyProfileMigrations', index, 'implicitModelAliasReplacements', replacementIndex, 'replacementModelId'],
          message: 'Implicit model alias replacements must target a verified static model',
        });
      }
    });
  });
})));
export type ProviderContributionV1 = z.infer<typeof ProviderContributionV1Schema>;
