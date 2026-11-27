import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
  ConnectedAccountServiceKeySchema,
  ConnectedServiceBindingSelectionV1Schema,
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceBindingsV2Schema,
  TeamResourceBrokeredConnectedServiceSelectionV2Schema,
  TeamResourceDirectConnectedServiceSelectionV2Schema,
  type ConnectedServiceBindingSelectionV2,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceBindingsV2,
  type TeamResourceConnectedServiceSelectionV2,
} from '../../connect/connectedServiceBindings.js';
import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  QualifiedConnectedAccountPurposeBindingsV1RecordSchema,
  qualifiedPurposeKey,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '../../connect/connectedAccountPurposeBindings.js';
import { QualifiedConnectedAccountPurposeV1Schema, type QualifiedConnectedAccountPurposeV1 } from '../../connect/connectedAccountPurposeIdentity.js';
import { normalizeStrictJsonValue } from '../../json/strictJsonValue.js';
import { buildQualifiedPluginContributionKey } from '../../plugins/contributionIdentity.js';
import { resolveGeneratedSessionPresentationAgentIdV1 } from '../../agents/generated/sessionPresentationCompatV1.js';
import { ConnectedAccountServiceIdentityV1Schema, sameQualifiedConnectedAccountRef } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { sameQualifiedConnectedAccountGroupRef } from '../../connect/qualifiedConnectedAccountProjectionsV4.js';

const AgentIdSettingsKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

/** Normalize released Agent aliases once at settings ingress; an explicit current key wins. */
function normalizeAgentKeyedSettings<T>(values: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(values).flatMap(([agentId, value]) => {
    const canonicalId = resolveGeneratedSessionPresentationAgentIdV1({ flavor: agentId }) ?? agentId;
    if (canonicalId !== agentId && Object.hasOwn(values, canonicalId)) return [];
    return [[canonicalId, value]];
  }));
}

const ConnectedServicesDefaultAuthTeamResourceQualifierV2Shape = {
  serverId: z.string().check(z.trim(), z.minLength(1)),
  accountId: z.string().check(z.trim(), z.minLength(1)),
  teamId: z.string().check(z.trim(), z.minLength(1)),
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
} as const;

export const ConnectedServicesDefaultAuthTeamResourceBindingV2Schema = lazyZodSchema(() => z.union([
  z.extend(TeamResourceBrokeredConnectedServiceSelectionV2Schema, ConnectedServicesDefaultAuthTeamResourceQualifierV2Shape),
  z.extend(TeamResourceDirectConnectedServiceSelectionV2Schema, ConnectedServicesDefaultAuthTeamResourceQualifierV2Shape),
]));
export type ConnectedServicesDefaultAuthTeamResourceBindingV2 = z.infer<
  typeof ConnectedServicesDefaultAuthTeamResourceBindingV2Schema
>;

const ConnectedServicesDefaultAuthBindingsByServiceIdV2Schema = lazyZodSchema(() => z.record(
  z.string(),
  z.union([
    ConnectedServiceBindingSelectionV1Schema,
    ConnectedServicesDefaultAuthTeamResourceBindingV2Schema,
  ]),
).check(z.superRefine((bindings, context) => {
  for (const serviceId of Object.keys(bindings)) {
    if (ConnectedAccountServiceKeySchema.safeParse(serviceId).success) continue;
    context.addIssue({
      code: "custom",
      message: 'Invalid qualified Connected Account service key',
      path: [serviceId],
    });
  }
})));

export const ConnectedServicesDefaultAuthBindingsV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  bindingsByServiceId: z._default(ConnectedServicesDefaultAuthBindingsByServiceIdV2Schema, {}),
}));
export type ConnectedServicesDefaultAuthBindingsV2 = z.infer<
  typeof ConnectedServicesDefaultAuthBindingsV2Schema
>;

const ConnectedServicesDefaultAuthBindingsIngressSchema = lazyZodSchema(() => z.union([
  ConnectedServicesDefaultAuthBindingsV2Schema,
  ConnectedServiceBindingsV1Schema,
]));

