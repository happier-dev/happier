import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RemoteHostRecordV1Schema, type RemoteHostRecordV1 } from './remoteHostSchemasV1.js';
import { SharedSavedSecretCreateInputV1Schema, SavedSecretCatalogReferenceCensusV1Schema } from '../account/settings/savedSecretResourceActionsV1.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { RelayAccessConfigV1Schema } from '../system/tasks/relayAccessConfigV1.js';

import type { RemoteHostActionIdV1 } from './remoteHostActionIdsV1.js';
export { REMOTE_HOST_ACTION_IDS_V1, isRemoteHostActionIdV1, type RemoteHostActionIdV1 } from './remoteHostActionIdsV1.js';

const Id = lazyZodSchema(() => z.string().trim().min(1));
const Revision = lazyZodSchema(() => z.number().int().nonnegative());
const ExpectedRevision = lazyZodSchema(() => z.union([Revision, z.literal('absent')]));
const Empty = lazyZodSchema(() => z.object({}).strict());
const Address = lazyZodSchema(() => z.object({ hostId: Id, expectedRevision: ExpectedRevision }).strict());
const ResourceRevision = lazyZodSchema(() => z.object({ resourceId: Id, revision: Revision }).strict());
const TrustedKey = lazyZodSchema(() => z.object({ host: Id, port: z.number().int().min(1).max(65535),
  algorithm: Id, fingerprintSha256: Id }).strict());

export const RemoteHostSaveActionInputV1Schema = lazyZodSchema(() => z.object({
  host: RemoteHostRecordV1Schema,
  expectedRevision: ExpectedRevision,
  referencedSavedSecretRevisions: z.array(ResourceRevision).optional(),
  savedSecretResources: z.array(SharedSavedSecretCreateInputV1Schema).optional(),
  referenceCensus: SavedSecretCatalogReferenceCensusV1Schema.optional(),
}).strict());
export const RemoteHostCredentialSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent') }).strict(),
  z.object({ kind: z.literal('keyfile') }).strict(),
  z.object({ kind: z.literal('password'), resourceId: Id, expectedResourceRevision: Revision }).strict(),
  z.object({ kind: z.literal('private_key'), resourceId: Id, expectedResourceRevision: Revision }).strict(),
]));

