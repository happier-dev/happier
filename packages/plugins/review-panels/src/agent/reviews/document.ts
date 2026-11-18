import type { ReviewFinding } from '@happier-dev/plugin-sdk/reviews';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

export type PanelReviewResult = Readonly<{
  outcome: 'complete' | 'partial' | 'failed';
  summary: string;
  verdict: 'pass' | 'fail' | 'unable_to_review' | null;
  findings: readonly ReviewFinding[];
  findingEvidence: readonly Readonly<{
    findingId: string;
    kind: string | null;
    topic: string | null;
    sources: readonly number[];
    sourceLabels: readonly string[];
  }>[];
  members: readonly Readonly<{ jobId: number; name: string; agent: string; status: string; verdict: string | null }>[];
}>;

export class PanelReviewError extends Error {
  constructor(
    readonly code: 'panel_document_invalid' | 'panel_document_unsupported' | 'panel_job_mismatch' | 'panel_job_missing' | 'panel_native_process_failed',
    readonly phase: 'document' | 'start' | 'review' | 'list' | 'wait' | 'show' | 'cancel' | 'stop',
    readonly exitCode?: number,
    readonly termination?: PluginProcessResult['termination'],
  ) {
    super(`${code} (${phase})`);
    this.name = 'PanelReviewError';
  }
}

function invalid(): never {
  throw new PanelReviewError('panel_document_invalid', 'document');
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : invalid();
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : invalid();
}

function optionalText(value: unknown): string | null {
  return value == null || value === '' ? null : text(value);
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid();
}

const severities = { critical: 'blocker', high: 'high', medium: 'medium', low: 'low' } as const;
const categories = {
  tests: 'testing', documentation: 'docs', security: 'security', performance: 'performance', design: 'maintainability',
} as const;

/** v0.75.0 job show --json; native document schema versions 1–3. */
export function normalizePanelReview(value: unknown, expectedJobId?: number): PanelReviewResult {
  const record = object(value);
  if (expectedJobId !== undefined && record.job_id !== expectedJobId) {
    throw new PanelReviewError('panel_job_mismatch', 'document');
  }
  if (record.structured_output == null) throw new PanelReviewError('panel_document_unsupported', 'document');
  const document = object(record.structured_output);
  const version = document.schema_version;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new PanelReviewError('panel_document_unsupported', 'document');
  }
  const summary = text(document.summary);
  if (!Array.isArray(document.findings)) invalid();
  const rawVerdict = optionalText(document.verdict);
  if (rawVerdict !== null && rawVerdict !== 'pass' && rawVerdict !== 'fail' && rawVerdict !== 'unable_to_review') invalid();
  if ((version === 1 && rawVerdict !== null) || (version === 2 && rawVerdict === null)) invalid();
  const sourceLabels = document.source_labels == null ? []
    : Array.isArray(document.source_labels) ? document.source_labels.map(text) : invalid();
  const members = record.panel == null ? [] : (() => {
    const panel = object(record.panel);
    if (!Array.isArray(panel.members)) invalid();
    return panel.members.map((entry): PanelReviewResult['members'][number] => {
      const member = object(entry);
      return {
        jobId: positiveInteger(member.job_id), name: optionalText(member.name) ?? text(member.agent),
        agent: text(member.agent), status: text(member.status), verdict: optionalText(member.verdict),
      };
    });
  })();
  const findingEvidence: Array<PanelReviewResult['findingEvidence'][number]> = [];
  const findings = document.findings.map((entry, index): ReviewFinding => {
    const finding = object(entry);
    const severity = text(finding.severity);
    if (!Object.hasOwn(severities, severity)) invalid();
    const problem = text(finding.problem);
    const fix = optionalText(finding.fix);
    // Native requires the fix field, but permits an empty recommendation.
    if (typeof finding.fix !== 'string') invalid();
    const kind = optionalText(finding.kind);
    const topic = optionalText(finding.topic);
    if (kind !== null && kind !== 'defect' && kind !== 'improvement') invalid();
    if (topic !== null && !Object.hasOwn(categories, topic)) invalid();
    if (finding.confidence != null && (typeof finding.confidence !== 'number'
      || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1)) invalid();
    if ((kind === null) !== (finding.confidence == null)) invalid();
    const file = optionalText(finding.file);
    const start = finding.start_line == null || finding.start_line === 0 ? null : positiveInteger(finding.start_line);
    const end = finding.end_line == null || finding.end_line === 0 ? null : positiveInteger(finding.end_line);
    if ((start !== null || end !== null) && (file === null || start === null || end === null || end < start)) invalid();
    const location = optionalText(finding.location);
    if (version < 3 && (!('location' in finding) || kind !== null || topic !== null || file !== null || start !== null || end !== null)) invalid();
    const sources = finding.sources == null ? []
      : Array.isArray(finding.sources) ? finding.sources.map(positiveInteger) : invalid();
    if (sourceLabels.length > 0 && sources.some((source) => source > sourceLabels.length)) invalid();
    const id = `panels-${index + 1}`;
    findingEvidence.push({ findingId: id, kind, topic, sources, sourceLabels });
    return {
      id, title: problem.split('\n')[0]!, summary: problem,
      severity: severities[severity as keyof typeof severities],
      category: topic === null ? 'correctness' : categories[topic as keyof typeof categories],
      ...(file === null ? {} : { filePath: file }),
      ...(start === null || end === null ? {} : { startLine: start, endLine: end }),
      ...(location === null ? {} : { evidence: location }),
      ...(fix === null ? {} : { suggestion: fix }),
      ...(typeof finding.confidence === 'number' ? { confidence: finding.confidence } : {}),
    };
  });
  const jobStatus = record.job == null ? null : optionalText(object(record.job).status);
  const failed = rawVerdict === 'unable_to_review' || jobStatus === 'failed' || jobStatus === 'canceled';
  const partial = rawVerdict === null || members.some((member) => member.status !== 'done');
  return { summary, verdict: rawVerdict, outcome: failed ? 'failed' : partial ? 'partial' : 'complete', findings, findingEvidence, members };
}
