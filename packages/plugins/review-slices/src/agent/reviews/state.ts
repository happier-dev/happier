import type { ReviewFinding } from '@happier-dev/plugin-sdk/reviews';

export type SliceFindingEvidence = Readonly<{
  findingId: string; nativeFindingId: string; runId: string; featureId: string;
  confidence: 'high' | 'medium' | 'low';
  locations: readonly Readonly<{ path: string; startLine: number | null; endLine: number | null; symbol: string | null; quote: string | null }>[];
  reproduction: string | null; whyTestsDoNotAlreadyCoverThis: string | null;
  suggestedRegressionTest: string | null; minimumFixScope: string | null;
}>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native slice document');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid native slice text');
  return value;
}
function nullableText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return text(value);
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid native slice list');
  return value;
}
function line(value: unknown): number | null {
  if (value === null || value === 0) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid native slice location');
  return value;
}
function versioned(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (result.schemaVersion !== 1) throw new Error('Unsupported native slice document version');
  return result;
}

export function readSliceSelection(value: unknown): Readonly<{ featureId: string; status: string }> {
  const native = versioned(value);
  return { featureId: text(native.featureId), status: text(native.status) };
}

export function readSliceRun(value: unknown, expectedId: string) {
  const native = versioned(value);
  if (native.runId !== expectedId) throw new Error('Native slice run identity mismatch');
  return { status: text(native.status), findingIds: array(native.findingIds).map(text),
    errors: array(native.errors).map(value => { const error = record(value); return { message: text(error.message), code: nullableText(error.code) }; }) };
}

const categories: Readonly<Record<string, ReviewFinding['category']>> = {
  bug: 'correctness', security: 'security', performance: 'performance', concurrency: 'correctness',
  'api-contract': 'correctness', 'data-loss': 'correctness', 'test-gap': 'testing', 'docs-gap': 'docs',
  'build-release': 'maintainability', maintainability: 'maintainability',
};
const severities: Readonly<Record<string, ReviewFinding['severity']>> = { critical: 'blocker', high: 'high', medium: 'medium', low: 'low' };

/** Parse only at the external native-state boundary; no native decisions are
 * written back to Happier's finding/Review owners. */
export function readSliceFinding(value: unknown, expectedId: string, runId: string, index: number): Readonly<{ finding: ReviewFinding; evidence: SliceFindingEvidence }> {
  const native = versioned(value);
  if (native.findingId !== expectedId) throw new Error('Native slice finding identity mismatch');
  const categoryKey = text(native.category); const severityKey = text(native.severity);
  const category = Object.hasOwn(categories, categoryKey) ? categories[categoryKey] : undefined;
  const severity = Object.hasOwn(severities, severityKey) ? severities[severityKey] : undefined;
  if (!category || !severity) throw new Error('Unsupported native slice classification');
  const confidence = native.confidence;
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') throw new Error('Unsupported native slice confidence');
  const locations = array(native.evidence).map(value => {
    const location = record(value); const startLine = line(location.startLine); const endLine = line(location.endLine);
    return { path: text(location.path), startLine: startLine && endLine ? startLine : null,
      endLine: startLine && endLine ? endLine : null, symbol: nullableText(location.symbol), quote: nullableText(location.quote) };
  });
  const primary = locations[0];
  const suggestion = nullableText(native.recommendation);
  const finding: ReviewFinding = { id: `slices-${index + 1}`, title: text(native.title), summary: text(native.reasoning), category, severity,
    ...(primary ? { filePath: primary.path, ...(primary.startLine ? { startLine: primary.startLine, endLine: primary.endLine! } : {}) } : {}),
    ...(suggestion ? { suggestion } : {}),
    ...(locations.length ? { evidence: locations.map(item => [item.path, item.symbol, item.quote].filter(Boolean).join(': ')).join('\n') } : {}) };
  return { finding, evidence: { findingId: finding.id, nativeFindingId: expectedId, runId, featureId: text(native.featureId), confidence, locations,
    reproduction: nullableText(native.reproduction), whyTestsDoNotAlreadyCoverThis: nullableText(native.whyTestsDoNotAlreadyCoverThis),
    suggestedRegressionTest: nullableText(native.suggestedRegressionTest), minimumFixScope: nullableText(native.minimumFixScope) } };
}
