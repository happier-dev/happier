import { type DeprecatedImportRule } from './migrationTypes.ts';

export const DEPRECATED_IMPORT_RULES: readonly DeprecatedImportRule[] = Object.freeze([
  {
    id: 'deprecated-import:test-report-only',
    mode: 'report-only',
    scope: 'tests-only',
    from: '@/dev/testkit/testUiMocks',
    replacement: '@/sources/dev/testkit/createUiTestHarness',
    rationale: 'Use the canonical UI test harness instead of the deprecated mock bundle.',
  },
  {
    id: 'deprecated-import:root-layout-report-only',
    mode: 'report-only',
    scope: 'tests-only',
    from: '@/dev/testkit/rootLayoutTestkit',
    replacement: '@/sources/dev/testkit/createRootLayoutHarness',
    rationale: 'Use the canonical root-layout harness entrypoint instead of the deprecated helper.',
  },
]);

export interface DeprecatedImportMatch {
  rule: DeprecatedImportRule;
  specifier: string;
}

function isTestFile(filePath: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

function extractImportSpecifiers(content: string): string[] {
  const matches = content.matchAll(/(?:from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"])/g);
  return Array.from(matches, (match) => match[1] ?? match[2] ?? '').filter(Boolean);
}

export function findDeprecatedImportMatches(filePath: string, content: string): DeprecatedImportMatch[] {
  if (filePath.startsWith('scripts/testing/')) {
    return [];
  }

  const specifiers = extractImportSpecifiers(content);
  return DEPRECATED_IMPORT_RULES.flatMap((rule) => {
    if (rule.scope === 'tests-only' && !isTestFile(filePath)) {
      return [];
    }

    return specifiers
      .filter((specifier) => specifier === rule.from)
      .map((specifier) => ({
        rule,
        specifier,
      }));
  });
}