export const REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1 = {
  'remote_hosts.list': Empty,
  'remote_hosts.read': lazyZodSchema(() => z.object({ hostId: Id }).strict()),
  'remote_hosts.add': Empty,
  'remote_hosts.edit': Address,
  'remote_hosts.save': RemoteHostSaveActionInputV1Schema,
  'remote_hosts.duplicate': lazyZodSchema(() => Address.extend({ newHostId: Id, name: Id }).strict()),
  'remote_hosts.delete': Address,
  'remote_hosts.connect': Address,
  'remote_hosts.setup_as_machine': Address,
  'remote_hosts.relay.use': Address,
  'remote_hosts.relay.configure': lazyZodSchema(() => Address.extend({
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('configure'), config: RelayAccessConfigV1Schema }).strict(),
      z.object({ kind: z.literal('disable') }).strict(),
    ]),
  }).strict()),
  'remote_hosts.relay.test': Address,
  'remote_hosts.cli.install_or_update': Address,
  'remote_hosts.daemon.install_or_update': Address,
  'remote_hosts.daemon.start': Address,
  'remote_hosts.daemon.stop': Address,
  'remote_hosts.daemon.restart': Address,
  'remote_hosts.relay.status': Address,
  'remote_hosts.relay.access.status': Address,
  'remote_hosts.relay.install_or_update': Address,
  'remote_hosts.relay.start': Address,
  'remote_hosts.relay.stop': Address,
  'remote_hosts.relay.restart': Address,
  'remote_hosts.credential.change': lazyZodSchema(() => Address.extend({ credential: RemoteHostCredentialSelectionV1Schema }).strict()),
  'remote_hosts.personal_home.erase': Address,
  'remote_hosts.trusted_keys.list': Empty,
  'remote_hosts.trusted_keys.remove': lazyZodSchema(() => z.object({ key: TrustedKey }).strict()),
  'remote_hosts.trusted_keys.clear': lazyZodSchema(() => z.object({ keys: z.array(TrustedKey) }).strict()),
  'remote_hosts.tunnel.stop': lazyZodSchema(() => z.object({ target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('native'), leaseId: Id }).strict(),
    z.object({ kind: z.literal('desktop'), tunnelKey: Id }).strict(),
  ]) }).strict()),
} as const;
const Refusal = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('unavailable'), reason: Id }).strict(),
  z.object({ status: z.literal('outcome_unknown') }).strict(),
]));
const MutationResult = lazyZodSchema(() => z.union([Refusal,
  z.object({ status: z.literal('updated'), hostId: Id, revision: Revision }).strict(),
]));
const OpenedResult = lazyZodSchema(() => z.union([Refusal,
  z.object({ status: z.literal('opened'), route: Id, hostId: Id.optional() }).strict(),
]));
const TaskResult = lazyZodSchema(() => z.union([Refusal,
  z.object({ status: z.literal('task_started'), taskId: Id }).strict(),
  z.object({ status: z.literal('connected') }).strict(),
]));
export const REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1 = {
  'remote_hosts.list': lazyZodSchema(() => z.union([Refusal, z.object({ status: z.literal('listed'), hosts: z.array(RemoteHostRecordV1Schema), revision: ExpectedRevision, complete: z.boolean() }).strict()])),
  'remote_hosts.read': lazyZodSchema(() => z.union([Refusal, z.object({ status: z.literal('present'), host: RemoteHostRecordV1Schema, revision: ExpectedRevision }).strict()])),
  'remote_hosts.add': OpenedResult,
  'remote_hosts.edit': OpenedResult,
  'remote_hosts.save': MutationResult,
  'remote_hosts.duplicate': MutationResult,
  'remote_hosts.delete': MutationResult,
  'remote_hosts.connect': TaskResult,
  'remote_hosts.setup_as_machine': TaskResult,
  'remote_hosts.relay.use': OpenedResult,
  'remote_hosts.relay.configure': TaskResult,
  'remote_hosts.relay.test': TaskResult,
  'remote_hosts.cli.install_or_update': TaskResult,
  'remote_hosts.daemon.install_or_update': TaskResult,
  'remote_hosts.daemon.start': TaskResult,
  'remote_hosts.daemon.stop': TaskResult,
  'remote_hosts.daemon.restart': TaskResult,
  'remote_hosts.relay.status': TaskResult,
  'remote_hosts.relay.access.status': TaskResult,
  'remote_hosts.relay.install_or_update': TaskResult,
  'remote_hosts.relay.start': TaskResult,
  'remote_hosts.relay.stop': TaskResult,
  'remote_hosts.relay.restart': TaskResult,
  'remote_hosts.credential.change': MutationResult,
  'remote_hosts.personal_home.erase': TaskResult,
  'remote_hosts.trusted_keys.list': lazyZodSchema(() => z.union([Refusal,
    z.object({ status: z.literal('listed'), keys: z.array(TrustedKey) }).strict()])),
  'remote_hosts.trusted_keys.remove': lazyZodSchema(() => z.union([Refusal, z.object({ status: z.literal('removed') }).strict()])),
  'remote_hosts.trusted_keys.clear': lazyZodSchema(() => z.union([Refusal, z.object({ status: z.literal('removed') }).strict()])),
  'remote_hosts.tunnel.stop': lazyZodSchema(() => z.union([Refusal,
    z.object({ status: z.literal('task_started'), taskId: Id }).strict(), z.object({ status: z.literal('released') }).strict()])),
} as const;
export type RemoteHostActionInputByIdV1 = {
  readonly [Id in RemoteHostActionIdV1]: z.output<(typeof REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1)[Id]>;
};
export type RemoteHostActionRequestV1 = {
  [Id in RemoteHostActionIdV1]: Readonly<{ actionId: Id; input: RemoteHostActionInputByIdV1[Id] }>;
}[RemoteHostActionIdV1];

export function duplicateRemoteHostForActionV1(host: RemoteHostRecordV1, input: Readonly<{
  newHostId: string; name: string; now: number;
}>): RemoteHostRecordV1 {
  return { ...host, id: input.newHostId, name: input.name, createdAt: input.now, updatedAt: input.now,
    lastUsedAt: null, linkedMachineId: null, linkedRelayProfileId: null };
}

export function changeRemoteHostCredentialForActionV1(host: RemoteHostRecordV1,
  credential: z.output<typeof RemoteHostCredentialSelectionV1Schema>, now: number): RemoteHostRecordV1 {
  return { ...host, updatedAt: now, ssh: { ...host.ssh,
    authMode: credential.kind === 'private_key' ? 'keyfile' : credential.kind,
    passwordSecretRef: credential.kind === 'password' ? formatSharedSavedSecretRefV1(credential.resourceId) : null,
    identityPrivateKeySecretRef: credential.kind === 'private_key' ? formatSharedSavedSecretRefV1(credential.resourceId) : null,
  } };
}
export function parseRemoteHostActionRequestV1(actionId: RemoteHostActionIdV1, input: unknown): RemoteHostActionRequestV1 {
  switch (actionId) {
    case 'remote_hosts.trusted_keys.list': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.trusted_keys.remove': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.trusted_keys.clear': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.tunnel.stop': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.list': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.read': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.add': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.edit': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.save': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.duplicate': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.delete': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.connect': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.setup_as_machine': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.relay.use': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.relay.configure': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.relay.test': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.cli.install_or_update': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.daemon.install_or_update': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.daemon.start': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.daemon.stop': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.daemon.restart': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.relay.status': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.relay.access.status': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.relay.install_or_update': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.relay.start': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.relay.stop': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.relay.restart': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.credential.change': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'remote_hosts.personal_home.erase': return { actionId, input: REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
  }
}
