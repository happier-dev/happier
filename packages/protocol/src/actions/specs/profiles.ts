import {
  PROFILE_ACTION_INPUT_SCHEMAS_V1 as inputs, PROFILE_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  type ProfileActionIdV1,
} from '../../profiles/profileActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { readRecord } from '../../inputs/inputRecords.js';

/** Shared observations expose outcome/identity, never private definitions or credential mappings. */
function projectProfileObservation(input: unknown): unknown {
  const value = readRecord(input);
  const profile = readRecord(value.profile);
  return {
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(typeof value.id === 'string' || value.id === null ? { id: value.id }
      : typeof profile.id === 'string' ? { id: profile.id } : {}),
    ...(typeof value.revision === 'number' ? { revision: value.revision } : {}),
    ...(typeof value.complete === 'boolean' ? { complete: value.complete } : {}),
  };
}

type ProfileActionSpec<TId extends ProfileActionIdV1> = PreNormalizedActionSpec & Readonly<{
  id: TId;
  inputSchema: (typeof inputs)[TId];
  outputSchema: (typeof outputs)[TId];
}>;

function profileSpec<TId extends ProfileActionIdV1>(id: TId, title: string, options: Readonly<{
  danger?: boolean; read?: boolean; placement?: 'account' | 'machine' | 'client';
}>): ProfileActionSpec<TId> {
  const client = options.placement === 'client';
  return {
    id, title, safety: options.danger ? 'danger' as const : 'safe' as const,
    sideEffectClass: options.read ? 'read' as const : 'write' as const,
    requiredAuthority: 'account_automation' as const,
    executionPlacement: options.placement ?? 'account', placements: [],
    surfaces: { ui: true, cli: !client, agent: true, mcp: !client, voice: false, rpc: !client },
    ...(!client ? { bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') } } : {}),
    inputSchema: inputs[id], outputSchema: outputs[id],
    projectObservationInput: projectProfileObservation, projectObservationOutput: projectProfileObservation,
    inputHints: { fields: [] },
    ...(!client ? { cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' as const }] } } : {}),
  } satisfies ProfileActionSpec<TId>;
}

export const PROFILE_ACTION_SPECS_V1 = [
  profileSpec('launch_profiles.read', 'Read launch profile', { read: true }),
  profileSpec('launch_profiles.search', 'Search launch profiles', { read: true }),
  profileSpec('launch_profiles.select', 'Select launch profile', {}),
  profileSpec('launch_profiles.create', 'Create launch profile', {}),
  profileSpec('launch_profiles.edit', 'Open launch profile editor', { placement: 'client' }),
  profileSpec('launch_profiles.save', 'Save launch profile', {}),
  profileSpec('launch_profiles.duplicate', 'Duplicate launch profile', {}),
  profileSpec('launch_profiles.enabled.set', 'Set launch profile enablement', {}),
  profileSpec('launch_profiles.favorite.set', 'Set launch profile favorite', {}),
  profileSpec('launch_profiles.delete', 'Delete launch profile', { danger: true }),
  profileSpec('launch_profiles.prompt_stack.update', 'Update launch profile context', {}),
  profileSpec('launch_profiles.secrets.select', 'Select launch profile secret', { danger: true }),
  profileSpec('launch_profiles.legacy.preview', 'Preview legacy profile conversion', { read: true, placement: 'machine' }),
  profileSpec('launch_profiles.legacy.convert', 'Convert legacy profile', { danger: true, placement: 'machine' }),
  profileSpec('launch_profiles.legacy.resolve_conflict', 'Resolve legacy profile conversion conflict', { danger: true, placement: 'machine' }),
  profileSpec('launch_profiles.draft.discard', 'Discard launch profile draft', { placement: 'client' }),
] as const satisfies readonly PreNormalizedActionSpec[];
