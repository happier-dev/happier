import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

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
  type QualifiedConnectedAccountPurposeBindingV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
  type QualifiedConnectedAccountPurposeTeamResourceSelectionV1,
} from '../../connect/connectedAccountPurposeBindings.js';
import type { QualifiedConnectedAccountPurposeV1 } from '../../connect/connectedAccountPurposeIdentity.js';
import { buildQualifiedPluginContributionKey } from '../../plugins/contributionIdentity.js';
import { resolveGeneratedSessionPresentationAgentIdV1 } from '../../agents/generated/sessionPresentationCompatV1.js';
import { sameQualifiedConnectedAccountRef } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { sameQualifiedConnectedAccountGroupRef } from '../../connect/qualifiedConnectedAccountsV4.js';

const AgentIdSettingsKeySchema = lazyZodSchema(() => z.string().trim().min(1));

const ConnectedServicesDefaultAuthTeamResourceQualifierV2Shape = {
  serverId: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
  expectedResourceRevision: z.number().int().nonnegative(),
} as const;

export const ConnectedServicesDefaultAuthTeamResourceBindingV2Schema = lazyZodSchema(() => z.union([
  TeamResourceBrokeredConnectedServiceSelectionV2Schema.extend(
    ConnectedServicesDefaultAuthTeamResourceQualifierV2Shape,
  ),
  TeamResourceDirectConnectedServiceSelectionV2Schema.extend(
    ConnectedServicesDefaultAuthTeamResourceQualifierV2Shape,
  ),
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
).superRefine((bindings, context) => {
  for (const serviceId of Object.keys(bindings)) {
    if (ConnectedAccountServiceKeySchema.safeParse(serviceId).success) continue;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid qualified Connected Account service key',
      path: [serviceId],
    });
  }
}));

export const ConnectedServicesDefaultAuthBindingsV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2),
  bindingsByServiceId: ConnectedServicesDefaultAuthBindingsByServiceIdV2Schema.default({}),
}).strict());
export type ConnectedServicesDefaultAuthBindingsV2 = z.infer<
  typeof ConnectedServicesDefaultAuthBindingsV2Schema
>;

const ConnectedServicesDefaultAuthBindingsIngressSchema = lazyZodSchema(() => z.union([
  ConnectedServicesDefaultAuthBindingsV2Schema,
  ConnectedServiceBindingsV1Schema,
]));

export const ConnectedServicesDefaultAuthByAgentIdV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1).default(1),
    bindingsByAgentId: z.record(AgentIdSettingsKeySchema, ConnectedServicesDefaultAuthBindingsIngressSchema).default({}),
  })
  .strict());

/** Released bundled account settings used scalar service ids before qualified service identity. */
const BuiltInLegacyConnectedServicesDefaultAuthByAgentIdV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1).default(1),
    bindingsByAgentId: z.record(
      AgentIdSettingsKeySchema,
      BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
    ).default({}),
  })
  .strict()
  .transform((value) => ConnectedServicesDefaultAuthByAgentIdV1Schema.parse(value)));

const ConnectedServicesDefaultAuthByAgentIdV1SourceSchema = lazyZodSchema(() => z
  .union([
    ConnectedServicesDefaultAuthByAgentIdV1Schema,
    BuiltInLegacyConnectedServicesDefaultAuthByAgentIdV1Schema,
  ]));

export const BuiltInLegacyConnectedServicesDefaultAuthByAgentIdV1IngressSchema = lazyZodSchema(() =>
  ConnectedServicesDefaultAuthByAgentIdV1SourceSchema
  .catch({ v: 1 as const, bindingsByAgentId: {} }));

/**
 * Prospective 0.2 G2 ingress: the carrier is disjoint from released scalar
 * services and survives released UI writers. Read it through the same generated
 * service and Agent identities; current defaults are authored only as purposes.
 * Remove once predecessor-created additional defaults have all migrated.
 */