export const ConnectedServicesDefaultAuthByAgentIdV1Schema = lazyZodSchema(() => z.strictObject({
    v: z._default(z.literal(1), 1),
    bindingsByAgentId: z._default(z.record(AgentIdSettingsKeySchema, ConnectedServicesDefaultAuthBindingsIngressSchema), {}),
  }));

/** Released bundled account settings used scalar service ids before qualified service identity. */
const BuiltInLegacyConnectedServicesDefaultAuthByAgentIdV1Schema = lazyZodSchema(() => z.pipe(z.strictObject({
    v: z._default(z.literal(1), 1),
    bindingsByAgentId: z._default(z.record(
      AgentIdSettingsKeySchema,
      BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
    ), {}),
  }), z.transform((value) => ConnectedServicesDefaultAuthByAgentIdV1Schema.parse(value))));

const ConnectedServicesDefaultAuthByAgentIdV1SourceSchema = lazyZodSchema(() => z
  .union([
    ConnectedServicesDefaultAuthByAgentIdV1Schema,
    BuiltInLegacyConnectedServicesDefaultAuthByAgentIdV1Schema,
  ]));

export const BuiltInLegacyConnectedServicesDefaultAuthByAgentIdV1IngressSchema = lazyZodSchema(() =>
  z.catch(ConnectedServicesDefaultAuthByAgentIdV1SourceSchema, { v: 1 as const, bindingsByAgentId: {} }));

/**
 * Prospective 0.2 G2 ingress: the carrier is disjoint from released scalar
 * services and survives released UI writers. Read it through the same generated
 * service and Agent identities; current defaults are authored only as purposes.
 * Remove once predecessor-created additional defaults have all migrated.
 */
export const BuiltInLegacyAdditionalConnectedServicesDefaultAuthByAgentIdV1IngressSchema = lazyZodSchema(() =>
  z.pipe(ConnectedServicesDefaultAuthByAgentIdV1SourceSchema, z.transform((value) => ({
    v: value.v,
    bindingsByAgentId: normalizeAgentKeyedSettings(value.bindingsByAgentId),
  }))),
);

export type ConnectedServicesDefaultAuthByAgentIdV1 = z.infer<
  typeof ConnectedServicesDefaultAuthByAgentIdV1Schema
>;

export const DEFAULT_CONNECTED_SERVICES_DEFAULT_AUTH_BY_AGENT_ID_V1:
  ConnectedServicesDefaultAuthByAgentIdV1 =
    ConnectedServicesDefaultAuthByAgentIdV1Schema.parse({});

export const DEFAULT_CONNECTED_ACCOUNT_PURPOSE_BINDINGS_V1:
  QualifiedConnectedAccountPurposeBindingsV1 =
    QualifiedConnectedAccountPurposeBindingsV1Schema.parse({ v: 1, bindings: [] });

/**
 * One Agent purpose declaration as the Agent catalog projects it: the qualified
 * purpose id and the qualified Connected Account service that serves it.
 */
export type AgentConnectedAccountPurposeDeclaration = Readonly<{
  purpose: string;
  service: Readonly<{ pluginId: string; localId: string }>;
}>;

/**
 * A durable Team resource default: the canonical `ConnectedServiceBindingSelectionV2`
 * Team arm plus the Team that offers it. It is never a purpose target (lane 10
 * child 02 :271, child 06 :506); a Session receives it as its own Team binding.
 */
export type AgentConnectedAccountPurposeTeamResourceDefault = Readonly<{
  teamId: string;
  selection: TeamResourceConnectedServiceSelectionV2;
}>;

/** One purpose's default: a personal target, a Team resource, or neither — never both. */
export type AgentConnectedAccountPurposeDefault = Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  service: Readonly<{ pluginId: string; localId: string }>;
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null;
}>;

type AgentConnectedAccountPurposeDefaultValue = Readonly<{
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null;
}>;

const NO_PURPOSE_DEFAULT: AgentConnectedAccountPurposeDefaultValue = Object.freeze({
  target: null,
  teamResource: null,
});

