import { z } from 'zod';
import type {
  SessionWorkStateItemV1,
  SessionWorkStateStatusV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

export const CODEX_APP_SERVER_GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
] as const;

export type CodexAppServerGoalStatus = (typeof CODEX_APP_SERVER_GOAL_STATUSES)[number];
export type CodexAppServerWritableGoalStatus = 'active' | 'paused' | 'complete';
type SessionWorkStateStatusReason = NonNullable<SessionWorkStateItemV1['statusReason']>;
type DecodedCodexGoal = SessionWorkStateItemV1 & Readonly<{ vendorRef: string }>;

const CodexAppServerGoalSchema = z.object({
  threadId: z.string().trim().min(1),
  objective: z.string().trim().min(1).max(4000),
  status: z.enum(CODEX_APP_SERVER_GOAL_STATUSES),
  tokenBudget: z.number().finite().positive().nullable().optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  timeUsedSeconds: z.number().finite().nonnegative().optional(),
  createdAt: z.union([z.string(), z.number()]).optional(),
  updatedAt: z.union([z.string(), z.number()]),
}).passthrough();

export function normalizeCodexGoalTimestampMs(value: unknown): number | null {
  // App-server goal numbers are Unix seconds. ISO strings remain accepted for
  // deployed read compatibility and Date.parse already returns milliseconds.
  if (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 8_640_000_000_000
  ) {
    const milliseconds = value * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeReadableStatus(status: CodexAppServerGoalStatus): SessionWorkStateStatusV1 {
  if (status === 'complete') return 'complete';
  if (status === 'active' || status === 'paused') return status;
  return 'blocked';
}

function normalizeReadableStatusReason(
  status: CodexAppServerGoalStatus,
): SessionWorkStateStatusReason | undefined {
  if (status === 'blocked' || status === 'usageLimited' || status === 'budgetLimited') return status;
  return undefined;
}

export function normalizeCodexGoalWritableStatus(
  status: SessionWorkStateItemV1['status'] | undefined,
): CodexAppServerWritableGoalStatus | undefined | null {
  if (status === undefined) return undefined;
  if (status === 'active' || status === 'paused' || status === 'complete') return status;
  return null;
}

export function decodeCodexAppServerGoal(params: Readonly<{
  backendId: string;
  agentId?: string;
  goal: unknown;
}>): DecodedCodexGoal | null {
  const parsed = CodexAppServerGoalSchema.safeParse(params.goal);
  if (!parsed.success) return null;
  const updatedAt = normalizeCodexGoalTimestampMs(parsed.data.updatedAt);
  if (updatedAt === null) return null;
  const createdAt = normalizeCodexGoalTimestampMs(parsed.data.createdAt);
  if (parsed.data.createdAt !== undefined && createdAt === null) return null;
  const statusReason = normalizeReadableStatusReason(parsed.data.status);

  return {
    id: `goal:${parsed.data.threadId}`,
    kind: 'goal',
    origin: 'vendor',
    status: normalizeReadableStatus(parsed.data.status),
    ...(statusReason ? { statusReason } : {}),
    title: parsed.data.objective,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    vendorRef: parsed.data.threadId,
    ...(Object.prototype.hasOwnProperty.call(parsed.data, 'tokenBudget')
      ? { tokenBudget: parsed.data.tokenBudget }
      : {}),
    ...(typeof parsed.data.tokensUsed === 'number' ? { tokensUsed: parsed.data.tokensUsed } : {}),
    ...(typeof parsed.data.timeUsedSeconds === 'number'
      ? { timeUsedSeconds: parsed.data.timeUsedSeconds }
      : {}),
    ...(createdAt !== null ? { createdAt } : {}),
    updatedAt,
  };
}
