import { z } from 'zod';

import { ProviderCompatibilityCapabilitiesV1Schema, ProviderCompatibilityOverridesV1Schema, ProviderWireProtocolSchema } from '../capabilities/v1.js';
import { ProviderCatalogDeclarationV1Schema } from '../catalog/descriptorV1.js';
import { ProviderApiKeyCredentialRequirementV1Schema } from '../credentials/v1.js';
import { ProviderDetectionDescriptorV1Schema } from '../detection/descriptorV1.js';
import { ProviderLocalIdSchema } from '../ids.js';
import { ProviderOriginRelativePathSchema } from '../originRelativePathSchema.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import { ProviderHttpsUrlSchema } from '../httpsUrlSchema.js';
import { ProviderPublicHeadersV1Schema } from '../publicHeadersSchema.js';
import { ProviderModelIdSchema } from '../ids.js';
import { ProviderAgentTargetKeySchema } from '../ids.js';
import { EnvironmentVariableSchema } from '../../profiles/environmentVariables.js';
import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
  type PluginContributionIdentityV1,
} from '../../plugins/contributionIdentity.js';
import type { PluginLocalizedStringV2 } from '../../plugins/contributions/publicTypes.js';
import {
  ConnectedAccountPurposeDeclarationsV1Schema,
  type ConnectedAccountPurposeDeclarationV1,
  type PluginConnectedAccountMaterializationKind,
} from '../../connect/connectedAccountPurposes.js';
import {
  ConnectedAccountRequestAuthUsesV1Schema,
  type ConnectedAccountRequestAuthUseV1,
} from '../../connect/connectedAccountRequestAuth.js';
import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  qualifiedPurposeKey,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '../../connect/connectedAccountPurposeBindings.js';
import { compareProviderCanonicalStringsV1 } from '../canonicalOrderV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

const LegacyProfileEnvironmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/u).max(128);

export const ProviderLegacyProfileMigrationDescriptorV1Schema = z.object({
  sourceProfileId: z.string().trim().min(1).max(256),
  descriptorRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  implicitModelAliasReplacements: z.array(z.object({
    legacyModelId: ProviderModelIdSchema,
    replacementModelId: ProviderModelIdSchema,
  }).strict()).max(16).default([]),
  credentialBinding: z.object({
    legacyEnvVarName: LegacyProfileEnvironmentNameSchema,
    credentialSlotId: ProviderLocalIdSchema,
  }).strict().optional(),
  primaryModel: z.object({
    agentTargetKey: ProviderAgentTargetKeySchema,
    legacyEnvVarName: LegacyProfileEnvironmentNameSchema,
    defaultModelId: ProviderModelIdSchema,
    legacyProcessEnvAlias: LegacyProfileEnvironmentNameSchema.optional(),
  }).strict().optional(),
  migratedEnvironmentVariables: z.array(EnvironmentVariableSchema).max(64).default([]),
  retainedEnvironmentVariables: z.array(EnvironmentVariableSchema).max(64).default([]),
}).strict().superRefine((value, ctx) => {
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
});
export type ProviderLegacyProfileMigrationDescriptorV1 = z.infer<typeof ProviderLegacyProfileMigrationDescriptorV1Schema>;

export const ProviderEndpointTemplateV1Schema = z.object({
  id: ProviderLocalIdSchema,
  protocol: ProviderWireProtocolSchema,
  baseUrl: ProviderEndpointUrlSyntaxSchema.optional(),
  localUrlCandidates: z.array(ProviderEndpointUrlSyntaxSchema).min(1).max(16).optional(),
  publicHeaders: ProviderPublicHeadersV1Schema.optional(),
  capabilities: ProviderCompatibilityCapabilitiesV1Schema,
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.baseUrl) === Boolean(value.localUrlCandidates)) {
    ctx.addIssue({ code: 'custom', message: 'Exactly one of baseUrl or localUrlCandidates is required' });
  }
});
export type ProviderEndpointTemplateV1 = z.infer<typeof ProviderEndpointTemplateV1Schema>;

