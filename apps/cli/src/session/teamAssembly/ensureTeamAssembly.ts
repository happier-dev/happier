import {
  applyTeamAssemblyV1ToMetadata,
  planSessionRoleChangeV1,
  planTeamAssemblyV1,
  readSessionRoleAssignmentV1,
  readTeamAssemblyV1,
  resolveSessionRolePromptNameV1,
  type FreshAssignableSessionRoleV1,
  type TeamAssemblyCreationV1,
  type TeamAssemblyExistingChildV1,
  type TeamAssemblyV1,
} from '@happier-dev/protocol';

export type TeamAssemblyPlaceholderRequest = TeamAssemblyCreationV1 & Readonly<{
  /** The placeholder's role snapshot from the Lead's own account catalog. */
  sessionRoleV1: FreshAssignableSessionRoleV1;
  /** The Lead's current session permission mode, used when the template sets none. */
  leadPermissionMode: string | null;
}>;

export type EnsureTeamAssemblyOutcome = 'disabled' | 'not_lead' | 'already_assembled' | 'assembled';

/**
 * The one team-assembly executor (plan 2E), run only by the Lead's own runner on startup and on
 * role assignment. Idempotent per role assignment through `teamAssemblyV1` in the Lead's metadata;
 * UI and CLI paths only assign the role and never create sessions or write origin.
 */
export async function ensureTeamAssembly(deps: Readonly<{
  leadSessionId: string;
  readLeadMetadata: () => Record<string, unknown> | null;
  readSettings: () => Promise<unknown>;
  /** Sessions this account sees, with their origin and role, including archived ones. */
  listChildren: () => Promise<readonly TeamAssemblyExistingChildV1[]>;
  /** Creates one idle role session through the role-aware spawn owner; no first input. */
  createPlaceholder: (request: TeamAssemblyPlaceholderRequest) => Promise<Readonly<{ sessionId: string }>>;
  updateLeadMetadata: (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => Promise<void>;
  postNotice: (text: string) => Promise<void>;
  getNowMs?: () => number;
}>): Promise<EnsureTeamAssemblyOutcome> {
  const getNowMs = deps.getNowMs ?? (() => Date.now());
  const metadata = deps.readLeadMetadata();
  const assignment = readSessionRoleAssignmentV1(metadata);
  const assignmentId = assignment?.assignmentId ?? '';
  const settings = await deps.readSettings();
  const record = readTeamAssemblyV1(metadata);
  const quickPlan = planTeamAssemblyV1({
    leadSessionId: deps.leadSessionId,
    leadRole: assignment?.role ?? null,
    assignmentId: assignmentId || 'unassigned',
    settings,
    existingChildren: [],
    record,
  });
  if (quickPlan.kind !== 'assemble') return quickPlan.kind;
  if (!assignmentId) return 'not_lead';

  const plan = planTeamAssemblyV1({
    leadSessionId: deps.leadSessionId,
    leadRole: assignment!.role,
    assignmentId,
    settings,
    existingChildren: await deps.listChildren(),
    record,
  });
  if (plan.kind !== 'assemble') return plan.kind;

  const leadPermissionMode = typeof metadata?.permissionMode === 'string' ? metadata.permissionMode : null;
  const created: TeamAssemblyV1['created'] = [];
  const failed: TeamAssemblyV1['failed'] = [];
  const skipped: TeamAssemblyV1['skipped'] = [...plan.skipped];
  for (const creation of plan.creations) {
    const role = planSessionRoleChangeV1({ role: creation.role, settings, changeId: `team:${assignmentId}:${creation.role}`, at: getNowMs() });
    if (!role?.assignment) {
      skipped.push({ role: creation.role, reason: 'unsupported' });
      continue;
    }
    try {
      const placeholder = await deps.createPlaceholder({
        ...creation,
        sessionRoleV1: role.assignment as FreshAssignableSessionRoleV1,
        leadPermissionMode,
      });
      created.push({ role: creation.role, sessionId: placeholder.sessionId });
    } catch (error) {
      // A spawn can fail after its session already exists (for example a marker-lock timeout on
      // the spawn reply), so the outcome is read from this Lead's children before recording failure.
      const existingSessionId = await findAssembledChildSessionId(deps, creation.role, assignmentId);
      if (existingSessionId) created.push({ role: creation.role, sessionId: existingSessionId });
      else failed.push({ role: creation.role, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const completed: TeamAssemblyV1 = { v: 1, assignmentId, created, skipped, failed, completedAt: getNowMs() };
  await deps.updateLeadMetadata((current) => applyTeamAssemblyV1ToMetadata(current, completed));
  await deps.postNotice(buildTeamAssemblyNotice(completed));
  return 'assembled';
}

async function findAssembledChildSessionId(
  deps: Readonly<{ leadSessionId: string; listChildren: () => Promise<readonly TeamAssemblyExistingChildV1[]> }>,
  role: string,
  assignmentId: string,
): Promise<string | null> {
  const children = await deps.listChildren().catch(() => [] as readonly TeamAssemblyExistingChildV1[]);
  const child = children.find((candidate) => (
    candidate.role === role
    && candidate.origin?.creatorSessionId === deps.leadSessionId
    && candidate.origin.via?.kind === 'team_assembly'
    && candidate.origin.via.assignmentId === assignmentId
  ));
  return child?.sessionId ?? null;
}

function roleName(role: string): string {
  return resolveSessionRolePromptNameV1({ role: role as Parameters<typeof resolveSessionRolePromptNameV1>[0]['role'] });
}

function buildTeamAssemblyNotice(record: TeamAssemblyV1): string {
  const lines = ['Team assembly for this Project Lead assignment:'];
  for (const entry of record.created) lines.push(`- ${roleName(entry.role)}: created ${entry.sessionId}`);
  for (const entry of record.skipped) {
    lines.push(entry.reason === 'existing_child'
      ? `- ${roleName(entry.role)}: already present (${entry.sessionId})`
      : `- ${roleName(entry.role)}: not in this account's role catalog`);
  }
  for (const entry of record.failed) lines.push(`- ${roleName(entry.role)}: could not be created (${entry.error})`);
  return lines.join('\n');
}
