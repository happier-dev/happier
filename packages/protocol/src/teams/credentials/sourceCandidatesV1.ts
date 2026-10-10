import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { TeamCredentialSourceBindingV1Schema } from './sourceBindingV1.js';
import {
  TeamCredentialBrokerPlacementV1Schema,
  TeamCredentialBrokerPresentationV1Schema,
  TeamCredentialDisclosureCeilingV1Schema,
  TeamCredentialResourceAdministrationCapabilitiesV1Schema,
  TeamCredentialResourceRecoveryActionV1Schema,
} from './resourceV1.js';
import { TeamCredentialResourceReadinessV1Schema } from './readinessV1.js';
import {
  QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema,
  QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema,
} from '../../connect/connectedAccountPurposeBindings.js';
import { ProviderConnectionIdSchema } from '../../providers/ids.js';

/**
 * Stable owner-visible source identity used to recover shares after source
 * rotation, replacement, or Team departure. Revision/currentness fields are
 * deliberately absent: they decide whether a resource is usable, not which
 * source-detail surface owns its withdrawal controls.
 */
export const TeamCredentialSourceLocatorV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('connected_account'),
    target: QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('connected_pool'),
    target: QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('provider_connection'),
    connectionId: ProviderConnectionIdSchema,
  }).strict(),
]));
export type TeamCredentialSourceLocatorV1 = z.infer<typeof TeamCredentialSourceLocatorV1Schema>;

export const TeamCredentialSourceResourceListInputV1Schema = lazyZodSchema(() => z.object({
  source: TeamCredentialSourceLocatorV1Schema,
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict());
export type TeamCredentialSourceResourceListInputV1 = z.infer<
  typeof TeamCredentialSourceResourceListInputV1Schema
>;

/**
 * Least-privilege source-detail administration row. Team directory, audience,
 * policy, limits, source binding, and custodian identity never cross this seam.
 */
export const TeamCredentialSourceResourceAdministrationV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1).max(256),
  displayName: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  disclosureCeiling: TeamCredentialDisclosureCeilingV1Schema,
  brokerPlacement: TeamCredentialBrokerPlacementV1Schema.nullable(),
  brokerPresentation: TeamCredentialBrokerPresentationV1Schema,
  readiness: TeamCredentialResourceReadinessV1Schema,
  recoveryAction: TeamCredentialResourceRecoveryActionV1Schema.nullable(),
  capabilities: TeamCredentialResourceAdministrationCapabilitiesV1Schema,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict());
export type TeamCredentialSourceResourceAdministrationV1 = z.infer<
  typeof TeamCredentialSourceResourceAdministrationV1Schema
>;

export const TeamCredentialSourceResourceListOutputV1Schema = lazyZodSchema(() => z.object({
  resources: z.array(TeamCredentialSourceResourceAdministrationV1Schema).max(100),
  nextCursor: z.string().min(1).max(512).nullable().default(null),
}).strict());
export type TeamCredentialSourceResourceListOutputV1 = z.infer<
  typeof TeamCredentialSourceResourceListOutputV1Schema
>;

export function teamCredentialSourceLocatorV1(
  source: z.infer<typeof TeamCredentialSourceBindingV1Schema>,
): TeamCredentialSourceLocatorV1 {
  switch (source.kind) {
    case 'connected_account':
      return { v: 1, kind: source.kind, target: source.target };
    case 'connected_pool':
      return { v: 1, kind: source.kind, target: source.target };
    case 'provider_connection':
      return { v: 1, kind: source.kind, connectionId: source.connectionId };
  }
}

export function teamCredentialSourceLocatorKeyV1(source: TeamCredentialSourceLocatorV1): string {
  switch (source.kind) {
    case 'connected_account':
      return JSON.stringify(['connected_account', source.target.account.service.pluginId,
        source.target.account.service.localId, source.target.account.accountId]);
    case 'connected_pool':
      return JSON.stringify(['connected_pool', source.target.service.pluginId,
        source.target.service.localId, source.target.groupId]);
    case 'provider_connection':
      return JSON.stringify(['provider_connection', source.connectionId]);
  }
}