/** A direct Team selection discloses a member of the purpose's own service, or it serves nothing here. */
function teamResourceDefaultForService(
  value: AgentConnectedAccountPurposeTeamResourceDefault,
  service: AgentConnectedAccountPurposeDeclaration['service'],
): AgentConnectedAccountPurposeTeamResourceDefault | null {
  const selection = value.selection;
  if (
    selection.deliveryMode === 'direct'
    && (
      selection.disclosedMember.service.pluginId !== service.pluginId
      || selection.disclosedMember.service.localId !== service.localId
    )
  ) return null;
  return {
    teamId: value.teamId,
    selection: selection.deliveryMode === 'direct'
      ? {
          source: 'team_resource',
          resourceId: selection.resourceId,
          deliveryMode: 'direct',
          disclosedMember: {
            service: { ...selection.disclosedMember.service },
            accountId: selection.disclosedMember.accountId,
          },
        }
      : { source: 'team_resource', resourceId: selection.resourceId, deliveryMode: 'brokered' },
  };
}

export type AgentConnectedAccountDefaultSettings = Readonly<{
  connectedServicesDefaultAuthByAgentIdV1?: unknown;
  connectedServicesAdditionalDefaultAuthByAgentIdV1?: unknown;
}>;

function readLegacyDefaultAuth(value: unknown): ConnectedServicesDefaultAuthByAgentIdV1 {
  return value === undefined
    ? DEFAULT_CONNECTED_SERVICES_DEFAULT_AUTH_BY_AGENT_ID_V1
    : BuiltInLegacyConnectedServicesDefaultAuthByAgentIdV1IngressSchema.parse(value);
}

function readAdditionalLegacyDefaultAuth(value: unknown): ConnectedServicesDefaultAuthByAgentIdV1 {
  return value === undefined
    ? DEFAULT_CONNECTED_SERVICES_DEFAULT_AUTH_BY_AGENT_ID_V1
    : BuiltInLegacyAdditionalConnectedServicesDefaultAuthByAgentIdV1IngressSchema.parse(value);
}

function readLegacyDefaultAuthSettings(settings: AgentConnectedAccountDefaultSettings): ConnectedServicesDefaultAuthByAgentIdV1 {
  const legacy = readLegacyDefaultAuth(settings.connectedServicesDefaultAuthByAgentIdV1);
  const additional = readAdditionalLegacyDefaultAuth(settings.connectedServicesAdditionalDefaultAuthByAgentIdV1);
  const bindingsByAgentId = { ...legacy.bindingsByAgentId };
  for (const [agentId, binding] of Object.entries(additional.bindingsByAgentId)) {
    const previous = bindingsByAgentId[agentId];
    if (Object.keys(binding.bindingsByServiceId).some((key) => previous && key in previous.bindingsByServiceId)) {
      throw new Error('Overlapping legacy Connected Account default carriers');
    }
    bindingsByAgentId[agentId] = ConnectedServicesDefaultAuthBindingsIngressSchema.parse({
      v: previous?.v ?? binding.v,
      bindingsByServiceId: { ...previous?.bindingsByServiceId, ...binding.bindingsByServiceId },
    });
  }
  return { v: 1, bindingsByAgentId };
}

/**
 * Forward migration of one released service-keyed Agent default
 * (`connectedServicesDefaultAuthByAgentIdV1`, written by 0.2 and by earlier
 * 0.3 builds) into the qualified purpose target it always meant for this
 * declared purpose. `native` and an unusable entry mean "no default".
 */
function migrateLegacyDefaultAuthBinding(
  binding: unknown,
  service: AgentConnectedAccountPurposeDeclaration['service'],
): AgentConnectedAccountPurposeDefaultValue {
  if (!binding || typeof binding !== 'object') return NO_PURPOSE_DEFAULT;
  const teamResource = ConnectedServicesDefaultAuthTeamResourceBindingV2Schema.safeParse(binding);
  if (teamResource.success) {
    const value = teamResource.data;
    const migrated = teamResourceDefaultForService({
      teamId: value.teamId,
      selection: value.deliveryMode === 'direct'
        ? {
            source: 'team_resource',
            resourceId: value.resourceId,
            deliveryMode: 'direct',
            disclosedMember: value.disclosedMember,
          }
        : { source: 'team_resource', resourceId: value.resourceId, deliveryMode: 'brokered' },
    }, service);
    return migrated ? { target: null, teamResource: migrated } : NO_PURPOSE_DEFAULT;
  }
  const selection = ConnectedServiceBindingSelectionV1Schema.safeParse(binding);
  if (!selection.success || selection.data.source !== 'connected') return NO_PURPOSE_DEFAULT;
  if (selection.data.selection === 'group') {
    return {
      target: { kind: 'group', service: { ...service }, groupId: selection.data.groupId },
      teamResource: null,
    };
  }
  return {
    target: { kind: 'account', account: { service: { ...service }, accountId: selection.data.profileId } },
    teamResource: null,
  };
}