export const BuiltInLegacyAdditionalConnectedServicesDefaultAuthByAgentIdV1IngressSchema = lazyZodSchema(() =>
  ConnectedServicesDefaultAuthByAgentIdV1SourceSchema.transform((value) => ({
    v: value.v,
    bindingsByAgentId: Object.fromEntries(Object.entries(value.bindingsByAgentId).map(([agentId, bindings]) => [
      resolveGeneratedSessionPresentationAgentIdV1({ flavor: agentId }) ?? agentId,
      bindings,
    ])),
  })),
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

/**
 * THE Agent default-authentication reader. An admitted purpose catalog is the
 * sole authority, including when empty. Only callers at the genuine predecessor
 * migration seam omit the catalog and read retained service-keyed defaults.
 */
export function resolveAgentConnectedAccountPurposeDefaults(input: Readonly<{
  settings: AgentConnectedAccountDefaultSettings;
  purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
  agentId: string;
  consumer: Readonly<{ pluginId: string; localId: string }>;
  declarations: readonly AgentConnectedAccountPurposeDeclaration[];
}>): readonly AgentConnectedAccountPurposeDefault[] {
  const durable = input.purposeBindings ?? DEFAULT_CONNECTED_ACCOUNT_PURPOSE_BINDINGS_V1;
  const legacy = input.purposeBindings === undefined ? readLegacyDefaultAuthSettings(input.settings)
    .bindingsByAgentId[input.agentId.trim()]
    ?.bindingsByServiceId : undefined;
  const durableByPurposeKey = new Map<string, AgentConnectedAccountPurposeDefaultValue | 'team'>([
    ...durable.bindings.map((binding) => [
      qualifiedPurposeKey(binding.purpose),
      { target: binding.target, teamResource: null },
    ] as const),
    ...(durable.teamResourceSelections ?? []).map((entry) => [qualifiedPurposeKey(entry.purpose), 'team'] as const),
  ]);
  const teamSelectionByPurposeKey = new Map(
    (durable.teamResourceSelections ?? []).map((entry) => [qualifiedPurposeKey(entry.purpose), entry] as const),
  );
  const seen = new Set<string>();
  const defaults: AgentConnectedAccountPurposeDefault[] = [];
  for (const declaration of input.declarations) {
    const purpose = {
      consumer: { pluginId: input.consumer.pluginId, localId: input.consumer.localId },
      purpose: declaration.purpose,
    };
    const key = qualifiedPurposeKey(purpose);
    if (seen.has(key)) continue;
    seen.add(key);
    const service = { pluginId: declaration.service.pluginId, localId: declaration.service.localId };
    const durableValue = durableByPurposeKey.get(key);
    const teamSelection = teamSelectionByPurposeKey.get(key);
    const teamResource = durableValue === 'team' && teamSelection
      ? teamResourceDefaultForService(teamSelection, service)
      : null;
    const value = durableValue === 'team'
      ? { target: null, teamResource }
      : durableValue ?? migrateLegacyDefaultAuthBinding(
          legacy?.[buildQualifiedPluginContributionKey(service)],
          service,
        );
    defaults.push({ purpose, service, target: value.target, teamResource: value.teamResource });
  }
  return defaults;
}

/**
 * THE Agent default-authentication writer. It sets (or clears) one purpose in
 * the purpose-binding catalog and, in the same operation, folds that
 * Agent's released service-keyed entry into purpose entries and deletes it,
 * so a cleared purpose can never be resurrected from the retired store.
 */
export function writeAgentConnectedAccountPurposeDefault(input: Readonly<{
  settings: AgentConnectedAccountDefaultSettings;
  purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
  agentId: string;
  consumer: Readonly<{ pluginId: string; localId: string }>;
  declarations: readonly AgentConnectedAccountPurposeDeclaration[];
  purpose: string;
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  /** A Team resource default for the purpose; the personal `target` must then be null. */
  teamResource?: AgentConnectedAccountPurposeTeamResourceDefault | null;
}>): Readonly<{
  connectedAccountPurposeBindingsV1: QualifiedConnectedAccountPurposeBindingsV1;
  connectedServicesDefaultAuthByAgentIdV1: ConnectedServicesDefaultAuthByAgentIdV1;
  connectedServicesAdditionalDefaultAuthByAgentIdV1: ConnectedServicesDefaultAuthByAgentIdV1;
}> {
  return writeConnectedAccountPurposeDefault({ settings: input.settings, purposeBindings: input.purposeBindings,
    purpose: { consumer: input.consumer, purpose: input.purpose }, target: input.target,
    teamResource: input.teamResource, legacyAgent: { agentId: input.agentId, declarations: input.declarations } });
}

/** One purpose-default writer for Resources, Providers and Agents; no parallel selection store. */
export function writeConnectedAccountPurposeDefault(input: Readonly<{
  settings: AgentConnectedAccountDefaultSettings;
  purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
  purpose: QualifiedConnectedAccountPurposeV1;
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  teamResource?: AgentConnectedAccountPurposeTeamResourceDefault | null;
  /** Only Agents have the released service-keyed ingress to fold in and remove. */
  legacyAgent?: Readonly<{ agentId: string; declarations: readonly AgentConnectedAccountPurposeDeclaration[] }>;
}>): Readonly<{
  connectedAccountPurposeBindingsV1: QualifiedConnectedAccountPurposeBindingsV1;
  connectedServicesDefaultAuthByAgentIdV1: ConnectedServicesDefaultAuthByAgentIdV1;
  connectedServicesAdditionalDefaultAuthByAgentIdV1: ConnectedServicesDefaultAuthByAgentIdV1;
}> {
  if (input.target && input.teamResource) {
    throw new Error('A purpose default is either a personal target or a Team resource');
  }
  const changedValue: AgentConnectedAccountPurposeDefaultValue = {
    target: input.target,
    teamResource: input.teamResource ?? null,
  };
  const agentId = input.legacyAgent?.agentId.trim();
  const current = input.legacyAgent ? resolveAgentConnectedAccountPurposeDefaults({ settings: input.settings, purposeBindings: input.purposeBindings,
    consumer: input.purpose.consumer, ...input.legacyAgent }) : [];
  const declaredKeys = new Set(current.map((entry) => qualifiedPurposeKey(entry.purpose)));
  const changedKey = qualifiedPurposeKey(input.purpose);
  const durable = input.purposeBindings ?? DEFAULT_CONNECTED_ACCOUNT_PURPOSE_BINDINGS_V1;
  const retainedKey = (purpose: QualifiedConnectedAccountPurposeV1) => (
    !declaredKeys.has(qualifiedPurposeKey(purpose)) && qualifiedPurposeKey(purpose) !== changedKey
  );
  const next: QualifiedConnectedAccountPurposeBindingV1[] = durable.bindings
    .filter((binding) => retainedKey(binding.purpose));
  const nextTeamSelections: QualifiedConnectedAccountPurposeTeamResourceSelectionV1[] =
    (durable.teamResourceSelections ?? []).filter((entry) => retainedKey(entry.purpose));
  const push = (purpose: QualifiedConnectedAccountPurposeV1, value: AgentConnectedAccountPurposeDefaultValue) => {
    if (value.target) next.push({ purpose, target: value.target });
    else if (value.teamResource) nextTeamSelections.push({ purpose, ...value.teamResource });
  };
  let wroteChanged = false;
  for (const entry of current) {
    const key = qualifiedPurposeKey(entry.purpose);
    if (key === changedKey) wroteChanged = true;
    push(entry.purpose, key === changedKey ? changedValue : entry);
  }
  if (!wroteChanged) {
    push(input.purpose, changedValue);
  }
  const legacy = readLegacyDefaultAuth(input.settings.connectedServicesDefaultAuthByAgentIdV1);
  const additional = readAdditionalLegacyDefaultAuth(input.settings.connectedServicesAdditionalDefaultAuthByAgentIdV1);
  const remainingAdditionalAgents = Object.fromEntries(
    Object.entries(additional.bindingsByAgentId).filter(([legacyAgentId]) => legacyAgentId !== agentId),
  );
  const remainingLegacyAgents = Object.fromEntries(
    Object.entries(legacy.bindingsByAgentId).filter(([legacyAgentId]) => legacyAgentId !== agentId),
  );
  return {
    connectedAccountPurposeBindingsV1: QualifiedConnectedAccountPurposeBindingsV1RecordSchema.parse({
      v: 1,
      bindings: next,
      ...(nextTeamSelections.length > 0 ? { teamResourceSelections: nextTeamSelections } : {}),
    }),
    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: remainingLegacyAgents },
    connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: remainingAdditionalAgents },
  };
}

