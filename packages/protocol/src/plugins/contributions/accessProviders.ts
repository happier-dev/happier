import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SharedSavedSecretReferenceSelectionV1Schema } from '../../account/settings/savedSecretReferenceV1.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { HomeHostAccessMethodV1Schema } from '../../home/governance/reachability.js';
import { MachineRecipeReferenceV1Schema } from '../../machines/setup/machineRecipeV1.js';
import { MachineRecipeV1Schema, type MachineRecipeV1 } from './machineRecipes.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod, projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import {
  defineProtocolObject, defineProtocolString, defineProtocolJsonValue,
  embedProtocolJsonSchema,
  normalizePluginJsonSchema, pluginJsonValuesEqual, type ProtocolComposableSchema,
} from '../actions/protocolComposableSchema.js';
import { PluginActionIconV2Schema, type PluginActionContributionV2 } from '../actions/v2.js';
import { PluginDeclaredExecutableRefSchema } from './agentAcpTransport.js';
import { isRecursivelyClosedPluginJsonSchemaV2 } from './jsonSchema.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema, type PluginJsonSchemaV2 } from './publicTypes.js';

const text = () => z.string().check(z.trim(), z.minLength(1));
const port = () => z.number().check(z.int(), z.minimum(1), z.maximum(65_535));
const local = () => asProtocolZod(PluginContributionLocalIdSchema);
export const ACCESS_PROVIDER_ROLES_V1 = ['inspect', 'configure', 'disable', 'join', 'leave'] as const;
export type AccessProviderRoleV1 = typeof ACCESS_PROVIDER_ROLES_V1[number];

/** Built-in identities are stable catalog keys, never a second provider registry. */
export const AccessProviderRefV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('builtin'), id: text() }),
  asProtocolZod(PluginContributionIdentityV1Schema),
]));
export type AccessProviderRefV1 = z.infer<typeof AccessProviderRefV1Schema>;
export function accessProviderRefsEqualV1(left: AccessProviderRefV1, right: AccessProviderRefV1): boolean {
  if ('kind' in left || 'kind' in right) return 'kind' in left && 'kind' in right && left.id === right.id;
  return left.pluginId === right.pluginId && left.localId === right.localId;
}
export const AccessCredentialPurposeRefV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: text(),
  credentialRef: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('savedSecret'), ...SharedSavedSecretReferenceSelectionV1Schema.shape }),
    z.strictObject({ kind: z.literal('connectedAccount'), account: asProtocolZod(QualifiedConnectedAccountRefSchema) }),
  ]),
}));
export type AccessCredentialPurposeRefV1 = z.infer<typeof AccessCredentialPurposeRefV1Schema>;
export const AccessProviderSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  provider: AccessProviderRefV1Schema, config: asProtocolZod(defineProtocolJsonValue()),
  credentialRefs: z.array(AccessCredentialPurposeRefV1Schema).check(z.refine(
    refs => new Set(refs.map(ref => ref.purpose)).size === refs.length,
    'A credential purpose is selected once.',
  )),
}));
export type AccessProviderSelectionV1 = z.infer<typeof AccessProviderSelectionV1Schema>;
export const AccessProviderRefProtocolV1Schema: ProtocolComposableSchema<AccessProviderRefV1> = projectZodProtocolSchema(AccessProviderRefV1Schema);
export const AccessProviderSelectionProtocolV1Schema: ProtocolComposableSchema<AccessProviderSelectionV1> = projectZodProtocolSchema(AccessProviderSelectionV1Schema);
export const AccessProviderInboundPortV1Schema = lazyZodSchema(() => z.strictObject({
  port: port(), protocol: z.enum(['tcp', 'udp']), exposure: z.enum(['public', 'privateNetwork', 'loopback']),
}));
export type AccessProviderInboundPortV1 = z.infer<typeof AccessProviderInboundPortV1Schema>;
export const AccessProviderHttpsConstraintsV1Schema = lazyZodSchema(() => z.strictObject({
  hostname: z.enum(['providerAssigned', 'custom', 'either']), ports: z.array(port()).check(z.minLength(1)), paths: z.boolean(),
}));
export const AccessProviderRouteV1Schema = lazyZodSchema(() => z.strictObject({
  ownerId: text(), hostname: text(), httpsPort: port(), path: z.string().check(z.startsWith('/')), upstream: text(),
}));
export type AccessProviderRouteV1 = z.infer<typeof AccessProviderRouteV1Schema>;
/** Native CIDRs only, not proxy matcher aliases or forwarded-header claims. */
export const MachinePrivateNetworkSourceRangesV1Schema = lazyZodSchema(() => z.array(z.union([
  // The portable plugin dialect supports patterns, not Zod's CIDR formats.
  // Reuse Zod's exact validators rather than introducing another CIDR parser.
  z.string().check(z.regex(z.regexes.cidrv4)), z.string().check(z.regex(z.regexes.cidrv6)),
])));
export type MachinePrivateNetworkSourceRangesV1 = z.infer<typeof MachinePrivateNetworkSourceRangesV1Schema>;
/**
 * Demand-only observation, not endpoint health or a desired Network resource.
 * P41 receives sourceRanges from the Environment's exact admitted observation
 * and network identity through its existing route/capability planning input.
 * Parsing this record does not admit that Environment or authorize a request.
 */
