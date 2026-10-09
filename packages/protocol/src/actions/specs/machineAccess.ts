import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import {
  MachineAccessGrantsListInputV1Schema, MachineAccessGrantsListResultV1Schema,
  MachineAccessGrantSetInputV1Schema, MachineAccessGrantRemoveInputV1Schema,
  MachineAccessLeaveInputV1Schema, MachineAccessPrepareKeysInputV1Schema,
  MachineAccessMutationResultV1Schema, MachineKeyPreparationResultV1Schema,
} from '../../machines/machineAccessV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { MachineWorkSummaryGetInputV1Schema, MachineWorkSummaryGetResultV1Schema } from '../../machines/machineWorkSummaryV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { RPC_METHODS } from '../../rpc/methods.js';

export const MACHINE_WORK_SUMMARY_ACTION_IDS = ['machines.work.summary.get'] as const;

export const MACHINE_ACCESS_ACTION_IDS = [
  'machines.access.grants.list', 'machines.access.grant.set', 'machines.access.grant.remove',
  'machines.access.leave', 'machines.access.prepareKeys',
] as const;
export type MachineAccessActionId = typeof MACHINE_ACCESS_ACTION_IDS[number];
export const MachineAccessActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_ACCESS_ACTION_IDS));

export function machineAccessTrustedOsDisclosure(machineId: string): string {
  return `People with terminal or agent access to ${machineId} run as your operating-system user and can obtain your local credentials and Account encryption key, if present. No Happier API reads or exports owner credentials or keys; anything a shared shell prints can contain them. We recommend sharing a dedicated team machine.`;
}

export function machineAccessApprovalDisclosure(actionId: string, input: unknown) {
  if (actionId !== 'machines.access.grant.set' && actionId !== 'machines.access.prepareKeys') return null;
  const parsed = MachineAccessPrepareKeysInputV1Schema.safeParse(
    input && typeof input === 'object' ? { serverId: Reflect.get(input, 'serverId'), machineId: Reflect.get(input, 'machineId') } : input,
  );
  if (!parsed.success) return null;
  return {
    machineId: parsed.data.machineId, sameOsUser: true, localCredentialsExposed: true,
    accountEncryptionKeyExposedIfPresent: true, dedicatedMachineRecommended: true,
    description: machineAccessTrustedOsDisclosure(parsed.data.machineId),
  } as const;
}

const targetFields = [
  { path: 'serverId', title: 'Home ID', widget: 'text', required: true },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
] as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false } as const;
const accessPath = '/v1/machines/:machineId/access';
const disclosure = machineAccessTrustedOsDisclosure('this machine');

export const MACHINE_ACCESS_ACTION_SPECS = [
  {
    id: 'machines.work.summary.get', title: 'Read machine work summary',
    description: 'Read current requester identities and numeric work counts as the custodian or someone with current Manage access. No work titles, identifiers, paths or content are returned.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_work_summary_get', voiceClientToolName: 'getMachineWorkSummary', rpcMethod: RPC_METHODS.MACHINES_WORK_SUMMARY_GET },
    inputSchema: MachineWorkSummaryGetInputV1Schema, outputSchema: asProtocolZod(MachineWorkSummaryGetResultV1Schema),
    inputHints: { fields: targetFields },
  },
  {
    id: 'machines.access.grants.list', title: 'Read machine sharing',
    description: 'Read the current audience as a manager, or your own effective access and readiness as a recipient. No key envelopes or other people’s work are returned.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_access_grants_list', voiceClientToolName: 'listMachineAccessGrants' },
    serverTransport: { method: 'GET', path: accessPath },
    inputSchema: MachineAccessGrantsListInputV1Schema, outputSchema: MachineAccessGrantsListResultV1Schema,
    inputHints: { fields: targetFields },
  },
  {
    id: 'machines.access.grant.set', title: 'Share a machine',
    description: `Save or change a current person, Team or group grant. Can manage includes sharing and owner-equivalent machine administration. ${disclosure}`,
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_access_grant_set', voiceClientToolName: 'setMachineAccessGrant' },
    serverTransport: { method: 'PUT', path: accessPath },
    inputSchema: MachineAccessGrantSetInputV1Schema, outputSchema: MachineAccessMutationResultV1Schema,
    inputHints: { fields: [...targetFields, { path: 'principal', title: 'Person, Team or group', widget: 'json', required: true },
      { path: 'level', title: 'Access', widget: 'select', required: true, options: [{ value: 'view', label: 'Can use' }, { value: 'admin', label: 'Can manage' }] }] },
  },
  {
    id: 'machines.access.grant.remove', title: 'Remove machine access',
    description: 'Remove or cancel this exact audience grant. Running and queued work loses access only when no independent grant remains.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_access_grant_remove', voiceClientToolName: 'removeMachineAccessGrant' },
    serverTransport: { method: 'DELETE', path: accessPath },
    inputSchema: MachineAccessGrantRemoveInputV1Schema, outputSchema: MachineAccessMutationResultV1Schema,
    inputHints: { fields: [...targetFields, { path: 'principal', title: 'Person, Team or group', widget: 'json', required: true }] },
  },
  {
    id: 'machines.access.leave', title: 'Leave a machine share',
    description: 'Remove your own direct Machine grant. Inherited Team or group access remains; this does not leave a Team.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_access_leave', voiceClientToolName: 'leaveMachineShare' },
    serverTransport: { method: 'DELETE', path: accessPath },
    inputSchema: MachineAccessLeaveInputV1Schema, outputSchema: MachineAccessMutationResultV1Schema,
    inputHints: { fields: targetFields },
  },
  {
    id: 'machines.access.prepareKeys', title: 'Prepare secure machine access',
    description: `Retry current recipient-key delivery using an authorized key holder. No raw keys are accepted or returned. ${disclosure}`,
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_access_prepare_keys', voiceClientToolName: 'prepareMachineAccessKeys' },
    inputSchema: MachineAccessPrepareKeysInputV1Schema, outputSchema: MachineKeyPreparationResultV1Schema,
    inputHints: { fields: targetFields },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
