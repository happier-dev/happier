import { z } from 'zod';

const DiffSummaryModelOutputSchema = z.object({
  summaryMarkdown: z.string().trim().min(1).max(80_000),
  risks: z.array(z.string().trim().min(1)).max(100).optional(),
  testImpact: z.string().trim().min(1).max(20_000).optional(),
  suggestedPrBody: z.string().trim().min(1).max(80_000).optional(),
}).passthrough();

export type DiffSummaryModelOutput = z.infer<typeof DiffSummaryModelOutputSchema>;

export function parseDiffSummaryModelOutput(rawText: string): DiffSummaryModelOutput | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }

  const result = DiffSummaryModelOutputSchema.safeParse(parsed);
  if (!result.success) return null;

  return {
    ...result.data,
    summaryMarkdown: result.data.summaryMarkdown.trim(),
    ...(result.data.risks ? { risks: result.data.risks.map((risk) => risk.trim()).filter(Boolean) } : {}),
    ...(result.data.testImpact ? { testImpact: result.data.testImpact.trim() } : {}),
    ...(result.data.suggestedPrBody ? { suggestedPrBody: result.data.suggestedPrBody.trim() } : {}),
  };
}