export const MachinePrivateNetworkObservationV1Schema = lazyZodSchema(() => z.strictObject({
  provider: AccessProviderRefV1Schema, networkIdentity: z.nullable(text()), displayName: z.nullable(text()),
  dnsName: z.nullable(text()), addresses: z.array(text()),
  state: z.enum(['ready', 'stopped', 'needsAuth', 'unavailable', 'unknown']),
  interfaceName: z.nullable(text()), sourceRanges: MachinePrivateNetworkSourceRangesV1Schema, magicDnsEnabled: z.nullable(z.boolean()),
}));
export type MachinePrivateNetworkObservationV1 = z.infer<typeof MachinePrivateNetworkObservationV1Schema>;

const strictPortableSchema = lazyZodSchema(() => PluginJsonSchemaV2Schema.check(z.superRefine((value, context) => {
  try {
    normalizePluginJsonSchema(value);
    if (!isRecursivelyClosedPluginJsonSchemaV2(value)) context.addIssue({ code: 'custom', message: 'Access configuration schemas must be recursively closed.' });
  } catch { context.addIssue({ code: 'custom', message: 'Invalid portable access configuration schema.' }); }
})));
/** Descriptor only: ordinary declared Actions provide native behavior on demand. */
const accessProviderContributionBaseSchema = lazyZodSchema(() => z.strictObject({
  id: local(), title: PluginLocalizedStringV2Schema, description: z.optional(PluginLocalizedStringV2Schema), icon: PluginActionIconV2Schema,
  schemaVersion: z.literal(1),
  targets: z.array(z.enum(['machine', 'domainRoute', 'homeRelay'])).check(z.minLength(1), z.refine(values => new Set(values).size === values.length)),
  capabilities: z.array(z.enum(['management', 'ingress', 'privateNetwork'])).check(z.minLength(1), z.refine(values => new Set(values).size === values.length)),
  configSchema: strictPortableSchema,
  exposure: z.enum(['local', 'lan', 'privateNetwork', 'public']), https: z.optional(AccessProviderHttpsConstraintsV1Schema),
  inboundPorts: z.array(AccessProviderInboundPortV1Schema),
  credentialPurposes: z.array(z.strictObject({ purpose: text(), required: z.boolean() })),
  install: z.optional(z.union([
    z.strictObject({ kind: z.literal('recipe'), ref: MachineRecipeReferenceV1Schema }),
    PluginDeclaredExecutableRefSchema,
  ])),
  actions: z.strictObject({ inspect: local(), configure: z.optional(local()), disable: z.optional(local()), join: z.optional(local()), leave: z.optional(local()) }),
  homeAccessMethod: z.optional(HomeHostAccessMethodV1Schema),
}));
type AccessProviderContributionBase = z.infer<typeof accessProviderContributionBaseSchema>;
// A named contract keeps the catalog tuple from expanding two full recipe
// schemas. Every field still comes from its canonical parser below.
export interface AccessProviderContributionV1 extends AccessProviderContributionBase {
  membership?: { join: MachineRecipeV1; leave: MachineRecipeV1 };
}
export const AccessProviderContributionV1Schema: z.ZodMiniType<AccessProviderContributionV1> = lazyZodSchema(() => z.extend(accessProviderContributionBaseSchema, {
  // Only admitted reachability operations consume these through P20, not the
  // ordinary selectable setup recipe catalog.
  membership: z.optional(z.strictObject({ join: MachineRecipeV1Schema, leave: MachineRecipeV1Schema })),
}).check(z.superRefine((value, context) => {
  if (new Set(value.credentialPurposes.map(entry => entry.purpose)).size !== value.credentialPurposes.length) {
    context.addIssue({ code: 'custom', path: ['credentialPurposes'], message: 'Credential purposes must be unique.' });
  }
  if (value.capabilities.includes('ingress')) {
    if (!value.actions.configure || !value.actions.disable) {
      context.addIssue({ code: 'custom', path: ['actions'], message: 'Ingress requires configure and disable roles.' });
    }
    if (value.targets.some(target => target !== 'homeRelay') && !value.https) {
      context.addIssue({ code: 'custom', path: ['https'], message: 'Managed service ingress requires HTTPS constraints.' });
    }
  }
  if (value.capabilities.includes('privateNetwork') && (!value.actions.join || !value.actions.leave)) {
    context.addIssue({ code: 'custom', path: ['actions'], message: 'Private-network membership requires join and leave roles.' });
  }
  if (value.membership && !value.capabilities.includes('privateNetwork')) {
    context.addIssue({ code: 'custom', path: ['membership'], message: 'Native membership programs require a private-network provider.' });
  }
})));