/** The existing Agent catalog projection needed only before purpose authority is activated. */
export type AgentConnectedAccountPurposeMigrationDescriptor = Readonly<{
  agentId: string;
  identity: QualifiedConnectedAccountPurposeV1['consumer'] | null;
  connectedAccounts: readonly AgentConnectedAccountPurposeDeclaration[];
}>;

/**
 * Fold genuine predecessor service defaults into an absent purpose row. Once a
 * row exists its contents, including an empty row, are the sole default authority.
 * This source-only seam neither rewrites Settings nor invents Agent identities.
 */
export function migrateLegacyAgentConnectedAccountPurposeDefaultsForActivation(input: Readonly<{
  settings: AgentConnectedAccountDefaultSettings;
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  agents: readonly AgentConnectedAccountPurposeMigrationDescriptor[] | null;
}>): Readonly<{ status: 'ready'; purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 }>
  | Readonly<{ status: 'unavailable'; reason: 'invalid-stored-content' | 'authority-not-confirmed' }> {
  let legacy: ConnectedServicesDefaultAuthByAgentIdV1;
  try {
    // Unlike the released forgiving reader, activation cannot erase malformed
    // retained intent by accepting its catch-to-empty projection.
    legacy = readLegacyDefaultAuthSettings({
      ...input.settings,
      connectedServicesDefaultAuthByAgentIdV1: input.settings.connectedServicesDefaultAuthByAgentIdV1 === undefined
        ? undefined
        : ConnectedServicesDefaultAuthByAgentIdV1SourceSchema.parse(input.settings.connectedServicesDefaultAuthByAgentIdV1),
    });
  } catch {
    return { status: 'unavailable', reason: 'invalid-stored-content' };
  }
  const bindings = [...input.purposeBindings.bindings];
  const teamResourceSelections = [...(input.purposeBindings.teamResourceSelections ?? [])];
  const retainedKeys = new Set([
    ...bindings.map(binding => qualifiedPurposeKey(binding.purpose)),
    ...teamResourceSelections.map(entry => qualifiedPurposeKey(entry.purpose)),
  ]);
  for (const [agentId, defaults] of Object.entries(legacy.bindingsByAgentId)) {
    for (const [serviceKey, binding] of Object.entries(defaults.bindingsByServiceId)) {
      if (binding.source === 'native') continue;
      const descriptors = input.agents?.filter(agent => agent.agentId === agentId) ?? [];
      const descriptor = descriptors.length === 1 ? descriptors[0] : undefined;
      if (!descriptor?.identity) return { status: 'unavailable', reason: 'authority-not-confirmed' };
      try {
        const declarations = descriptor.connectedAccounts.filter(declaration => (
          buildQualifiedPluginContributionKey(declaration.service) === serviceKey
        ));
        if (declarations.length === 0) return { status: 'unavailable', reason: 'authority-not-confirmed' };
        const servicesByPurpose = new Map<string, string>();
        for (const declaration of descriptor.connectedAccounts) {
          const key = qualifiedPurposeKey({ consumer: descriptor.identity, purpose: declaration.purpose });
          const declaredServiceKey = buildQualifiedPluginContributionKey(declaration.service);
          const previous = servicesByPurpose.get(key);
          if (previous && previous !== declaredServiceKey) {
            return { status: 'unavailable', reason: 'authority-not-confirmed' };
          }
          servicesByPurpose.set(key, declaredServiceKey);
        }
        for (const declaration of declarations) {
          const purpose = { consumer: descriptor.identity, purpose: declaration.purpose };
          const key = qualifiedPurposeKey(purpose);
          if (retainedKeys.has(key)) continue;
          const migrated = migrateLegacyDefaultAuthBinding(binding, declaration.service);
          if (migrated.target) bindings.push({ purpose, target: migrated.target });
          else if (migrated.teamResource) teamResourceSelections.push({ purpose, ...migrated.teamResource });
          else return { status: 'unavailable', reason: 'authority-not-confirmed' };
          retainedKeys.add(key);
        }
      } catch {
        return { status: 'unavailable', reason: 'authority-not-confirmed' };
      }
    }
  }
  const parsed = QualifiedConnectedAccountPurposeBindingsV1RecordSchema.safeParse({
    ...input.purposeBindings,
    bindings,
    ...(teamResourceSelections.length > 0 ? { teamResourceSelections } : {}),
  });
  return parsed.success
    ? { status: 'ready', purposeBindings: parsed.data }
    : { status: 'unavailable', reason: 'invalid-stored-content' };
}

