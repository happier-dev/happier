import { randomUUID } from 'node:crypto';
import { createAccountRoleActionExecutorV1, RoleActionRefusalV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { readSessionRolesV1, writeSessionRoleIdV1ToMetadata, SessionRoleConfigurationV1Schema, snapshotSessionRolesAtSpawnV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRoleSelectionV1, resolveRolesSnapshotV1, readSessionWorkspaceWritesV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import type { ActionExecutorDeps, PluginRoleContributionV1, SessionRoleConfigurationV1, ActionExecutorContext, RoleEngineV1 } from '@happier-dev/protocol';
import type { AccountRoleOverridesReadV1, RoleOverrideMutationV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { createRoleSourceReader, type RoleSourceReader } from '@/session/roles/roleSources';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { logger } from '@/ui/logger';
import { applySessionRoleEditToMetadata, SessionRoleEditSchema } from '@/session/roles/sessionRoleEdit';

type RoleArtifactStore = Pick<ReturnType<typeof createAccountArtifactStore>,
  'read' | 'list' | 'create' | 'update' | 'delete' | 'accessGrants'>;
export type RoleWorkspaceWritesPolicyPreparer = (
  workspaceWrites: 'allow' | 'deny', context: ActionExecutorContext,
) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode: string }>>;

function refuse(code: string): never {
  throw new RoleActionRefusalV1(code);
}

/** Artifact and outbox ports are genuine storage boundaries; role resolution remains canonical. */
export function createRoleActionExecutor(params: Readonly<{
  sessionId: string;
  readSessionMetadata?: () => unknown;
  stageSessionStateMutation?: (mutation: RegisteredSessionStateFieldMutationV1) => Promise<void>;
  /** The receiving host rechecks transported authority immediately before custody changes. */
  beforeSessionMutation?: (context: ActionExecutorContext, sessionId: string) => Promise<void>;
  artifactStore?: RoleArtifactStore;
  readSettingsOverrides?: (signal?: AbortSignal) => AccountRoleOverridesReadV1 | Promise<AccountRoleOverridesReadV1>;
  readPluginRoles?: () => readonly PluginRoleContributionV1[];
  readRoleSnapshotInputs?: (metadata: Readonly<Record<string, unknown>>, context: ActionExecutorContext) => Promise<Readonly<{
    defaultEngine: RoleEngineV1;
    availableAgentTargetKeys: readonly string[];
  }>>;
  accountId?: string;
  readRawAccountSettings?: () => Promise<Readonly<Record<string, unknown>>>;
  mutateRawAccountSettings?: Parameters<typeof createAccountRoleActionExecutorV1>[0]['mutateRawAccountSettings'];
  mutateAccountRoleOverrides?: (mutation: RoleOverrideMutationV1, context: ActionExecutorContext) => Promise<void>;
  readRoleSources?: RoleSourceReader;
  listReportSessions?: (leadSessionId: string, context: import('@happier-dev/protocol').ActionExecutorContext) => Promise<readonly Readonly<{ sessionId: string; ownerAccountId: string }>[]>;
  writeReportSessionRoles?: (sessionId: string, configuration: SessionRoleConfigurationV1, context: import('@happier-dev/protocol').ActionExecutorContext) => Promise<void>;
  forwardSessionRoleAction?: NonNullable<ActionExecutorDeps['roleActionExecute']>;
  prepareWorkspaceWritesPolicy?: RoleWorkspaceWritesPolicyPreparer;
}>): NonNullable<ActionExecutorDeps['roleActionExecute']> {
  const listEntries = params.readRoleSources ?? createRoleSourceReader(params);
  const editSourceIds = (snapshot: ReturnType<typeof readSessionRolesV1> | undefined, roleIds: readonly (string | null | undefined)[]) =>
    [...new Set(roleIds.filter((roleId): roleId is string => roleId != null
      && !Object.hasOwn(BUILT_IN_ROLES_V1, roleId) && snapshot?.sessionRoles[roleId]?.roleId !== roleId))];
  const readSettingsOverrides = async (signal?: AbortSignal) => {
    const read = await params.readSettingsOverrides?.(signal) ?? { status: 'unavailable' as const, reason: 'source-unavailable' };
    if (read.status !== 'ready') {
      const error = Object.assign(new RoleActionRefusalV1('account_role_overrides_unavailable'), {
        reason: read.reason, contextSource: 'account_lifetime',
      });
      const { readSessionPreparationFailureDiagnostic } = await import('@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue');
      logger.infoFile('[Session] Role Action refused', readSessionPreparationFailureDiagnostic(error));
      throw error;
    }
    return read.overrides;
  };
  const accountActions = createAccountRoleActionExecutorV1({ ...params, readRoleSources: listEntries, generateId: randomUUID });
  return async ({ actionId, input, context }) => {
    context.signal?.throwIfAborted();
    const parsedInput = RoleActionInputSchemasV1[actionId].parse(input);
    if ('sessionId' in parsedInput && parsedInput.sessionId !== params.sessionId) {
      if (!params.forwardSessionRoleAction) refuse('session_target_unavailable');
      return await params.forwardSessionRoleAction({ actionId, input: parsedInput, context });
    }
    if (actionId.startsWith('roles.')) return await accountActions({ actionId, input: parsedInput, context });
    if (actionId === 'session.roles.apply_to_reports') {
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      if (request.sessionId !== params.sessionId || !params.accountId || !params.readSessionMetadata
        || !params.listReportSessions || !params.writeReportSessionRoles) refuse('session_target_unavailable');
      const { listReportSessions, writeReportSessionRoles } = params;
      const metadata = params.readSessionMetadata();
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) refuse('session_target_unavailable');
      // Validate authoritative owner data even when there is no existing role selection.
      writeSessionRoleIdV1ToMetadata(metadata as Record<string, unknown>, readSessionRolesV1(metadata)?.roleId ?? null);
      const applyStartedAt = performance.now();
      const measurePhase = async <T>(phase: string, operation: () => Promise<T>, reportSessionId?: string): Promise<T> => {
        const startedAt = performance.now();
        let outcome: 'ok' | 'failed' = 'failed';
        try {
          const result = await operation();
          outcome = 'ok';
          return result;
        } finally {
          logger.infoFile('[Session] Role Apply phase', { sessionId: request.sessionId,
            ...(reportSessionId ? { reportSessionId } : {}),
            phase, durationMs: Math.round(performance.now() - startedAt),
            elapsedMs: Math.round(performance.now() - applyStartedAt),
            outcome: outcome === 'failed' && context.signal?.aborted ? 'cancelled' : outcome });
        }
      };
      const reports = (await measurePhase('reports', () => listReportSessions(request.sessionId, context)))
        .filter(report => report.ownerAccountId === params.accountId && report.sessionId !== request.sessionId);
      if (reports.length === 0) return { updatedSessionIds: [] };
      const current = readSessionRolesV1(metadata) ?? undefined;
      const inventory = await measurePhase('sources', async () => {
        const inventory = await listEntries(context.signal);
        if (inventory.status !== 'ready') refuse('role_source_incomplete');
        return inventory;
      });
      const settingsOverrides = await measurePhase('settings', () => readSettingsOverrides(context.signal));
      if (!params.readRoleSnapshotInputs) refuse('target_unavailable');
      const engineInputs = await measurePhase('engine', () => params.readRoleSnapshotInputs!(metadata as Record<string, unknown>, context));
      const roles = resolveRolesSnapshotV1({ roleSourceInventory: inventory, settingsOverrides, sessionRoles: current, ...engineInputs });
      const configuration = SessionRoleConfigurationV1Schema.parse(snapshotSessionRolesAtSpawnV1({
        leadSessionId: request.sessionId, roles, notes: current?.notes,
      }));
      const updatedSessionIds: string[] = [];
      for (const report of reports) {
        context.signal?.throwIfAborted();
        await measurePhase('recipient', () => writeReportSessionRoles(report.sessionId, configuration, context), report.sessionId);
        updatedSessionIds.push(report.sessionId);
      }
      return { updatedSessionIds };
    }
    if (actionId === 'session.role.set') {
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      if (request.sessionId !== params.sessionId) refuse('session_target_unavailable');
      if (!params.stageSessionStateMutation || !params.readSessionMetadata) refuse('session_target_unavailable');
      const readSessionMetadata = params.readSessionMetadata;
      const stageSessionStateMutation = params.stageSessionStateMutation;
      const stageRoleEdit = async () => {
        context.signal?.throwIfAborted();
        const metadata = readSessionMetadata();
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) refuse('session_target_unavailable');
        const edit = SessionRoleEditSchema.parse({ actionId, input: request });
        const next = readSessionRolesV1(applySessionRoleEditToMetadata(metadata as Record<string, unknown>, edit));
        if (!next) refuse('session_target_unavailable');
        const { roleId: _roleId, ...configuration } = next;
        await stageSessionStateMutation({ v: 1, sessionId: request.sessionId, mutationId: randomUUID(),
          fieldId: 'intent.sessionRoles', deliveryClass: 'durable_required', op: { kind: 'set', value: configuration },
          sessionRoleEdit: edit,
          source: context.authority === 'present_user' ? 'ui' : 'runtime', observedAt: Date.now() });
      };
      const roleId = request.roleId;
      if (roleId === undefined) {
        await params.beforeSessionMutation?.(context, request.sessionId);
        await stageRoleEdit();
        return { updated: true };
      }
      const metadata = readSessionMetadata();
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) refuse('session_target_unavailable');
      writeSessionRoleIdV1ToMetadata(metadata as Record<string, unknown>, roleId);
      const snapshot = readSessionRolesV1(metadata) ?? undefined;
      const settingsOverrides = await readSettingsOverrides(context.signal);
      // Built-ins and complete inherited bodies are already authoritative.
      // Fresh external policy needs only the requested and current identities.
      const roleIds = editSourceIds(snapshot, [roleId, snapshot?.roleId]);
      const inventory = roleIds.length ? await listEntries(context.signal, { roleIds }) : undefined;
      const readCandidate = () => {
        const metadata = readSessionMetadata();
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) refuse('session_target_unavailable');
        writeSessionRoleIdV1ToMetadata(metadata as Record<string, unknown>, roleId);
        const selection = resolveRoleSelectionV1({ roleId, roleSourceInventory: inventory,
          settingsOverrides, sessionRoles: readSessionRolesV1(metadata) ?? undefined, pluginRoles: params.readPluginRoles?.() });
        if (!selection.ok) refuse(selection.refusal.code);
        const previousWorkspaceWrites = readSessionWorkspaceWritesV1(metadata, { roleSourceInventory: inventory, settingsOverrides });
        // The target's latest policy and the caller's ceiling both remain monotone.
        if (context.authority !== 'present_user' && selection.selection.workspaceWrites === 'allow'
          && (context.workspaceWrites === 'deny' || previousWorkspaceWrites === 'deny')) refuse('role_policy_denied');
        context.signal?.throwIfAborted();
        return { workspaceWrites: selection.selection.workspaceWrites, previousWorkspaceWrites };
      };
      let candidate = readCandidate();
      let preparedDeny = false;
      // Relaxation is synchronized from accepted owner metadata, never before enqueue.
      if (candidate.workspaceWrites === 'deny' && candidate.previousWorkspaceWrites !== 'deny' && params.prepareWorkspaceWritesPolicy) {
        const prepared = await params.prepareWorkspaceWritesPolicy('deny', context);
        if (!prepared.ok) refuse(prepared.errorCode);
        preparedDeny = true;
      } else if (candidate.workspaceWrites === 'deny' && candidate.previousWorkspaceWrites !== 'deny') refuse('role_policy_unenforceable');
      await params.beforeSessionMutation?.(context, request.sessionId);
      candidate = readCandidate();
      // A concurrent edit may make the requested selection newly require native deny.
      if (!preparedDeny && candidate.workspaceWrites === 'deny' && candidate.previousWorkspaceWrites !== 'deny') {
        if (!params.prepareWorkspaceWritesPolicy) refuse('role_policy_unenforceable');
        const prepared = await params.prepareWorkspaceWritesPolicy('deny', context);
        if (!prepared.ok) refuse(prepared.errorCode);
        await params.beforeSessionMutation?.(context, request.sessionId);
        readCandidate();
      }
      if (request.answersWorkerQuestions === undefined) {
        await stageSessionStateMutation({ v: 1, sessionId: request.sessionId, mutationId: randomUUID(),
          fieldId: 'intent.role', deliveryClass: 'durable_required', op: { kind: 'set', value: roleId },
          source: context.authority === 'present_user' ? 'ui' : 'runtime', observedAt: Date.now() });
      } else {
        await stageRoleEdit();
      }
      return { updated: true };
    }
    if (actionId === 'session.roles.override.set' || actionId === 'session.roles.override.clear'
      || actionId === 'session.roles.add' || actionId === 'session.roles.remove' || actionId === 'session.notes.set') {
      if (!params.stageSessionStateMutation || !params.readSessionMetadata) refuse('session_target_unavailable');
      const readSessionMetadata = params.readSessionMetadata;
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      if (request.sessionId !== params.sessionId) refuse('session_target_unavailable');
      const edit = SessionRoleEditSchema.parse({ actionId, input: request });
      const snapshot = readSessionRolesV1(readSessionMetadata());
      // These edits need the selected/edited roles' policy, not every unrelated
      // document. Built-in policy and overrides are already held by the Session.
      const roleIds = editSourceIds(snapshot, [snapshot?.roleId, 'roleId' in request ? request.roleId : undefined]);
      const inventory = roleIds.length ? await listEntries(context.signal, { roleIds }) : undefined;
      const settingsOverrides = await readSettingsOverrides(context.signal);
      const layers = { roleSourceInventory: inventory, settingsOverrides };
      const readCandidate = () => {
        const metadata = readSessionMetadata();
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) refuse('session_target_unavailable');
        const current = readSessionRolesV1(metadata) ?? { overrides: {}, sessionRoles: {}, notes: '' };
        const nextMetadata = applySessionRoleEditToMetadata(metadata as Record<string, unknown>, edit);
        const next = readSessionRolesV1(nextMetadata);
        if (!next) refuse('session_target_unavailable');
        const { roleId: _roleId, ...configuration } = next;
        if (context.authority !== 'present_user' && 'roleId' in request) {
          const before = resolveRoleSelectionV1({ roleId: request.roleId, roleSourceInventory: inventory, settingsOverrides, sessionRoles: current });
          const after = resolveRoleSelectionV1({ roleId: request.roleId, roleSourceInventory: inventory, settingsOverrides, sessionRoles: configuration });
          if (after.ok && after.selection.workspaceWrites === 'allow'
            && (context.workspaceWrites === 'deny' || (before.ok && before.selection.workspaceWrites === 'deny'))) refuse('role_policy_denied');
          if (before.ok && before.selection.workspaceWrites === 'deny' && !after.ok) refuse('role_policy_denied');
        }
        // Reject malformed authoritative data before acknowledging a queued edit, not only at replay.
        const workspaceWrites = readSessionWorkspaceWritesV1(nextMetadata, layers);
        const previousWorkspaceWrites = readSessionWorkspaceWritesV1(metadata, layers);
        context.signal?.throwIfAborted();
        return { configuration, workspaceWrites, previousWorkspaceWrites };
      };
      let candidate = readCandidate();
      let preparedDeny = false;
      // Tightening is safe before enqueue; relaxation waits for the durable owner
      // value to be observed by the host at its next prompt admission.
      if (candidate.workspaceWrites === 'deny' && candidate.previousWorkspaceWrites !== 'deny' && params.prepareWorkspaceWritesPolicy) {
        const prepared = await params.prepareWorkspaceWritesPolicy('deny', context);
        if (!prepared.ok) refuse(prepared.errorCode);
        preparedDeny = true;
      } else if (candidate.workspaceWrites === 'deny' && candidate.previousWorkspaceWrites !== 'deny') refuse('role_policy_unenforceable');
      await params.beforeSessionMutation?.(context, request.sessionId);
      candidate = readCandidate();
      if (!preparedDeny && candidate.workspaceWrites === 'deny' && candidate.previousWorkspaceWrites !== 'deny') {
        if (!params.prepareWorkspaceWritesPolicy) refuse('role_policy_unenforceable');
        const prepared = await params.prepareWorkspaceWritesPolicy('deny', context);
        if (!prepared.ok) refuse(prepared.errorCode);
        await params.beforeSessionMutation?.(context, request.sessionId);
        candidate = readCandidate();
      }
      await params.stageSessionStateMutation({ v: 1, sessionId: request.sessionId, mutationId: randomUUID(),
        fieldId: 'intent.sessionRoles', deliveryClass: 'durable_required', op: { kind: 'set', value: candidate.configuration },
        sessionRoleEdit: edit,
        source: context.authority === 'present_user' ? 'ui' : 'runtime', observedAt: Date.now() });
      return { updated: true };
    }
    return refuse('unsupported_action');
  };
}
