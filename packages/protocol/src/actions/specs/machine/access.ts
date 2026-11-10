import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { MACHINE_ACCESS_ACTION_IDS, MACHINE_ACCESS_HTTP_ACTION_IDS } from './accessActionIdsV1.js';
export { MACHINE_ACCESS_ACTION_IDS, MACHINE_WORK_SUMMARY_ACTION_IDS } from './accessActionIdsV1.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import {
  MachineAccessGrantsListInputV1Schema, MachineAccessGrantsListResultV1Schema,
  MachineAccessGrantSetInputV1Schema, MachineAccessGrantRemoveInputV1Schema,
  MachineAccessLeaveInputV1Schema, MachineAccessPrepareKeysInputV1Schema,
  MachineAccessMutationResultV1Schema, MachineKeyPreparationResultV1Schema,
  MachineAccessGrantsListResponseV1Schema,
} from '../../../machines/machineAccessV1.js';
import type { PreNormalizedActionSpec } from '../../actionSpecs.js';
import { actionInputServerId } from '../definition.js';
import { MachineWorkSummaryGetInputV1Schema, MachineWorkSummaryGetResultV1Schema } from '../../../machines/machineWorkSummaryV1.js';
import { asProtocolZod } from '../../../plugins/actions/internalProtocolZodAdapter.js';
import { RPC_METHODS } from '../../../rpc/methods.js';
import { presentMachineAuthorityV1 } from '../../../machines/machineAuthorityV1.js';
export type MachineAccessActionId = typeof MACHINE_ACCESS_ACTION_IDS[number];
export const MachineAccessActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_ACCESS_ACTION_IDS));
export type MachineAccessHttpActionId = typeof MACHINE_ACCESS_HTTP_ACTION_IDS[number];
export const MachineAccessHttpActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_ACCESS_HTTP_ACTION_IDS));

export function machineAccessTrustedOsDisclosure(machineId: string): string {
  return `The owner of ${machineId} can inspect keys and selected credential material delivered there, including after members have separate operating-system users. Until member separation is observed effective, members and the owner's isolated Agent share an Agent user and can copy selected credentials, Direct-delivered keys and readable Session context. Enabled or pending setup is not proof of separation. Can manage includes trusted administration that can defeat isolation. Use a dedicated team machine and trust its administrators.`;
}

export function machineAccessApprovalDisclosure(actionId: string, input: unknown) {
  if (actionId !== 'machines.access.grant.set' && actionId !== 'machines.access.prepareKeys') return null;
  const parsed = MachineAccessPrepareKeysInputV1Schema.safeParse(
    input && typeof input === 'object' ? { serverId: Reflect.get(input, 'serverId'), machineId: Reflect.get(input, 'machineId') } : input,
  );
  if (!parsed.success) return null;
  const visibility = presentMachineAuthorityV1({ sharedMachine: true }).deliveredMaterial;
  return {
    machineId: parsed.data.machineId, ownerCanInspectDeliveredMaterial: visibility.ownerVisible,
    sharedAgentUidExposesSelectedMaterial: visibility.sharedUserPeerVisible,
    isolationRequiresObservedReadiness: true, trustedAdministrationCanDefeatIsolation: true,
    dedicatedMachineRecommended: true,
    description: machineAccessTrustedOsDisclosure(parsed.data.machineId),
  } as const;
}

/** Only a committed grant reduction avoids new exposure; missing facts keep confirmation. */
export function machineAccessGrantSetRequiresUiConfirmation(input: unknown, committedAccess?: unknown): boolean {
  const change = MachineAccessGrantSetInputV1Schema.safeParse(input);
  const current = MachineAccessGrantsListResponseV1Schema.safeParse(committedAccess);
  return !(change.success && current.success && current.data.canManage
    && current.data.machineId === change.data.machineId && change.data.level === 'view'
    && current.data.grants.some(grant => grant.level === 'admin'
      // Both principals were parsed by the same strict schema, including its key order.
      && JSON.stringify(grant.principal) === JSON.stringify(change.data.principal)));
}

const targetFields = [
  { path: 'serverId', title: 'Home ID', widget: 'text', required: true },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
] as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false } as const;
const accessPath = '/v1/machines/:machineId/access';
const disclosure = machineAccessTrustedOsDisclosure('this machine');