const admittedPurposeBindings = new WeakMap<QualifiedConnectedAccountPurposeBindingsV1, ReturnType<typeof indexAgentPurposeBindings>>();
const admittedPurposeDeclarations = new WeakMap<readonly AgentConnectedAccountPurposeDeclaration[], AdmittedPurposeDeclarations>();

function indexAgentPurposeBindings(durable: QualifiedConnectedAccountPurposeBindingsV1) {
  const defaults = new Map<string, AgentConnectedAccountPurposeDefaultValue | 'team'>([
    ...durable.bindings.map(binding => [qualifiedPurposeKey(binding.purpose), Object.freeze({ target: binding.target, teamResource: null })] as const),
    ...(durable.teamResourceSelections ?? []).map(entry => [qualifiedPurposeKey(entry.purpose), 'team'] as const),
  ]);
  const teams = new Map((durable.teamResourceSelections ?? []).map(entry => [qualifiedPurposeKey(entry.purpose), entry] as const));
  // Admitted targets and Team rows belong to the deep-frozen catalog; only these wrappers are new.
  return Object.freeze({ defaultFor: (key: string) => defaults.get(key), teamFor: (key: string) => teams.get(key) });
}

type AgentPurposeEntry = Readonly<{ key: string; purpose: QualifiedConnectedAccountPurposeV1; service: AgentConnectedAccountPurposeDeclaration['service'] }>;
type AdmittedPurposeDeclarations = Readonly<{
  consumer: QualifiedConnectedAccountPurposeV1['consumer'];
  entries: readonly AgentPurposeEntry[];
}>;

/** Acquire an immutable purpose catalog; admission facts never survive a wire/JSON copy. */
export function admitAgentConnectedAccountPurposeBindings(input: unknown): QualifiedConnectedAccountPurposeBindingsV1 {
  // Acquisition receives the current catalog shape, not the bounded legacy Settings carrier.
  // Strict JSON owns the deep frozen copy; the catalog schema owns validation.
  const value = normalizeStrictJsonValue(QualifiedConnectedAccountPurposeBindingsV1RecordSchema.parse(input)) as QualifiedConnectedAccountPurposeBindingsV1;
  admittedPurposeBindings.set(value, indexAgentPurposeBindings(value));
  return value;
}

/** Acquire Agent purpose declarations at projection publication, preserving their other declared fields. */
export function admitAgentConnectedAccountPurposeDeclarations<T extends AgentConnectedAccountPurposeDeclaration>(
  consumer: QualifiedConnectedAccountPurposeV1['consumer'], declarations: readonly T[],
): readonly T[] {
  const entries = declarations.map(declaration => {
    const purpose = QualifiedConnectedAccountPurposeV1Schema.parse({ consumer, purpose: declaration.purpose });
    const service = ConnectedAccountServiceIdentityV1Schema.parse(declaration.service);
    return { key: qualifiedPurposeKey(purpose), purpose, service };
  });
  const copied = normalizeStrictJsonValue(declarations) as readonly T[];
  const value = Object.freeze([...copied]);
  const facts: AdmittedPurposeDeclarations = {
    consumer: Object.freeze({ ...consumer }), entries: normalizeStrictJsonValue(entries) as readonly AgentPurposeEntry[] };
  admittedPurposeDeclarations.set(value, Object.freeze(facts));
  return value;
}

/**
 * THE Agent default-authentication reader. An admitted purpose catalog is the
 * sole authority, including when empty. Legacy Settings seed an absent catalog
 * through the catalog activation owner.
 */
