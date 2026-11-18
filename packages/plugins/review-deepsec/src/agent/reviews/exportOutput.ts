import { normalizeSafeOutputPath, type ParsedDeepSecCommentOutEntry } from './commentOut.js';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** DeepSec 2.3.12 export --format json --out: a JSON array, without console progress. */
export function parseDeepSecExport(json: string): readonly ParsedDeepSecCommentOutEntry[] {
  const findings: unknown = JSON.parse(json);
  if (!Array.isArray(findings)) throw new Error('DeepSec export did not contain a findings array.');
  return findings.map((value: unknown): ParsedDeepSecCommentOutEntry => {
    const finding = record(value);
    const metadata = record(finding?.metadata);
    const filePath = typeof metadata?.filePath === 'string' ? normalizeSafeOutputPath(metadata.filePath) : null;
    const title = typeof finding?.title === 'string' ? finding.title.trim() : '';
    const description = typeof finding?.description === 'string' ? finding.description.trim() : '';
    const severity = typeof finding?.severity === 'string' ? finding.severity.trim() : '';
    const lines: unknown = metadata?.lineNumbers;
    if (!filePath || !title || !description || !severity || !Array.isArray(lines)
      || lines.some(line => typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1)) {
      throw new Error('DeepSec export contained an invalid finding.');
    }
    const lineNumbers = lines as number[];
    let firstLine: number | undefined;
    let lastLine: number | undefined;
    for (const line of lineNumbers) {
      firstLine = firstLine === undefined ? line : Math.min(firstLine, line);
      lastLine = lastLine === undefined ? line : Math.max(lastLine, line);
    }
    const prefix = `[${severity}] `;
    return {
      anchor: firstLine === undefined ? { kind: 'file', filePath }
        : lastLine !== undefined && lastLine > firstLine ? { kind: 'range', filePath, startLine: firstLine, endLine: lastLine }
          : { kind: 'line', filePath, line: firstLine },
      severity,
      ...(typeof metadata?.vulnSlug === 'string' && metadata.vulnSlug.trim() ? { ruleId: metadata.vulnSlug.trim() } : {}),
      body: `${title.startsWith(prefix) ? title.slice(prefix.length) : title}\n\n${description}`,
      confidence: firstLine === undefined ? 'low' : 'high',
      tags: firstLine === undefined ? ['deepsec.low_confidence_anchor'] : [],
    };
  });
}
