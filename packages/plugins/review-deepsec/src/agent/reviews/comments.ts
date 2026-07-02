import { createHash } from 'node:crypto';

import type {
  PluginReviewCommentsServiceV1,
  ReviewCommentV1,
} from '@happier-dev/plugin-sdk';

import type { ParsedDeepSecCommentOutEntry } from './commentOut.js';

function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function filePathForEntry(entry: ParsedDeepSecCommentOutEntry): string {
  return 'filePath' in entry.anchor ? entry.anchor.filePath : 'workspace';
}

export async function mapDeepSecReviewComments(params: Readonly<{
  projectId: string;
  workspaceId?: string;
  sessionId?: string;
  runId: string;
  entries: readonly ParsedDeepSecCommentOutEntry[];
  comments: Pick<PluginReviewCommentsServiceV1, 'create' | 'resolveSnapshot'>;
}>): Promise<readonly ReviewCommentV1[]> {
  const created: ReviewCommentV1[] = [];
  for (let index = 0; index < params.entries.length; index += 1) {
    const entry = params.entries[index];
    if (!entry) continue;
    const body = entry.body.trim();
    if (!body) continue;
    const filePath = filePathForEntry(entry);
    const snapshot = await params.comments.resolveSnapshot({
      projectId: params.projectId,
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      runId: params.runId,
      engineId: 'deepsec',
      anchor: entry.anchor,
    });
    if (!snapshot) continue;
    const ruleId = entry.ruleId?.trim() || entry.category?.trim() || 'deepsec';
    const lineRange = entry.anchor.kind === 'line'
      ? { startLine: entry.anchor.line, endLine: entry.anchor.line }
      : entry.anchor.kind === 'range'
        ? { startLine: entry.anchor.startLine, endLine: entry.anchor.endLine }
        : undefined;
    const result = await params.comments.create({
      projectId: params.projectId,
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      runId: params.runId,
      engineId: 'deepsec',
      body,
      anchor: entry.anchor,
      snapshot,
      evidence: [{ kind: 'reasoning', message: `DeepSec finding ${index + 1}` }],
      fingerprint: {
        ruleId,
        normalizedMessageHash: stableHash(`${ruleId}:${filePath}:${body.toLowerCase()}`),
        ...(lineRange ? { lineRange } : {}),
        engineId: 'deepsec',
      },
      authorIntent: 'propose',
      clientMutationId: `deepsec:${params.runId}:${index + 1}:${stableHash(`${filePath}:${body}`).slice(0, 12)}`,
      metadata: {
        severity: mapCommentSeverity(entry.severity),
        taxonomyIds: [entry.ruleId, entry.category].filter((value): value is string => Boolean(value)),
        tags: [...entry.tags],
      },
    });
    created.push(result.comment);
  }
  return created;
}

function mapCommentSeverity(severity: string | undefined): 'critical' | 'error' | 'warning' | 'info' {
  const normalized = String(severity ?? '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'blocker') return 'critical';
  if (normalized === 'high' || normalized === 'error') return 'error';
  if (normalized === 'medium' || normalized === 'moderate' || normalized === 'warning') return 'warning';
  return 'info';
}