export const ProviderModelLoadDescriptorV1Schema = z.object({
  endpointTemplateId: ProviderLocalIdSchema,
  path: ProviderOriginRelativePathSchema,
  request: z.literal('json-model-id-v1'),
  confirmation: z.literal('refresh-catalog-load-state'),
  preflightPolicy: z.enum(['advisory', 'required']),
}).strict();
export type ProviderModelLoadDescriptorV1 = z.infer<typeof ProviderModelLoadDescriptorV1Schema>;

export const ProviderManagedRuntimeDeclarationV1Schema = z.object({
  kind: z.literal('managed'),
  dependencies: z.array(asProtocolZod(PluginContributionLocalIdSchema)).max(16).optional(),
  connectedAccounts: ConnectedAccountPurposeDeclarationsV1Schema.optional(),
  requestAuthUses: ConnectedAccountRequestAuthUsesV1Schema.optional(),
  endpointTemplateIds: z.array(ProviderLocalIdSchema).min(1).max(4),
}).strict().superRefine((value, context) => {
  const dependencies = value.dependencies ?? [];
  if (new Set(dependencies).size !== dependencies.length) {
    context.addIssue({ code: 'custom', path: ['dependencies'], message: 'Managed Provider dependencies must be unique' });
  }
  if (new Set(value.endpointTemplateIds).size !== value.endpointTemplateIds.length) {
    context.addIssue({ code: 'custom', path: ['endpointTemplateIds'], message: 'Managed Provider endpoint-template ids must be unique' });
  }
  const declarationsByPurpose = new Map(
    (value.connectedAccounts ?? []).map((declaration) => [
      declaration.purpose,
      declaration,
    ]),
  );
  for (const [index, use] of (value.requestAuthUses ?? []).entries()) {
    const declaration = declarationsByPurpose.get(use.purpose);
    if (!declaration) {
      context.addIssue({
        code: 'custom',
        path: ['requestAuthUses', index, 'purpose'],
        message: 'Managed Provider request-auth purpose must be declared by connectedAccounts',
      });
      continue;
    }
    if (declaration.materializationKinds?.includes(use.materialization.kind) !== true) {
      context.addIssue({
        code: 'custom',
        path: ['requestAuthUses', index, 'materialization', 'kind'],
        message: 'Managed Provider request-auth materialization kind must be explicitly declared by its connected-account purpose',
      });
    }
  }
});
export type ProviderManagedRuntimeDeclarationV1 = z.infer<
  typeof ProviderManagedRuntimeDeclarationV1Schema
>;

export type ResolvedProviderManagedConnectedAccountPurposeDeclarationV1 =
  Readonly<{
    purpose: string;
    service: PluginContributionIdentityV1;
    title?: PluginLocalizedStringV2;
    required?: boolean;
    materializationKinds?: PluginConnectedAccountMaterializationKind[];
  }>;

export type ResolvedProviderManagedRuntimeDeclarationV1 = Readonly<{
  kind: 'managed';
  dependencies: string[];
  connectedAccounts:
    ResolvedProviderManagedConnectedAccountPurposeDeclarationV1[];
  requestAuthUses: ConnectedAccountRequestAuthUseV1[];
  endpointTemplateIds: string[];
}>;

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

/**
 * Canonical resolution boundary for a public managed Provider declaration.
 * Contribution-local Connected Account references become immutable qualified
 * identities here so registry, authorization, fingerprints, and invocation
 * custody cannot interpret the same declaration differently.
 */
