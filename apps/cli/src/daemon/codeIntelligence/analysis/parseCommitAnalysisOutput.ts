import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  CodeIntelligenceFindingSeverityV1Schema,
  type CodeIntelligenceFindingV1,
  type CodeIntelligenceRiskLevelV1,
} from '@happier-dev/protocol';

const ModelFindingSchema = z.object({
  filePath: z.string().min(1).max(2000).nullish(),
  line: z.number().int().positive().nullish(),
  symbol: z.string().min(1).max(500).nullish(),
  category: z.string().min(1).max(100),
  severity: CodeIntelligenceFindingSeverityV1Schema,
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1).max(4000),
  evidence: z.string().max(4000).nullish(),
  suggestedCorrection: z.string().max(4000).nullish(),
});

const ModelOutputSchema = z.object({
  summary: z.string().min(1).max(4000),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  findings: z.array(ModelFindingSchema).max(50),
});

export type ParsedCommitAnalysis = Readonly<{
  summary: string;
  riskLevel: CodeIntelligenceRiskLevelV1;
  findings: CodeIntelligenceFindingV1[];
}>;

function stripCodeFence(content: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content);
  return fenced?.[1] ?? content;
}

/**
 * Validates model output against the finding contract. Every finding starts `suspected`: a model's
 * claim is never verification. Finding ids are content-derived so re-analysis of the same commit
 * deduplicates identical findings.
 */
export function parseCommitAnalysisOutput(input: Readonly<{ content: string; commitSha: string }>): ParsedCommitAnalysis | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(input.content));
  } catch {
    return null;
  }
  const parsed = ModelOutputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const seen = new Set<string>();
  const findings: CodeIntelligenceFindingV1[] = [];
  for (const finding of parsed.data.findings) {
    const findingId = createHash('sha256')
      .update([input.commitSha, finding.filePath ?? '', finding.line ?? '', finding.category, finding.explanation].join('\0'))
      .digest('hex')
      .slice(0, 20);
    if (seen.has(findingId)) continue;
    seen.add(findingId);
    findings.push({
      findingId,
      filePath: finding.filePath ?? null,
      line: finding.line ?? null,
      symbol: finding.symbol ?? null,
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence,
      explanation: finding.explanation,
      evidence: finding.evidence ?? null,
      suggestedCorrection: finding.suggestedCorrection ?? null,
      verification: 'suspected',
    });
  }
  return { summary: parsed.data.summary, riskLevel: parsed.data.riskLevel, findings };
}
