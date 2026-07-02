import type {
  PluginReviewCommentsServiceV1,
  ReviewCommentAnchorV1,
  ReviewCommentV1,
} from '@happier-dev/plugin-sdk';
import type { ReviewFinding } from '@happier-dev/protocol';

function normalizeLine(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.trunc(value))
    : null;
}

function createAnchor(finding: ReviewFinding): ReviewCommentAnchorV1 | null {
  const filePath = String(finding.filePath ?? '').trim();
  if (!filePath) return null;
  const startLine = normalizeLine(finding.startLine);
  const endLine = normalizeLine(finding.endLine);
  if (startLine && endLine && endLine > startLine) {
    return { kind: 'range', filePath, startLine, endLine };
  }
  if (startLine) return { kind: 'line', filePath, line: startLine };
  return { kind: 'file', filePath };
}

function createBody(finding: ReviewFinding): string {
  return String(finding.summary ?? finding.title ?? '').trim();
}

function mapCommentSeverity(severity: ReviewFinding['severity']): 'info' | 'warning' | 'error' | 'critical' {
  if (severity === 'blocker') return 'critical';
  if (severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'info';
}

export async function mapCodeRabbitReviewComments(params: Readonly<{
  projectId: string;
  workspaceId?: string;
  sessionId?: string;
  runId: string;
  findings: readonly ReviewFinding[];
  cwd?: string | null;
  comments: Pick<PluginReviewCommentsServiceV1, 'create' | 'resolveSnapshot'>;
}>): Promise<readonly ReviewCommentV1[]> {
  const projectId = params.projectId.trim();
  if (!projectId) {
    throw new Error('CodeRabbit review comments require a projectId.');
  }

  const created: ReviewCommentV1[] = [];
  for (const finding of params.findings) {
    const anchor = createAnchor(finding);
    if (!anchor) continue;
    const body = createBody(finding);
    if (!body) continue;
    const snapshot = await params.comments.resolveSnapshot({
      ...(params.cwd ? { cwd: params.cwd } : {}),
      projectId,
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      runId: params.runId,
      engineId: 'coderabbit',
      findingId: finding.id,
      finding,
      anchor,
    });
    if (!snapshot) continue;

    const result = await params.comments.create({
      projectId,
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      runId: params.runId,
      engineId: 'coderabbit',
      findingId: finding.id,
      body,
      anchor,
      snapshot,
      authorIntent: 'propose',
      evidence: [{ kind: 'reasoning', message: `CodeRabbit finding ${finding.id}` }],
      fingerprint: {
        ruleId: String(finding.category ?? 'coderabbit'),
        normalizedMessageHash: `${JSON.stringify(anchor)}:${body}`,
      },
      clientMutationId: `coderabbit:${params.runId}:${finding.id}`,
      metadata: {
        severity: mapCommentSeverity(finding.severity),
        taxonomyIds: [`coderabbit.${finding.category}`],
        tags: ['coderabbit'],
      },
    });
    created.push(result.comment);
  }
  return created;
}