export function resolveProviderManagedRuntimeDeclarationV1(input: Readonly<{
  implementationIdentity: PluginContributionIdentityV1;
  managedRuntime:
    | ProviderManagedRuntimeDeclarationV1
    | ResolvedProviderManagedRuntimeDeclarationV1;
}>): ResolvedProviderManagedRuntimeDeclarationV1 {
  const implementationIdentity = PluginContributionIdentityV1Schema.parse(
    input.implementationIdentity,
  );
  const parsed = ProviderManagedRuntimeDeclarationV1Schema.parse(
    input.managedRuntime,
  );
  const dependencies = [...(parsed.dependencies ?? [])].sort(
    compareProviderCanonicalStringsV1,
  );
  const endpointTemplateIds = [...parsed.endpointTemplateIds];
  const connectedAccounts:
    ResolvedProviderManagedConnectedAccountPurposeDeclarationV1[] = (
      parsed.connectedAccounts ?? []
    ).map((declaration: ConnectedAccountPurposeDeclarationV1) => {
      const service = PluginContributionIdentityV1Schema.parse(
        typeof declaration.service === 'string'
          ? {
              pluginId: implementationIdentity.pluginId,
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
      });
    }).sort((left, right) =>
      compareProviderCanonicalStringsV1(left.purpose, right.purpose));
  const requestAuthUses: ConnectedAccountRequestAuthUseV1[] = (
    parsed.requestAuthUses ?? []
  ).map((use) => Object.freeze({
    purpose: use.purpose,
    materialization: Object.freeze({
      ...use.materialization,
      headerNames: Object.freeze([
        ...use.materialization.headerNames,
      ].sort(compareProviderCanonicalStringsV1)),
    }),
  })).sort((left, right) =>
    compareProviderCanonicalStringsV1(left.purpose, right.purpose));
  Object.freeze(dependencies);
  Object.freeze(connectedAccounts);
  Object.freeze(requestAuthUses);
  Object.freeze(endpointTemplateIds);
  return Object.freeze({
    kind: 'managed',
    dependencies,
    connectedAccounts,
    requestAuthUses,
    endpointTemplateIds,
  });
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
    | ProviderManagedRuntimeDeclarationV1
    | ResolvedProviderManagedRuntimeDeclarationV1;
}>): string {
  const implementationIdentity = PluginContributionIdentityV1Schema.parse(
    input.implementationIdentity,
  );
  const managedRuntime = resolveProviderManagedRuntimeDeclarationV1({
    implementationIdentity,
    managedRuntime: input.managedRuntime,
  });
  return JSON.stringify({
    implementationIdentity,
    managedRuntime: {
      ...managedRuntime,
      connectedAccounts: managedRuntime.connectedAccounts.map(
        ({ title: _title, ...declaration }) => declaration,
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
    | ProviderManagedRuntimeDeclarationV1
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

export const ProviderContributionV1Schema = z.object({
  v: z.literal(1),
  id: ProviderLocalIdSchema,
  name: z.string().trim().min(1).max(128),
  icon: z.string().trim().min(1).max(512).optional(),
  websiteUrl: ProviderHttpsUrlSchema.optional(),
  kind: z.enum(['frontier', 'aggregator', 'cloud', 'local']),
  endpointTemplates: z.array(ProviderEndpointTemplateV1Schema).min(1).max(4),
  credential: ProviderApiKeyCredentialRequirementV1Schema.optional(),
  catalog: ProviderCatalogDeclarationV1Schema,
  modelLoad: ProviderModelLoadDescriptorV1Schema.optional(),
  discovery: ProviderDetectionDescriptorV1Schema.optional(),
  managedRuntime: ProviderManagedRuntimeDeclarationV1Schema.optional(),
  compatibilityOverrides: ProviderCompatibilityOverridesV1Schema.optional(),
  legacyProfileMigrations: z.array(ProviderLegacyProfileMigrationDescriptorV1Schema).max(8).optional(),
}).strict().superRefine((value, ctx) => {
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
      probe.endpointTemplateId === value.modelLoad?.endpointTemplateId && probe.parser === 'lmstudio-native-models');
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
  value.compatibilityOverrides?.forEach((override, index) => {
    if (!protocols.has(override.protocol)) {
      ctx.addIssue({
        code: 'custom',
        path: ['compatibilityOverrides', index, 'protocol'],
        message: 'Compatibility override protocol is not declared by an endpoint',
      });
    }
  });
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
});
export type ProviderContributionV1 = z.infer<typeof ProviderContributionV1Schema>;