/**
 * One source the authenticated Account may offer to a Team, as the Home sees it
 * right now.
 *
 * The candidate exists because the pinned lifetime a resource stores — the
 * owning credential row for an Account, the persisted incarnation for a Pool —
 * is the Home's own fact and is deliberately absent from the Connected Account
 * read projections a client holds. Without this projection a client could name a
 * source but never pin it, so either creation would drop the pin (and a replaced
 * source would be silently retargeted) or the Home would have to re-resolve the
 * pin itself and lose the "the source I chose is the source I offered" refusal.
 *
 * It is a chooser's projection, not a credential read: no token, expiry, refresh
 * lease, configuration, scope or upstream identity crosses it. Every field is
 * already the requesting Account's own, because only a source's own custodian
 * may offer it.
 */
export const TeamCredentialSourceCandidateV1Schema = lazyZodSchema(() => z.object({
  /**
   * The exact binding the create intent sends back unchanged. The client never
   * assembles one: assembling it is what would let a stale or invented pin
   * reach the resource owner.
   */
  source: TeamCredentialSourceBindingV1Schema,
  /**
   * Stable identity for list keys and selection within one answer. It is
   * derived from the binding by the Home so two candidates that differ only in
   * their pin remain distinguishable.
   */
  candidateId: z.string().min(1).max(512),
  /**
   * What this source is called where its owner already manages it.
   *
   * It is always safe presentation from the source owner, never the qualified
   * routing identity. Connected Accounts use their canonical display name or
   * provider email; rows without either remain absent from the chooser instead
   * of leaking an opaque account id as copy.
   */
  label: z.string().trim().min(1).max(512),
  /**
   * Enabled Pool members, so the chooser can say "3 accounts" without a second
   * request per row. `null` for a source that is not a Pool — which is a
   * different fact from a Pool with no members.
   */
  memberCount: z.number().int().nonnegative().nullable(),
  /** Whether this exact source can safely export recipient-owned direct material. */
  directExportSupport: z.enum(['supported', 'mixed', 'unsupported']).default('unsupported'),
  /**
   * The resource in this Team that already offers this exact source, if one
   * does. Offering the same source twice would give the Team two competing
   * policies over one credential, so the chooser shows it and does not offer it
   * again.
   */
  offeredByResourceId: z.string().min(1).nullable(),
}).strict());

export type TeamCredentialSourceCandidateV1 = z.infer<typeof TeamCredentialSourceCandidateV1Schema>;

export const TeamCredentialSourceCandidateListInputV1Schema = lazyZodSchema(() => z.object({
  teamId: z.string().min(1),
}).strict());

export type TeamCredentialSourceCandidateListInputV1 = z.infer<
  typeof TeamCredentialSourceCandidateListInputV1Schema
>;

/**
 * Every source this Account may offer to this Team.
 *
 * `supportedKinds` is the honest statement of which source families this Home
 * can actually pin today. A client renders a family's absence as "this Home
 * cannot offer these yet" rather than as "you own none", which are different
 * answers and imply different next actions.
 */
export const TeamCredentialSourceCandidateListOutputV1Schema = lazyZodSchema(() => z.object({
  candidates: z.array(TeamCredentialSourceCandidateV1Schema),
  supportedKinds: z.array(z.enum(['connected_account', 'connected_pool', 'provider_connection'])),
  brokerPresentation: TeamCredentialBrokerPresentationV1Schema.default({
    selectedTarget: null,
    eligibleTargets: [],
    selectedPool: null,
    eligiblePools: [],
  }),
}).strict());

export type TeamCredentialSourceCandidateListOutputV1 = z.infer<
  typeof TeamCredentialSourceCandidateListOutputV1Schema
>;

/**
 * The candidate's identity within one answer.
 *
 * Derived from the pinned binding rather than from the display label: two Pools
 * may share a name, and a recreated Pool keeps its logical id while becoming a
 * different lifetime. Both must stay separately selectable.
 */
export function teamCredentialSourceCandidateIdV1(
  source: TeamCredentialSourceCandidateV1['source'],
): string {
  switch (source.kind) {
    case 'connected_account':
      return JSON.stringify([
        'connected_account',
        source.target.account.service.pluginId,
        source.target.account.service.localId,
        source.target.account.accountId,
        source.credentialIncarnation,
      ]);
    case 'connected_pool':
      return JSON.stringify([
        'connected_pool',
        source.target.service.pluginId,
        source.target.service.localId,
        source.target.groupId,
        source.poolIncarnation,
      ]);
    case 'provider_connection':
      return JSON.stringify([
        'provider_connection',
        source.connectionId,
        source.credentialSlotId,
        source.connectionSecurityFingerprint,
      ]);
  }
}
