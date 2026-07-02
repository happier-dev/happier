import type { ReviewFinding } from '@happier-dev/protocol';

import type { ParsedDeepSecCommentOutEntry } from './commentOut.js';

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() || 'DeepSec security finding';
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

function mapSeverity(severity: string | undefined): ReviewFinding['severity'] {
  const normalized = String(severity ?? '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'blocker') return 'blocker';
  if (normalized === 'high' || normalized === 'error') return 'high';
  if (normalized === 'medium' || normalized === 'moderate' || normalized === 'warning') return 'medium';
  if (normalized === 'low') return 'low';
  if (normalized === 'nit' || normalized === 'info' || normalized === 'informational') return 'nit';
  return 'medium';
}

function taxonomyFamily(ruleId: string | undefined, category: string | undefined): string | undefined {
  const normalized = String(ruleId ?? '').trim().toUpperCase();
  if (normalized.startsWith('CWE-')) return 'cwe';
  if (normalized.startsWith('CVE-')) return 'cve';
  const normalizedCategory = String(category ?? '').trim().toLowerCase();
  if (normalizedCategory === 'secret' || normalizedCategory === 'secrets') return 'secrets';
  return undefined;
}

function taxonomyId(ruleId: string | undefined, category: string | undefined): string | undefined {
  return ruleId?.trim() || category?.trim() || undefined;
}

export function normalizeDeepSecFindings(entries: readonly ParsedDeepSecCommentOutEntry[]): readonly ReviewFinding[] {
  return entries.map((entry, index): ReviewFinding => {
    const startLine = entry.anchor.kind === 'line'
      ? entry.anchor.line
      : entry.anchor.kind === 'range'
        ? entry.anchor.startLine
        : undefined;
    const endLine = entry.anchor.kind === 'line'
      ? entry.anchor.line
      : entry.anchor.kind === 'range'
        ? entry.anchor.endLine
        : undefined;
    const filePath = 'filePath' in entry.anchor ? entry.anchor.filePath : undefined;
    const ruleId = entry.ruleId?.trim() || undefined;
    const taxonomy = taxonomyId(ruleId, entry.category);
    return {
      id: `deepsec-${index + 1}`,
      title: firstLine(entry.body),
      severity: mapSeverity(entry.severity),
      category: 'security',
      ...(filePath ? { filePath } : {}),
      ...(startLine && endLine ? { startLine, endLine } : {}),
      summary: entry.body,
      confidence: entry.confidence === 'high' ? 0.9 : 0.55,
      ...(ruleId ? { ruleId } : {}),
      ...(entry.category ? { deepsecCategory: entry.category } : {}),
      ...(taxonomy ? { taxonomy: { family: taxonomyFamily(ruleId, entry.category) ?? 'security', id: taxonomy } } : {}),
    };
  });
}