export function resolveAgentConnectedAccountPurposeDefaults(input: Readonly<{
  /** Exclude implicit native fallbacks when projecting deliberate member choices. */
  onlySavedDefaults?: boolean;
  purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
  consumer: Readonly<{ pluginId: string; localId: string }>;
  declarations: readonly AgentConnectedAccountPurposeDeclaration[];
}>): readonly AgentConnectedAccountPurposeDefault[] {
  const durable = input.purposeBindings ?? DEFAULT_CONNECTED_ACCOUNT_PURPOSE_BINDINGS_V1;
  const index = admittedPurposeBindings.get(durable) ?? indexAgentPurposeBindings(durable);
  const declarationFacts = admittedPurposeDeclarations.get(input.declarations);
  const entries = declarationFacts
      && declarationFacts.consumer.pluginId === input.consumer.pluginId && declarationFacts.consumer.localId === input.consumer.localId
    ? declarationFacts.entries
    : input.declarations.map(declaration => {
        const purpose = { consumer: { pluginId: input.consumer.pluginId, localId: input.consumer.localId }, purpose: declaration.purpose };
        return { key: qualifiedPurposeKey(purpose), purpose,
          service: { pluginId: declaration.service.pluginId, localId: declaration.service.localId } };
      });
  const seen = new Set<string>();
  const defaults: AgentConnectedAccountPurposeDefault[] = [];
  for (const { key, purpose, service } of entries) {
    if (seen.has(key)) continue;
    seen.add(key);
    const durableValue = index.defaultFor(key);
    if (input.onlySavedDefaults && durableValue === undefined) continue;
    const teamSelection = index.teamFor(key);
    const teamResource = durableValue === 'team' && teamSelection
      ? teamResourceDefaultForService(teamSelection, service)
      : null;
    const value = durableValue === 'team'
      ? { target: null, teamResource }
      : durableValue ?? NO_PURPOSE_DEFAULT;
    defaults.push({ purpose, service, target: value.target, teamResource: value.teamResource });
  }
  return defaults;
}

/** Set or clear one declared Agent purpose through the shared purpose writer. */
export function writeAgentConnectedAccountPurposeDefault(input: Readonly<{
  purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
  consumer: Readonly<{ pluginId: string; localId: string }>;
  purpose: string;
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  teamResource?: AgentConnectedAccountPurposeTeamResourceDefault | null;
}>): ReturnType<typeof writeConnectedAccountPurposeDefault> {
  return writeConnectedAccountPurposeDefault({ purposeBindings: input.purposeBindings,
    purpose: { consumer: input.consumer, purpose: input.purpose }, target: input.target, teamResource: input.teamResource });
}

/** One purpose-default writer for Resources, Providers and Agents. */
export function writeConnectedAccountPurposeDefault(input: Readonly<{
  purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
  purpose: QualifiedConnectedAccountPurposeV1;
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  teamResource?: AgentConnectedAccountPurposeTeamResourceDefault | null;
}>): Readonly<{ connectedAccountPurposeBindingsV1: QualifiedConnectedAccountPurposeBindingsV1 }> {
  if (input.target && input.teamResource) {
    throw new Error('A purpose default is either a personal target or a Team resource');
  }
  const durable = input.purposeBindings ?? DEFAULT_CONNECTED_ACCOUNT_PURPOSE_BINDINGS_V1;
  const changedKey = qualifiedPurposeKey(input.purpose);
  const retained = (entry: { purpose: QualifiedConnectedAccountPurposeV1 }) => qualifiedPurposeKey(entry.purpose) !== changedKey;
  const bindings = durable.bindings.filter(retained);
  const teamResourceSelections = (durable.teamResourceSelections ?? []).filter(retained);
  if (input.target) bindings.push({ purpose: input.purpose, target: input.target });
  if (input.teamResource) teamResourceSelections.push({ purpose: input.purpose, ...input.teamResource });
  return {
    connectedAccountPurposeBindingsV1: QualifiedConnectedAccountPurposeBindingsV1RecordSchema.parse({
      v: 1,
      bindings,
      ...(teamResourceSelections.length > 0 ? { teamResourceSelections } : {}),
    }),
  };
}

