import type { ResolvedRoleV1 } from './rolesV1.js';

export type SessionRolePromptContextV1 = Readonly<{
  modality?: 'coding' | 'voice';
  role?: ResolvedRoleV1;
  source?: 'dispatch' | 'workflow_step';
  originKind?: string;
  availableRoles?: readonly ResolvedRoleV1[];
  notes?: string;
  worker?: Readonly<{ leadSessionId: string; taskBoundary: string }>;
}>;

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function data(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

/** Descriptive host context, never admission or permission authority. FIN uses
 * this same renderer for its initial step input rather than dispatch injection. */
export function renderSessionRoleBlockV1(context: SessionRolePromptContextV1): string {
  if (context.originKind === 'run_step' && context.source !== 'workflow_step') return '';
  if (!context.role && !context.worker && !context.notes) return '';
  const role = context.role;
  const voice = context.modality === 'voice';
  const lines = ['<happier_role v="1">'];
  if (role) {
    if (!voice) lines.push(`role_id=${data(role.roleId)}`);
    lines.push(`name=${data(role.name)}`, escape(role.instructions));
    if (role.secondOpinion === 'encouraged') lines.push(voice
      ? 'Consider a second opinion when useful.'
      : 'Consider a second opinion (Second opinion role) before a PR or before declaring done.');
    if (role.workspaceWrites === 'deny') lines.push('Hands-off: do not change the workspace. Coordination and reads remain available.');
    if (!voice && role.profileUnavailable) lines.push(`Profile ${data(role.profileId)} is unavailable here; choose an available profile rather than assuming it was applied.`);
    if (!voice && role.roleId === 'orchestrator') {
      lines.push('Available roles (discover the Action schema before supplying its other required input fields):');
      for (const candidate of context.availableRoles ?? []) {
        if (!candidate.enabled) continue;
        const actionId = candidate.runsAs.kind === 'session' ? 'session.spawn_new' : 'execution.run.start';
        lines.push(`${actionId} ${data({ roleId: candidate.roleId })} — ${escape(candidate.name)}`);
      }
    }
    if (!voice) lines.push('Use the current Agent\'s native subagent facility by default for generic delegation. Use Happier-managed work only when explicitly requested or when the requested Agent, model, account, or service cannot be served by native subagents. Do not silently substitute execution topology after a native failure.',
      'Discover Actions through action.spec.search and action.spec.get before invoking them. Omit sessionId for current-session work. Use event-driven waits; a wait timeout does not imply the work stopped.');
  }
  if (context.notes) lines.push(`Orchestration notes: ${escape(context.notes)}`);
  if (context.worker) {
    const publishAction = context.originKind === 'run_step' ? 'session.worker.publish_draft' : 'session.worker.publish';
    if (!voice) lines.push(`lead_session_id=${data(context.worker.leadSessionId)}`);
    lines.push(`Task boundary: ${escape(context.worker.taskBoundary)}`);
    if (!voice) lines.push(`Publish through ${publishAction} when finished, when a blocker needs the lead, or on failure. Report success or failure explicitly with outcome and evidence, then go idle; do not poll the lead.`,
      'Send lead-owned decisions to the lead and human decisions to the user. A direct user message is user-owned work.',
      'You cannot approve permissions for yourself or other sessions. Human approvals must go to the user.');
    if (voice) lines.push('Human decisions and permission approvals must go to the user.');
  }
  lines.push('</happier_role>');
  return lines.join('\n');
}
