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

function profileSpec<TId extends ProfileActionIdV1>(id: TId, title: string, summary: string, options: Readonly<{
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
    inputHints: { description: summary, fields: [] },
    ...(!client ? { cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' as const }] } } : {}),
  } satisfies ProfileActionSpec<TId>;
}

export const PROFILE_ACTION_SPECS_V1 = [
  profileSpec('launch_profiles.read', 'Read launch profile',
    'See one launch profile and what it sets for the sessions it starts.', { read: true }),
  profileSpec('launch_profiles.search', 'Search launch profiles',
    'Find launch profiles by name.', { read: true }),
  profileSpec('launch_profiles.select', 'Select launch profile',
    'Choose the launch profile new sessions start with.', {}),
  profileSpec('launch_profiles.create', 'Create launch profile',
    'Add a launch profile: a saved setup of agent, environment and permissions for starting sessions.', {}),
  profileSpec('launch_profiles.edit', 'Open launch profile editor',
    'Open a launch profile in its editor.', { placement: 'client' }),
  profileSpec('launch_profiles.save', 'Save launch profile',
    'Save changes to a launch profile.', {}),
  profileSpec('launch_profiles.duplicate', 'Duplicate launch profile',
    'Make a copy of a launch profile to adjust.', {}),
  profileSpec('launch_profiles.enabled.set', 'Turn launch profile on or off',
    'Show or hide a launch profile where sessions are started, without deleting it.', {}),
  profileSpec('launch_profiles.favorite.set', 'Favorite launch profile',
    'Keep a launch profile at the top of the list, or stop doing so.', {}),
  profileSpec('launch_profiles.delete', 'Delete launch profile',
    'Remove a launch profile. Sessions already started with it keep running.', { danger: true }),
  profileSpec('launch_profiles.prompt_stack.update', 'Update launch profile context',
    'Change the instructions and context a launch profile gives its sessions.', {}),
  profileSpec('launch_profiles.secrets.select', 'Select launch profile secret',
    'Choose which saved secret a launch profile uses for one of its values.', { danger: true }),
  profileSpec('launch_profiles.legacy.preview', 'Preview profile from an earlier version',
    'See what a profile from an earlier version of Happier would become as a launch profile, without changing anything.', { read: true, placement: 'machine' }),
  profileSpec('launch_profiles.legacy.convert', 'Convert profile from an earlier version',
    'Turn a profile from an earlier version of Happier into a launch profile.', { danger: true, placement: 'machine' }),
  profileSpec('launch_profiles.legacy.resolve_conflict', 'Resolve profile conversion conflict',
    'Choose what to keep when a converted profile clashes with a launch profile you already have.', { danger: true, placement: 'machine' }),
  profileSpec('launch_profiles.draft.discard', 'Discard launch profile draft',
    'Throw away unsaved changes to a launch profile.', { placement: 'client' }),
] as const satisfies readonly PreNormalizedActionSpec[];