function createMachineAccessActionSpecs() {
  return [
  {
    id: 'machines.work.summary.get', approval: {result: 'required'}, title: 'Read machine work summary',
    originalExecution: { requesterCredentials: 'none' },
    description: 'Read current requester identities and numeric work counts as the custodian or someone with current Manage access. No work titles, identifiers, paths or content are returned.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_work_summary_get', voiceClientToolName: 'getMachineWorkSummary', rpcMethod: RPC_METHODS.MACHINES_WORK_SUMMARY_GET },
    inputSchema: MachineWorkSummaryGetInputV1Schema, outputSchema: asProtocolZod(MachineWorkSummaryGetResultV1Schema),
    invocationServerIdForInput: actionInputServerId(MachineWorkSummaryGetInputV1Schema, input => input.serverId),
    inputHints: { fields: targetFields },
  },
  {
    id: 'machines.access.grants.list', approval: {result: 'required'}, title: 'Read machine sharing',
    description: 'Read the current audience as a manager, or your own effective access and readiness as a recipient. No key envelopes or other people’s work are returned.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_access_grants_list', voiceClientToolName: 'listMachineAccessGrants' },
    serverTransport: { method: 'GET', path: accessPath },
    inputSchema: MachineAccessGrantsListInputV1Schema, outputSchema: MachineAccessGrantsListResultV1Schema,
    inputHints: { fields: targetFields },
  },
  {
    id: 'machines.access.grant.set', approvalPolicy: { uiConfirmation: 'direct', uiConfirmationForInput: machineAccessGrantSetRequiresUiConfirmation }, approval: {result: 'required'}, title: 'Share a machine',
    description: `Save or change a current person, Team or group grant. Can manage includes sharing and owner-equivalent machine administration. ${disclosure}`,
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_access_grant_set', voiceClientToolName: 'setMachineAccessGrant' },
    serverTransport: { method: 'PUT', path: accessPath },
    inputSchema: MachineAccessGrantSetInputV1Schema, outputSchema: MachineAccessMutationResultV1Schema,
    inputHints: { fields: [...targetFields, { path: 'principal', title: 'Person, Team or group', widget: 'json', required: true },
      { path: 'level', title: 'Access', widget: 'select', required: true, options: [{ value: 'view', label: 'Can use' }, { value: 'admin', label: 'Can manage' }] }] },
  },
  {
    id: 'machines.access.grant.remove', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'required'}, title: 'Remove machine access',
    description: 'Remove or cancel this exact audience grant. Running and queued work loses access only when no independent grant remains.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_access_grant_remove', voiceClientToolName: 'removeMachineAccessGrant' },
    serverTransport: { method: 'DELETE', path: accessPath },
    inputSchema: MachineAccessGrantRemoveInputV1Schema, outputSchema: MachineAccessMutationResultV1Schema,
    inputHints: { fields: [...targetFields, { path: 'principal', title: 'Person, Team or group', widget: 'json', required: true }] },
  },
  {
    id: 'machines.access.leave', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'required'}, title: 'Leave a machine share',
    description: 'Remove your own direct Machine grant. Inherited Team or group access remains; this does not leave a Team.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_access_leave', voiceClientToolName: 'leaveMachineShare' },
    serverTransport: { method: 'DELETE', path: accessPath },
    inputSchema: MachineAccessLeaveInputV1Schema, outputSchema: MachineAccessMutationResultV1Schema,
    inputHints: { fields: targetFields },
  },
  {
    id: 'machines.access.prepareKeys', approvalPolicy: { uiConfirmation: 'policy' }, approval: {result: 'required'}, title: 'Prepare secure machine access',
    confirmVerb: { key: 'common.retry', fallback: 'Retry' },
    description: `Retry current recipient-key delivery using an authorized key holder. No raw keys are accepted or returned. ${disclosure}`,
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_access_prepare_keys', voiceClientToolName: 'prepareMachineAccessKeys' },
    inputSchema: MachineAccessPrepareKeysInputV1Schema, outputSchema: MachineKeyPreparationResultV1Schema,
    inputHints: { fields: targetFields },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const MACHINE_ACCESS_ACTION_SPECS: ReturnType<typeof createMachineAccessActionSpecs> = lazyActionSpecArray(createMachineAccessActionSpecs);
