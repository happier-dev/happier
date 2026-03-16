import {
  type BackendTargetRefV1,
  type ExecutionRunRetentionPolicy,
  ReviewFindingsV2Schema,
  type ReviewFinding,
  type ReviewFindingsV2,
} from '@happier-dev/protocol';

export function buildReviewFindingsV2Payload(params: Readonly<{
  runId: string;
  callId: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  retentionPolicy?: ExecutionRunRetentionPolicy;
  summary: string;
  overviewMarkdown?: string | null;
  findings: readonly ReviewFinding[];
  questions?: readonly unknown[] | null;
  assumptions?: readonly unknown[] | null;
  limits?: Readonly<Record<string, unknown>> | null;
  triage?: unknown;
  publication?: unknown;
  generatedAtMs: number;
}>): ReviewFindingsV2 {
  return ReviewFindingsV2Schema.parse({
    runRef: {
      runId: params.runId,
      callId: params.callId,
      backendId: params.backendId,
      ...(params.backendTarget ? { backendTarget: params.backendTarget } : {}),
      ...(params.retentionPolicy ? { retentionPolicy: params.retentionPolicy } : {}),
    },
    summary: params.summary,
    overviewMarkdown:
      typeof params.overviewMarkdown === 'string' && params.overviewMarkdown.trim().length > 0
        ? params.overviewMarkdown
        : params.summary,
    findings: params.findings,
    questions: params.questions ?? [],
    assumptions: params.assumptions ?? [],
    ...(params.limits ? { limits: params.limits } : {}),
    ...(params.triage ? { triage: params.triage } : {}),
    ...(params.publication ? { publication: params.publication } : {}),
    generatedAtMs: params.generatedAtMs,
  });
}