const roleFacts = lazyZodSchema(() => z.strictObject({
  state: z.enum(['ready', 'stopped', 'needsAuth', 'unavailable', 'unknown']),
  privateNetwork: z.optional(MachinePrivateNetworkObservationV1Schema), publicUrl: z.optional(text()),
}));
const roleResult = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('confirmed'), facts: roleFacts }),
  z.strictObject({ kind: z.literal('refused'), code: text() }),
  z.strictObject({ kind: z.literal('unknown'), code: text() }),
]));
export type AccessProviderRoleResultV1 = z.infer<typeof roleResult>;
export const AccessProviderRoleResultV1Schema: ProtocolComposableSchema<AccessProviderRoleResultV1> = projectZodProtocolSchema(roleResult);

/** All role envelopes are closed; config remains the descriptor's exact schema. */
export function defineAccessProviderSchemas<CI, CO>(schemas: Readonly<{ config: ProtocolComposableSchema<CI, CO> }>) {
  const common = {
    machineId: defineProtocolString({ minLength: 1 }), config: schemas.config,
    credentialRefs: projectZodProtocolSchema(z.array(AccessCredentialPurposeRefV1Schema)),
  };
  const route = projectZodProtocolSchema(AccessProviderRouteV1Schema);
  const inspectInput = defineProtocolObject({ ...common, route: route.optional() }, { policy: 'closed' });
  const routeInput = defineProtocolObject({ ...common, route }, { policy: 'closed' });
  return {
    inspectInput, configureInput: routeInput, disableInput: routeInput,
    joinInput: defineProtocolObject({ ...common, route: route.optional(),
      // Host custody binds this materialized path into the exact admitted input.
      setupCredentialFile: defineProtocolString({ minLength: 1 }).optional(),
    }, { policy: 'closed' }),
    leaveInput: inspectInput, result: AccessProviderRoleResultV1Schema,
  };
}
export function readAccessProviderActionRolesV1(descriptor: AccessProviderContributionV1): readonly Readonly<{ role: AccessProviderRoleV1; action: string }>[] {
  return ACCESS_PROVIDER_ROLES_V1.flatMap(role => {
    const action = descriptor.actions[role];
    return action === undefined ? [] : [{ role, action }];
  });
}
function nestedProjection(schema: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  const { $schema: _dialect, ...projection } = normalizePluginJsonSchema(schema);
  return projection;
}
const genericRoles = defineAccessProviderSchemas({ config: defineProtocolObject({}, { policy: 'closed' }) });
export function accessProviderRoleInputProjection(descriptor: AccessProviderContributionV1, role: AccessProviderRoleV1): PluginJsonSchemaV2 {
  const schema = genericRoles[`${role}Input`].jsonSchema;
  return normalizePluginJsonSchema({ ...schema, properties: { ...schema.properties,
    config: embedProtocolJsonSchema(nestedProjection(descriptor.configSchema), ['properties', 'config']),
  } });
}
export function accessProviderRoleResultProjection(): PluginJsonSchemaV2 { return AccessProviderRoleResultV1Schema.jsonSchema; }
export function validateAccessProviderContributionsV1(
  value: Readonly<{ accessProviders: readonly AccessProviderContributionV1[]; actions: readonly PluginActionContributionV2[] }>,
  context: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  value.accessProviders.forEach((descriptor, index) => {
    const base = ['accessProviders', index];
    if (seen.has(descriptor.id)) context.addIssue({ code: 'custom', path: [...base, 'id'], message: 'Duplicate access provider id.' });
    seen.add(descriptor.id);
    if (descriptor.homeAccessMethod !== undefined || descriptor.targets.includes('homeRelay')) {
      context.addIssue({ code: 'custom', path: [...base, 'targets'], message: 'Home access is currently available only to built-in descriptors.' });
    }
    for (const role of ['join', 'leave'] as const) {
      const program = descriptor.membership?.[role];
      if (program && !pluginJsonValuesEqual(nestedProjection(program.inputSchema),
        nestedProjection(accessProviderRoleInputProjection(descriptor, role)))) {
        context.addIssue({ code: 'custom', path: [...base, 'membership', role, 'inputSchema'],
          message: 'Native membership programs consume the exact reviewed canonical role input.' });
      }
    }
    for (const binding of readAccessProviderActionRolesV1(descriptor)) {
      const path = [...base, 'actions', binding.role];
      const action = value.actions.find(candidate => candidate.id === binding.action);
      if (!action || action.execution.target !== 'daemon') {
        context.addIssue({ code: 'custom', path, message: 'Access roles require a declared same-plugin daemon Action.' });
        continue;
      }
      if (!action.inputSchema || !action.resultSchema
        || !pluginJsonValuesEqual(nestedProjection(action.inputSchema), nestedProjection(accessProviderRoleInputProjection(descriptor, binding.role)))
        || !pluginJsonValuesEqual(nestedProjection(action.resultSchema), nestedProjection(accessProviderRoleResultProjection()))) {
        context.addIssue({ code: 'custom', path, message: 'Access roles require their exact closed canonical input and result contracts.' });
      }
      if (binding.role === 'inspect' && action.dangerLevel !== 'safe') {
        context.addIssue({ code: 'custom', path, message: 'Access inspection must be safe.' });
      } else if (binding.role !== 'inspect' && action.dangerLevel === 'safe') {
        context.addIssue({ code: 'custom', path, message: 'Access effects must declare their native side effect for normal parent approval.' });
      }
    }
  });
}
