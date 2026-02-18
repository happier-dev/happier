import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { AgentBackend } from '@/agent/core/AgentBackend';

import { EphemeralTaskRunRequestSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { runScmCommitMessageTask } from '@/agent/ephemeralTasks/scmCommitMessage/runScmCommitMessageTask';
import { z } from 'zod';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { randomUUID } from 'node:crypto';

function invalidParams(): { ok: false; error: { code: string; message?: string } } {
  return { ok: false, error: { code: 'invalid_request', message: 'Invalid params' } };
}

export function registerEphemeralTaskHandlers(
  rpc: RpcHandlerRegistrar,
  ctx: Readonly<{
    workingDirectory: string;
    createBackend: (opts: { backendId: string; permissionMode: string }) => AgentBackend;
    budgetRegistry?: ExecutionBudgetRegistry;
  }>,
): void {
  rpc.registerHandler(SESSION_RPC_METHODS.EPHEMERAL_TASK_RUN, async (raw: unknown) => {
    const parsed = EphemeralTaskRunRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();

    const budget = ctx.budgetRegistry ?? null;
    const taskId = `task_${randomUUID()}`;
    if (budget && !budget.tryAcquireEphemeralTask(taskId, 'ephemeral_task')) {
      return { ok: false, error: { code: 'task_busy', message: 'Ephemeral task budget exceeded' } };
    }

    if (parsed.data.kind === 'scm.commit_message') {
      const CommitMessageTaskScopeSchema = z.object({
        kind: z.literal('paths'),
        include: z.array(z.string().min(1)).max(200).optional(),
      }).strict();

      const CommitMessageTaskInputSchema = z.object({
        backendId: z.string().min(1).optional(),
        instructions: z.string().optional(),
        scope: CommitMessageTaskScopeSchema.optional(),
        maxFiles: z.number().int().positive().max(100).optional(),
        maxTotalDiffChars: z.number().int().positive().max(400_000).optional(),
      }).strict();
      const parsedInput = CommitMessageTaskInputSchema.safeParse(parsed.data.input ?? {});
      if (!parsedInput.success) {
        budget?.releaseEphemeralTask(taskId);
        return invalidParams();
      }

      const backendId = parsedInput.data.backendId ?? 'claude';
      const instructions = parsedInput.data.instructions;
      const scope = parsedInput.data.scope;
      const maxFiles = parsedInput.data.maxFiles;
      const maxTotalDiffChars = parsedInput.data.maxTotalDiffChars;
      const permissionMode = typeof parsed.data.permissionMode === 'string' ? parsed.data.permissionMode : 'no_tools';

      // Hard safety gate: commit message generation must never be write-capable.
      if (permissionMode !== 'no_tools' && permissionMode !== 'read_only') {
        budget?.releaseEphemeralTask(taskId);
        return { ok: false, error: { code: 'permission_denied', message: 'Unsafe permission mode' } };
      }

      const res = await runScmCommitMessageTask({
        workingDirectory: ctx.workingDirectory,
        instructions,
        scope,
        maxFiles,
        maxTotalDiffChars,
        createBackend: () => ctx.createBackend({ backendId, permissionMode }),
      });
      budget?.releaseEphemeralTask(taskId);
      if (!res.ok) return { ok: false, error: { code: res.errorCode, message: res.error } };
      return { ok: true, result: res.result };
    }

    budget?.releaseEphemeralTask(taskId);
    return { ok: false, error: { code: 'unsupported_kind', message: 'Unsupported task kind' } };
  });
}
