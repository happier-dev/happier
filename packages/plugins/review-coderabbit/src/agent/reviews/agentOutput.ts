import type { ReviewFinding } from '@happier-dev/plugin-sdk/reviews';
import { redactReviewCommentSensitiveText } from '@happier-dev/plugin-sdk/reviews';

const SEVERITIES = {
  critical: 'blocker', major: 'high', minor: 'medium', trivial: 'nit', info: 'low', none: 'low',
} as const satisfies Record<string, ReviewFinding['severity']>;

type AgentCompletion = Readonly<{
  status: string;
  outcome?: string;
  findings?: number;
  unreviewedFileCount?: number;
  reused?: boolean;
  gate?: Readonly<{ status: 'passed' | 'blocked' | 'incomplete' }>;
  persistence?: Readonly<{ status: 'failed' }>;
}>;

type AgentError = Readonly<{ errorType?: string }>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? redactReviewCommentSensitiveText(value.trim()) : undefined;
}

function line(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** CodeRabbit CLI 0.9.5: https://docs.coderabbit.ai/cli/agent-mode.
 * Only this external boundary interprets vendor events. Heartbeats never publish review content.
 */
export function createCodeRabbitAgentOutput() {
  const decoder = new TextDecoder();
  const findings: ReviewFinding[] = [];
  const errors: AgentError[] = [];
  let pending: string[] = [];
  let invalid = false;
  let completion: AgentCompletion | null = null;

  const acceptLine = (raw: string) => {
    if (!raw.trim()) return;
    let event: Record<string, unknown> | null;
    try { event = record(JSON.parse(raw)); } catch { invalid = true; return; }
    if (!event || typeof event.type !== 'string') { invalid = true; return; }
    switch (event.type) {
      case 'finding': {
        const severity = typeof event.severity === 'string' && Object.hasOwn(SEVERITIES, event.severity)
          ? SEVERITIES[event.severity as keyof typeof SEVERITIES] : null;
        const comment = text(event.comment);
        const suggestion = text(event.codegenInstructions) ?? comment;
        const title = text(event.title) ?? comment?.split('\n')[0] ?? suggestion?.split('\n')[0];
        const filePath = text(event.fileName);
        const startLine = line(event.startLine);
        const endLine = line(event.endLine);
        if (!severity || !title || !filePath
          || (event.startLine !== undefined && startLine === undefined)
          || (event.endLine !== undefined && (endLine === undefined || (startLine !== undefined && endLine < startLine)))) {
          invalid = true; return;
        }
        findings.push({ id: `coderabbit-${findings.length + 1}`, title, severity, category: 'correctness',
          summary: comment ?? suggestion ?? title, filePath,
          ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }),
          ...(suggestion ? { suggestion } : {}),
        });
        return;
      }
      case 'complete': {
        if (event.status !== 'review_completed' && event.status !== 'review_skipped') { invalid = true; return; }
        for (const field of ['findings', 'unreviewedFileCount'] as const) {
          if (event[field] !== undefined && (typeof event[field] !== 'number' || !Number.isSafeInteger(event[field]) || event[field] < 0)) {
            invalid = true; return;
          }
        }
        const gate = record(event.gate);
        const gateStatus = gate?.status;
        if (gate && gateStatus !== 'passed' && gateStatus !== 'blocked' && gateStatus !== 'incomplete') {
          invalid = true; return;
        }
        const persistence = record(event.persistence);
        completion = { status: event.status,
          ...(typeof event.outcome === 'string' ? { outcome: event.outcome } : {}),
          ...(typeof event.findings === 'number' ? { findings: event.findings } : {}),
          ...(typeof event.unreviewedFileCount === 'number' ? { unreviewedFileCount: event.unreviewedFileCount } : {}),
          ...(event.reused === true ? { reused: true } : {}),
          ...(gateStatus === 'passed' || gateStatus === 'blocked' || gateStatus === 'incomplete' ? { gate: { status: gateStatus } } : {}),
          ...(persistence?.status === 'failed' ? { persistence: { status: 'failed' } } : {}),
        };
        return;
      }
      case 'error': {
        const errorType = typeof event.errorType === 'string' && /^[a-z][a-z0-9_]*$/i.test(event.errorType) ? event.errorType : undefined;
        errors.push({ errorType }); return;
      }
      // Context/status events and future informational types do not establish completion.
      default: return;
    }
  };
  const consume = (value: string) => {
    let start = 0;
    let end: number;
    while ((end = value.indexOf('\n', start)) !== -1) {
      pending.push(value.slice(start, end));
      acceptLine(pending.join(''));
      pending = [];
      start = end + 1;
    }
    if (start < value.length) pending.push(value.slice(start));
  };

  return {
    write(bytes: Uint8Array) { consume(decoder.decode(bytes, { stream: true })); },
    finish(exitCode: number | null) {
      consume(decoder.decode());
      acceptLine(pending.join(''));
      pending = [];
      const terminal = completion as AgentCompletion | null;
      const invalidOutput = invalid || (errors.length === 0 && (!terminal || (terminal.findings !== undefined && terminal.findings !== findings.length)));
      const gateBlocked = exitCode === 2 && terminal?.gate?.status === 'blocked';
      const completed = !invalidOutput && errors.length === 0 && (exitCode === 0 || gateBlocked)
        && terminal !== null && terminal.outcome !== 'failed' && (terminal.unreviewedFileCount ?? 0) === 0
        && terminal.gate?.status !== 'incomplete';
      const reviewOutcome = completed ? 'complete' as const : findings.length > 0 ? 'partial' as const : 'failed' as const;
      const errorType = errors[0]?.errorType;
      const code = invalidOutput ? 'coderabbit_invalid_output'
        : errorType ? `coderabbit_${errorType}` : 'coderabbit_review_failed';
      const summary = `CodeRabbit review: ${findings.length} finding(s), ${reviewOutcome}.`;
      const details = [summary,
        terminal?.unreviewedFileCount ? `${terminal.unreviewedFileCount} file(s) were not reviewed.` : undefined,
        terminal?.reused ? 'CodeRabbit reused an earlier review result.' : undefined,
        terminal?.gate?.status ? `Severity gate: ${terminal.gate.status}.` : undefined,
        terminal?.persistence?.status === 'failed' ? 'Local findings could not be saved. Check local storage permissions and free space.' : undefined,
        errors.length > 0 ? errorType === 'rate_limit' || errorType === 'rate_limit_exceeded'
          ? 'CodeRabbit reached its quota. Wait for the vendor reset window, then start another review.'
          : 'CodeRabbit could not complete the review. Check CLI authentication and service availability before retrying.' : undefined,
        invalidOutput ? 'CodeRabbit did not provide valid terminal review evidence.' : undefined,
        !completed && errors.length === 0 && !invalidOutput ? `CodeRabbit exited with code ${exitCode ?? 'unavailable'}.` : undefined,
      ].filter(Boolean).join('\n\n');
      return { hasReviewResult: !invalidOutput && errors.length === 0 && terminal !== null, code, message: details,
        output: JSON.stringify({ reviewOutcome, summary, overviewMarkdown: details, findings, questions: [], assumptions: [],
          ...(reviewOutcome === 'failed' ? { error: { code } } : {}),
          proposedComments: findings.map(finding => ({ findingId: finding.id, body: finding.summary,
            anchor: finding.startLine === undefined ? { kind: 'file', filePath: finding.filePath }
              : finding.endLine !== undefined && finding.endLine > finding.startLine
                ? { kind: 'range', filePath: finding.filePath, startLine: finding.startLine, endLine: finding.endLine }
                : { kind: 'line', filePath: finding.filePath, line: finding.startLine },
            severity: finding.severity === 'blocker' ? 'critical' : finding.severity === 'high' ? 'error' : finding.severity === 'medium' ? 'warning' : 'info',
            taxonomyIds: ['coderabbit.correctness'], tags: ['coderabbit'],
          })),
        }),
      };
    },
  };
}
