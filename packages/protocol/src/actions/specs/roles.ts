import { ROLE_ACTION_IDS_V1, type RoleActionIdV1 } from '../../prompts/roles/roleActionIdsV1.js';
import { RoleActionTargetInputSchemasV1, RoleActionOutputSchemasV1, isAccountRoleMutationV1 } from '../../prompts/roles/roleActionsV1.js';
import { type ActionInputFieldHint } from '../actionInputHints.js';
import type { PreNormalizedActionSpec } from './definition.js';


export const ROLE_ACTION_SPECS = Object.freeze([
  ...(ROLE_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
    const accountMutation = isAccountRoleMutationV1(id);
    const read = id === 'roles.list' || id === 'roles.get';
    const reports = id === 'session.roles.apply_to_reports';
    const fields: ActionInputFieldHint[] = [];
    if (id.startsWith('session.')) {
      fields.push({ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true });
    }
    if (id !== 'roles.list' && id !== 'session.notes.set' && !reports) {
      fields.push({ path: 'roleId', title: 'Role id', widget: 'text', required: id !== 'roles.create' && id !== 'session.role.set' });
    }
    if (id === 'session.role.set') {
      fields.push({ path: 'answersWorkerQuestions', title: 'Answers its workers’ questions', widget: 'boolean' });
    }
    if (id === 'session.roles.add' || id === 'roles.create' || id === 'roles.update') {
      fields.push({ path: 'role', title: 'Role', widget: 'json', required: true });
    }
    if (id === 'roles.update' || id === 'roles.delete') {
      fields.push({ path: 'expectedRevision', title: 'Expected role revision', widget: 'json', required: true });
    }
    if (id === 'session.roles.override.set' || id === 'roles.override.set') {
      fields.push(
        { path: 'engine', title: 'Engine', widget: 'json' },
        { path: 'runsAs', title: 'Runs as', widget: 'json' },
        { path: 'profileId', title: 'Launch profile id', widget: 'text' },
        { path: 'workspaceWrites', title: 'Workspace writes', widget: 'select', options: [
          { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' },
        ] },
        { path: 'secondOpinion', title: 'Second opinion', widget: 'select', options: [
          { value: 'off', label: 'Off' }, { value: 'encouraged', label: 'Encouraged' },
        ] },
      );
      if (id === 'roles.override.set') {
        fields.push({ path: 'instructionsOverride', title: 'Instructions override', widget: 'textarea' });
      }
    }
    if (id === 'session.notes.set') {
      fields.push({ path: 'notes', title: 'Orchestration notes', widget: 'textarea', required: true });
    }
    const voiceArgsExamples: Partial<Record<RoleActionIdV1, string>> = {
      'session.role.set': '{"sessionId":"{{sessionId}}","roleId":"orchestrator"}',
      'session.roles.override.set': '{"sessionId":"{{sessionId}}","roleId":"orchestrator","workspaceWrites":"deny"}',
      'session.roles.override.clear': '{"sessionId":"{{sessionId}}","roleId":"orchestrator"}',
      'session.roles.add': '{"sessionId":"{{sessionId}}","roleId":"scout_notes","role":{"name":"Scout notes","instructions":"Read the workspace and report findings.","runsAs":{"kind":"session"},"workspaceWrites":"deny","secondOpinion":"off","enabled":true}}',
      'session.roles.remove': '{"sessionId":"{{sessionId}}","roleId":"scout_notes"}',
      'session.notes.set': '{"sessionId":"{{sessionId}}","notes":"Verify changes before reporting."}',
      'roles.list': '{}',
      'roles.get': '{"roleId":"orchestrator"}',
    };
    const voiceArgsExample = voiceArgsExamples[id];
    // What a person reads in Settings, approvals and the form; agents read the schema.
    const copy = ({
      'session.role.set': ['Set Session role', 'Choose a session’s role or whether it answers its workers’ questions. Supply at least one choice; omitted choices stay unchanged.'],
      'session.roles.override.set': ['Change a role for one Session', 'Change how a role runs for one session and the sessions under it, leaving your settings as they are.'],
      'session.roles.override.clear': ['Use default role in a Session', 'Remove a session\'s change to a role, so the role runs as set in your settings again.'],
      'session.roles.add': ['Add a role to one Session', 'Give one session a role of its own that the sessions under it can use.'],
      'session.roles.remove': ['Remove a role from one Session', 'Remove a role that was added for one session only.'],
      'session.notes.set': ['Set Session notes', 'Write the notes a lead session keeps for the work it hands out.'],
      'session.roles.apply_to_reports': ['Apply roles to sessions under it', 'Give the sessions under a lead session the roles the lead uses now.'],
      'roles.list': ['List roles', 'See your roles: the built-in ones, the ones you made and the ones shared with you.'],
      'roles.get': ['Read role', 'See one role: its instructions, the agent it runs on and how it runs.'],
      'roles.create': ['Create role', 'Add a role of your own with its instructions and how it runs.'],
      'roles.update': ['Update role', 'Change one of your roles.'],
      'roles.delete': ['Delete role', 'Remove one of your roles. Work that already started with it keeps going.'],
      'roles.override.set': ['Change role settings', 'Adjust a role, such as its agent or instructions, for all your work.'],
      'roles.override.reset': ['Reset role settings', 'Remove your changes to a role and use its original settings.'],
    } as const satisfies Record<RoleActionIdV1, readonly [title: string, summary: string]>)[id];
    return {
      id, executionPlacement: id.startsWith('session.') ? 'session' : 'account',
      approval: { result: 'required' }, title: copy[0], safety: accountMutation ? 'danger' : 'safe',
      ...(id === 'roles.delete' || id === 'roles.override.reset' ? { irreversible: true as const } : {}),
      ...(id.startsWith('session.') ? { sessionTarget: { field: 'sessionId', cardinality: 'one' as const } } : {}),
      ...(['roles.create', 'roles.update', 'roles.override.set'].includes(id)
        ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
      placements: [],
      bindings: { mcpToolName: id.replaceAll('.', '_'), rpcMethod: id,
        ...(!accountMutation && !reports ? { voiceClientToolName: id.replaceAll('.', '_') } : {}) },
      surfaces: { ui: true, cli: true, agent: true, mcp: true,
        voice: !accountMutation && !reports, rpc: true },
      sideEffectClass: read ? 'read' : 'write',
      ...(voiceArgsExample ? { examples: { voice: { argsExample: voiceArgsExample } } } : {}),
      inputSchema: RoleActionTargetInputSchemasV1[id],
      outputSchema: RoleActionOutputSchemasV1[id],
      inputHints: { title: copy[0], description: copy[1], fields },
      cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
    };
  }) satisfies readonly PreNormalizedActionSpec[]),
] as const);

