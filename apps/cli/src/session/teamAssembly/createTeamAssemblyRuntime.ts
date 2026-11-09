import type { BackendTargetRefV1, TeamAssemblyExistingChildV1 } from '@happier-dev/protocol';

import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';
import { summarizeSessionRow } from '@/cli/output/session/sessionSummary';
import type { Credentials } from '@/persistence';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
import { logger } from '@/ui/logger';

import { ensureTeamAssembly, type EnsureTeamAssemblyOutcome } from './ensureTeamAssembly';

/**
 * Binds team assembly to the Lead's own runner: it runs on startup and when a new Project Lead
 * assignment appears in this session's metadata, one attempt per assignment, serialized.
 */
export function createTeamAssemblyRuntime(params: Readonly<{
  leadSessionId: string;
  readCredentials: () => Promise<Credentials | null>;
  readLeadMetadata: () => Record<string, unknown> | null;
  readSettings: () => Promise<unknown>;
  updateLeadMetadata: (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => Promise<void>;
  postNotice: (text: string) => void;
  resolveLeadDirectory: () => string;
}>) {
  let lastAttemptedAssignmentId: string | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  const listChildren = async (credentials: Credentials): Promise<TeamAssemblyExistingChildV1[]> => {
    const children: TeamAssemblyExistingChildV1[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await fetchSessionsPage({ token: credentials.token, ...(cursor ? { cursor } : {}) });
      for (const row of page.sessions) {
        const summary = summarizeSessionRow({ credentials, row });
        if (!summary.origin || summary.origin.creatorSessionId !== params.leadSessionId) continue;
        children.push({
          sessionId: summary.id,
          role: summary.role?.id ?? null,
          origin: { v: 1, kind: 'agent', creatorSessionId: summary.origin.creatorSessionId, ...(summary.origin.via ? { via: summary.origin.via as never } : {}) },
          archived: summary.archivedAt !== null && summary.archivedAt !== undefined,
        });
      }
      if (!page.hasNext || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return children;
  };

  const run = async (): Promise<EnsureTeamAssemblyOutcome | 'skipped'> => {
    const metadata = params.readLeadMetadata();
    const role = metadata?.sessionRoleV1 as { role?: unknown; assignmentId?: unknown } | undefined;
    const assignmentId = role?.role === 'project_lead' && typeof role.assignmentId === 'string' ? role.assignmentId : null;
    if (!assignmentId || assignmentId === lastAttemptedAssignmentId) return 'skipped';
    lastAttemptedAssignmentId = assignmentId;
    const credentials = await params.readCredentials();
    if (!credentials) return 'skipped';
    const leadMachineId = typeof metadata?.machineId === 'string' ? metadata.machineId : null;
    const leadAgentId = typeof metadata?.flavor === 'string' ? metadata.flavor : null;
    return await ensureTeamAssembly({
      leadSessionId: params.leadSessionId,
      readLeadMetadata: params.readLeadMetadata,
      readSettings: params.readSettings,
      listChildren: async () => await listChildren(credentials),
      createPlaceholder: async (request) => {
        const backendTarget: BackendTargetRefV1 | null = request.backendTarget
          ?? (leadAgentId ? { kind: 'builtInAgent', agentId: leadAgentId } as BackendTargetRefV1 : null);
        if (!backendTarget) throw new Error('The Lead has no backend target to copy');
        const permissionMode = request.permissionMode
          ? permissionModeForExecutionRunPolicy(request.permissionMode)
          : request.leadPermissionMode ?? undefined;
        const created = await createSpawnedSession({
          credentials,
          directory: params.resolveLeadDirectory(),
          ...(leadMachineId ? { machineId: leadMachineId } : {}),
          backendTarget,
          ...(permissionMode ? { permissionMode } : {}),
          ...(request.modelId ? { modelId: request.modelId } : {}),
          sessionRoleV1: request.sessionRoleV1,
          sessionOriginV1: request.origin,
        });
        return { sessionId: created.sessionId };
      },
      updateLeadMetadata: params.updateLeadMetadata,
      postNotice: async (text) => params.postNotice(text),
    });
  };

  return {
    /** Startup and every metadata change; a no-op unless a new Project Lead assignment is present. */
    observe(): void {
      tail = tail.then(run, run).catch((error) => {
        logger.warn('[TEAM ASSEMBLY] Assembly failed', { error: error instanceof Error ? error.message : String(error) });
      });
    },
  };
}