/**
 * The deletion arm of the purpose-default writer. Call only after the exact account or pool
 * was successfully removed, never when discovery or credentials are temporarily unavailable.
 * Clean retained purpose entries even when their Agent is absent from the loaded catalog, and
 * remove matching released service-keyed defaults so they cannot resurrect the deleted target.
 * Team resources and defaults for other targets retain their own authority.
 */
export function removeAgentConnectedAccountDefaultsForDeletedTarget(input: Readonly<{
  settings: AgentConnectedAccountDefaultSettings;
  purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
  target: QualifiedConnectedAccountPurposeBindingTargetV1;
}>): ReturnType<typeof writeAgentConnectedAccountPurposeDefault> | null {
  const { target } = input;
  const service = target.kind === 'account' ? target.account.service : target.service;
  const matches = (candidate: QualifiedConnectedAccountPurposeBindingTargetV1) => (
    candidate.kind === 'account' && target.kind === 'account'
      ? sameQualifiedConnectedAccountRef(candidate.account, target.account)
      : candidate.kind === 'group' && target.kind === 'group'
        && sameQualifiedConnectedAccountGroupRef(candidate, target)
  );
  const durable = input.purposeBindings ?? DEFAULT_CONNECTED_ACCOUNT_PURPOSE_BINDINGS_V1;
  const bindings = durable.bindings.filter((binding) => !matches(binding.target));
  let changed = bindings.length !== durable.bindings.length;
  const legacy = readLegacyDefaultAuth(input.settings.connectedServicesDefaultAuthByAgentIdV1);
  const additional = readAdditionalLegacyDefaultAuth(input.settings.connectedServicesAdditionalDefaultAuthByAgentIdV1);
  const serviceKey = buildQualifiedPluginContributionKey(service);
  const removeFromCarrier = (carrier: ConnectedServicesDefaultAuthByAgentIdV1): ConnectedServicesDefaultAuthByAgentIdV1 => {
    const bindingsByAgentId = { ...carrier.bindingsByAgentId };
    for (const [agentId, agentBindings] of Object.entries(carrier.bindingsByAgentId)) {
      const retained = agentBindings.bindingsByServiceId;
      const legacyTarget = migrateLegacyDefaultAuthBinding(retained[serviceKey], service).target;
      if (!legacyTarget || !matches(legacyTarget)) continue;
      changed = true;
      const bindingsByServiceId = { ...retained };
      delete bindingsByServiceId[serviceKey];
      if (Object.keys(bindingsByServiceId).length === 0) delete bindingsByAgentId[agentId];
      else bindingsByAgentId[agentId] = ConnectedServicesDefaultAuthBindingsIngressSchema.parse({
        ...agentBindings,
        bindingsByServiceId,
      });
    }
    return { ...carrier, bindingsByAgentId };
  };
  const remainingLegacy = removeFromCarrier(legacy);
  const remainingAdditional = removeFromCarrier(additional);
  if (!changed) return null;
  return {
    connectedAccountPurposeBindingsV1: { ...durable, bindings },
    connectedServicesDefaultAuthByAgentIdV1: remainingLegacy,
    connectedServicesAdditionalDefaultAuthByAgentIdV1: remainingAdditional,
  };
}