/** After successful deletion, clear only matching personal targets, including for unloaded Agents. */
export function removeAgentConnectedAccountDefaultsForDeletedTarget(input: Readonly<{
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  target: QualifiedConnectedAccountPurposeBindingTargetV1;
}>): ReturnType<typeof writeConnectedAccountPurposeDefault> | null {
  const { purposeBindings, target } = input;
  const bindings = purposeBindings.bindings.filter(({ target: candidate }) => !(
    candidate.kind === 'account' && target.kind === 'account'
      ? sameQualifiedConnectedAccountRef(candidate.account, target.account)
      : candidate.kind === 'group' && target.kind === 'group' && sameQualifiedConnectedAccountGroupRef(candidate, target)
  ));
  return bindings.length === purposeBindings.bindings.length ? null
    : { connectedAccountPurposeBindingsV1: { ...purposeBindings, bindings } };
}

/**
 * The service-keyed editing seam of the same writer: one Session-shaped
 * selection for a declared service becomes that service's purpose default for
 * every purpose the Agent declares on it. `native` clears them. A Team
 * resource selection needs the Team that offers it; without one nothing is
 * written, because a durable Team default must name its Team.
 */
export function writeAgentConnectedServiceDefault(input: Readonly<{
  purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
  consumer: Readonly<{ pluginId: string; localId: string }>;
  declarations: readonly AgentConnectedAccountPurposeDeclaration[];
  serviceKey: string;
  purpose?: string;
  selection: ConnectedServiceBindingSelectionV2;
  teamId?: string;
}>): ReturnType<typeof writeConnectedAccountPurposeDefault> | null {
  let purposeBindings = input.purposeBindings;
  let written: ReturnType<typeof writeAgentConnectedAccountPurposeDefault> | null = null;
  for (const declaration of input.declarations) {
    if (buildQualifiedPluginContributionKey(declaration.service) !== input.serviceKey) continue;
    if (input.purpose !== undefined && declaration.purpose !== input.purpose) continue;
    const service = { pluginId: declaration.service.pluginId, localId: declaration.service.localId };
    const selection = input.selection;
    let target: QualifiedConnectedAccountPurposeBindingTargetV1 | null = null;
    let teamResource: AgentConnectedAccountPurposeTeamResourceDefault | null = null;
    if (selection.source === 'native') {
      target = null;
    } else if (selection.source === 'team_resource') {
      if (!input.teamId) return null;
      teamResource = teamResourceDefaultForService({ teamId: input.teamId, selection }, service);
      if (!teamResource) return null;
    } else if (selection.selection === 'group') {
      target = { kind: 'group', service, groupId: selection.groupId };
    } else {
      target = { kind: 'account', account: { service, accountId: selection.profileId } };
    }
    written = writeAgentConnectedAccountPurposeDefault({
      purposeBindings,
      consumer: input.consumer,
      purpose: declaration.purpose,
      target,
      teamResource,
    });
    purposeBindings = written.connectedAccountPurposeBindingsV1;
  }
  return written;
}

/**
 * Projects resolved purpose defaults onto the Session's service-keyed launch
 * selection (`ConnectedServiceBindingsV2`). A Session binds one selection per
 * service, so the first declared purpose of a service decides it.
 */
export function projectAgentConnectedAccountPurposeDefaultsToSessionBindings(
  defaults: readonly AgentConnectedAccountPurposeDefault[],
): ConnectedServiceBindingsV2 | null {
  const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV2> = {};
  for (const entry of defaults) {
    const serviceKey = buildQualifiedPluginContributionKey(entry.service);
    if (serviceKey in bindingsByServiceId) continue;
    const target = entry.target;
    if (target) {
      bindingsByServiceId[serviceKey] = target.kind === 'account'
        ? { source: 'connected', selection: 'profile', profileId: target.account.accountId }
        : { source: 'connected', selection: 'group', groupId: target.groupId };
    } else if (entry.teamResource) {
      bindingsByServiceId[serviceKey] = entry.teamResource.selection;
    }
  }
  return Object.keys(bindingsByServiceId).length > 0
    ? ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId })
    : null;
}

export const ConnectedServicesProviderConfigSharingModeV1Schema = lazyZodSchema(() => z.enum([
  'linked',
  'copied',
  'isolated',
]));

