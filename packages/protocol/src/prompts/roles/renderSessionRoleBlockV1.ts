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
    if (!voice && role.canDelegateToOtherRoles === true) {
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
  if (!voice && context.originKind !== 'run_step') lines.push('Post progress, results, blockers, or failure through session.update.post. This persists an update on your current session even when no manager is attached; follow policy determines delivery to observers.');
  if (!voice) lines.push(
    'Use session.message.send for information or an ask: reply none creates no answer obligation; wait observes one exact answer inline; return retains a later answer to the admitted source Session. A wait timeout ends observation, not accepted work. Returned answers are information and need no acknowledgment.',
    'Discover the current Action schema before using these examples; replace the sample message and exact request identity with the real values:',
    'session.message.send {"sessionId":"manager","message":"The API contract is ready.","reply":"none"}',
    'session.message.send {"sessionId":"manager","message":"Which API contract should I use?","reply":"wait"}',
    'session.message.send {"sessionId":"manager","message":"Review the API contract and get back to me.","reply":"return"}',
    'For an admitted request, use its reply_session_id and request_local_id from host context. An explicit answer or typed pass fulfills that exact obligation; the turn final is the fallback, so do not send a second answer. Pass when you have nothing to add; silence and timeout are not passes.',
    'session.message.reply {"sessionId":"self","requestLocalId":"original-input-id","reply":{"kind":"answer","message":"Use the versioned API contract."}}',
    'session.message.reply {"sessionId":"self","requestLocalId":"original-input-id","reply":{"kind":"pass"}}',
    'Preview a group through session.targets.resolve with the intended actionId. A matching selector uses the shared Session list filter; incomplete coverage is unavailable, not permission to act on a subset. In the composer, Matching → Use these keeps the filter; the operation resolves current targets before approval, then retains the reviewed exact list. Selectors address Sessions, never people, and grant no access.',
    'session.targets.resolve {"target":{"selector":"workers"},"actionId":"session.message.send"}',
    'Autonomous conversation check-in is separate from structural work depth. Continue changes the exchange allowance, not spawn authority; returned answers add no autonomous-start count.',
  );
  if (context.worker) {
    const publishAction = context.originKind === 'run_step' ? 'session.worker.publish_draft' : 'session.update.post';
    if (!voice) lines.push(`lead_session_id=${data(context.worker.leadSessionId)}`);
    lines.push(`Task boundary: ${escape(context.worker.taskBoundary)}`);
    if (!voice) lines.push(`Publish through ${publishAction} when finished, when a blocker needs the lead, or on failure. Report success or failure explicitly with outcome and evidence, then go idle; do not poll the lead.`,
      'Send lead-owned decisions to the lead and human decisions to the user. A direct user message is user-owned work.');
    lines.push("Never approve your own request; approval decisions follow the Action's policy.");
  }
  lines.push('</happier_role>');
  return lines.join('\n');
}