/**
 * The service-keyed editing seam of the same writer: one Session-shaped
 * selection for a declared service becomes that service's purpose default for
 * every purpose the Agent declares on it. `native` clears them. A Team
 * resource selection needs the Team that offers it; without one nothing is
 * written, because a durable Team default must name its Team.
 */
export function writeAgentConnectedServiceDefault(input: Readonly<{
  settings: AgentConnectedAccountDefaultSettings;
  purposeBindings?: QualifiedConnectedAccountPurposeBindingsV1;
  agentId: string;
  consumer: Readonly<{ pluginId: string; localId: string }>;
  declarations: readonly AgentConnectedAccountPurposeDeclaration[];
  serviceKey: string;
  purpose?: string;
  selection: ConnectedServiceBindingSelectionV2;
  teamId?: string;
}>): Readonly<{
  connectedAccountPurposeBindingsV1: QualifiedConnectedAccountPurposeBindingsV1;
  connectedServicesDefaultAuthByAgentIdV1: ConnectedServicesDefaultAuthByAgentIdV1;
  connectedServicesAdditionalDefaultAuthByAgentIdV1: ConnectedServicesDefaultAuthByAgentIdV1;
}> | null {
  let settings: AgentConnectedAccountDefaultSettings = input.settings;
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
      settings,
      purposeBindings,
      agentId: input.agentId,
      consumer: input.consumer,
      declarations: input.declarations,
      purpose: declaration.purpose,
      target,
      teamResource,
    });
    settings = written;
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