export type ConnectedServicesProviderConfigSharingModeV1 = z.infer<
  typeof ConnectedServicesProviderConfigSharingModeV1Schema
>;

export const ConnectedServicesProviderStateSharingModeV1Schema = lazyZodSchema(() => z.enum([
  'isolated',
  'shared',
]));

export type ConnectedServicesProviderStateSharingModeV1 = z.infer<
  typeof ConnectedServicesProviderStateSharingModeV1Schema
>;

export const ConnectedServicesProviderStateSharingPolicyV1Schema = lazyZodSchema(() => z.strictObject({
    configMode: z._default(ConnectedServicesProviderConfigSharingModeV1Schema, 'linked'),
    // Default to shared session state: most users connect multiple accounts for
    // usage/quota and expect their provider sessions to continue across accounts.
    // Turning this off (via `defaults.stateMode` or a per-agent `byAgentId`
    // override) is the opt-out. Providers whose descriptor reports
    // `state.supported: false` ignore `shared` and stay isolated.
    stateMode: z._default(ConnectedServicesProviderStateSharingModeV1Schema, 'shared'),
  }));

export type ConnectedServicesProviderStateSharingPolicyV1 = z.infer<
  typeof ConnectedServicesProviderStateSharingPolicyV1Schema
>;

const ConnectedServicesProviderStateSharingOverrideV1Schema = lazyZodSchema(() => z.strictObject({
    configMode: z.optional(ConnectedServicesProviderConfigSharingModeV1Schema),
    stateMode: z.optional(ConnectedServicesProviderStateSharingModeV1Schema),
  }));

const ConnectedServicesProviderStateSharingRiskAcknowledgementV1Schema = lazyZodSchema(() => z.strictObject({
    sharedStatePrivacy: z.optional(z.boolean()),
    symlinkUnavailable: z.optional(z.boolean()),
  }));

export const ConnectedServicesProviderStateSharingSettingsV1Schema = lazyZodSchema(() => z.pipe(z.catch(z.strictObject({
    v: z._default(z.literal(1), 1),
    defaults: z._default(ConnectedServicesProviderStateSharingPolicyV1Schema, {
      configMode: 'linked',
      stateMode: 'shared',
    }),
    byAgentId: z._default(z
      .record(AgentIdSettingsKeySchema, ConnectedServicesProviderStateSharingOverrideV1Schema), {}),
    acknowledgedRisksByAgentId: z._default(z
      .record(AgentIdSettingsKeySchema, ConnectedServicesProviderStateSharingRiskAcknowledgementV1Schema), {}),
  }), {
    v: 1,
    defaults: {
      configMode: 'linked',
      stateMode: 'shared',
    },
    byAgentId: {},
    acknowledgedRisksByAgentId: {},
  }), z.transform((value) => ({
    ...value,
    byAgentId: normalizeAgentKeyedSettings(value.byAgentId),
    acknowledgedRisksByAgentId: normalizeAgentKeyedSettings(value.acknowledgedRisksByAgentId),
  }))));

export type ConnectedServicesProviderStateSharingSettingsV1 = z.infer<
  typeof ConnectedServicesProviderStateSharingSettingsV1Schema
>;

export const DEFAULT_CONNECTED_SERVICES_PROVIDER_STATE_SHARING_SETTINGS_V1:
  ConnectedServicesProviderStateSharingSettingsV1 =
    ConnectedServicesProviderStateSharingSettingsV1Schema.parse({});

export function resolveConnectedServicesProviderStateSharingPolicyV1(
  settingsLike: unknown,
  agentId: string,
): ConnectedServicesProviderStateSharingPolicyV1 {
  const settings = ConnectedServicesProviderStateSharingSettingsV1Schema.parse(settingsLike);
  const override = settings.byAgentId[agentId];
  return {
    configMode: override?.configMode ?? settings.defaults.configMode,
    stateMode: override?.stateMode ?? settings.defaults.stateMode,
  };
}

export type ConnectedServicesDefaultAuthBindingByAgentIdV1 = Record<
  string,
  ConnectedServiceBindingsV1 | ConnectedServicesDefaultAuthBindingsV2
>;