export const ConnectedServicesProviderStateSharingPolicyV1Schema = lazyZodSchema(() => z
  .object({
    configMode: ConnectedServicesProviderConfigSharingModeV1Schema.default('linked'),
    // Default to shared session state: most users connect multiple accounts for
    // usage/quota and expect their provider sessions to continue across accounts.
    // Turning this off (via `defaults.stateMode` or a per-agent `byAgentId`
    // override) is the opt-out. Providers whose descriptor reports
    // `state.supported: false` ignore `shared` and stay isolated.
    stateMode: ConnectedServicesProviderStateSharingModeV1Schema.default('shared'),
  })
  .strict());

export type ConnectedServicesProviderStateSharingPolicyV1 = z.infer<
  typeof ConnectedServicesProviderStateSharingPolicyV1Schema
>;

const ConnectedServicesProviderStateSharingOverrideV1Schema = lazyZodSchema(() => z
  .object({
    configMode: ConnectedServicesProviderConfigSharingModeV1Schema.optional(),
    stateMode: ConnectedServicesProviderStateSharingModeV1Schema.optional(),
  })
  .strict());

const ConnectedServicesProviderStateSharingRiskAcknowledgementV1Schema = lazyZodSchema(() => z
  .object({
    sharedStatePrivacy: z.boolean().optional(),
    symlinkUnavailable: z.boolean().optional(),
  })
  .strict());

export const ConnectedServicesProviderStateSharingSettingsV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1).default(1),
    defaults: ConnectedServicesProviderStateSharingPolicyV1Schema.default({
      configMode: 'linked',
      stateMode: 'shared',
    }),
    byAgentId: z
      .record(AgentIdSettingsKeySchema, ConnectedServicesProviderStateSharingOverrideV1Schema)
      .default({}),
    acknowledgedRisksByAgentId: z
      .record(AgentIdSettingsKeySchema, ConnectedServicesProviderStateSharingRiskAcknowledgementV1Schema)
      .default({}),
  })
  .strict()
  .catch({
    v: 1,
    defaults: {
      configMode: 'linked',
      stateMode: 'shared',
    },
    byAgentId: {},
    acknowledgedRisksByAgentId: {},
  }));

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
