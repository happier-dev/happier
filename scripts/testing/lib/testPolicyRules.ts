import { findDeprecatedImportMatches } from '../migrations/lib/deprecatedImportRules.ts';
import { type EnforcementMode, type InventoryFile } from '../migrations/lib/migrationTypes.ts';
import {
  countActiveServerSnapshotEmptyMemoReads,
  countActiveServerSnapshotRefInitializerReads,
  countActiveServerSnapshotStateInitializerReads,
  countDirectDetachedSpawnCalls,
  isCanonicalTestSpawnHelperPath,
  isTestPolicyFile,
  stripStringsAndComments,
} from './testPolicySurface.ts';
import { collectInlineMockFamilyStats, type InlineMockFamilyName } from '../../../apps/ui/tools/migrations/inlineMockClassifier.ts';

export interface PolicyFinding {
  ruleId: string;
  mode: EnforcementMode;
  filePath: string;
  message: string;
}

export interface PolicyFindingReport {
  findings: readonly PolicyFinding[];
}

function hasPattern(content: string, pattern: RegExp): boolean {
  return pattern.test(content);
}

function isUiTestPolicyFile(filePath: string): boolean {
  return isTestPolicyFile(filePath) && filePath.startsWith('apps/ui/sources/');
}

function isProviderProbeTestFile(filePath: string): boolean {
  return filePath.startsWith('packages/tests/suites/providers/') || filePath.includes('.realProbe.');
}

function summarizeInlineMockFamilies(
  familyStats: ReturnType<typeof collectInlineMockFamilyStats>,
  selector: (stats: ReturnType<typeof collectInlineMockFamilyStats>[InlineMockFamilyName]) => number,
): string {
  const families = (Object.keys(familyStats) as InlineMockFamilyName[])
    .map((family) => [family, selector(familyStats[family])] as const)
    .filter(([, count]) => count > 0)
    .map(([family, count]) => `${family}=${count}`);

  return families.join(', ');
}

function shouldReportUiTreeWalk(file: InventoryFile, codeText: string): boolean {
  if (!isUiTestPolicyFile(file.filePath)) {
    return false;
  }

  const usesCanonicalHarness = (
    file.content.includes('@/dev/testkit') ||
    hasPattern(codeText, /\brenderScreen\(/) ||
    hasPattern(codeText, /\bstandardCleanup\(/)
  );
  if (!usesCanonicalHarness) {
    return false;
  }

  return hasPattern(
    codeText,
    /\.root\.(?:findAllByType|findByType|findAllByProps|findByProps|findAll|find)\(|\.props\.onPress\(|findAllByType\((?:'|")Pressable|findByType\((?:'|")Pressable/,
  );
}

export function collectPolicyFindings(files: readonly InventoryFile[]): PolicyFindingReport {
  const findings: PolicyFinding[] = [];

  for (const file of files) {
    const testFile = isTestPolicyFile(file.filePath);
    const codeText = stripStringsAndComments(file.content);
    const detachedSpawnCount =
      testFile && !isCanonicalTestSpawnHelperPath(file.filePath)
        ? countDirectDetachedSpawnCalls(file.filePath, file.content)
        : 0;

    if (testFile && hasPattern(codeText, /\b(?:it|test|describe)\.only\s*\(/)) {
      findings.push({
        ruleId: 'no-exclusive-tests',
        mode: 'enforce',
        filePath: file.filePath,
        message: 'Focused tests are forbidden in committed test files.',
      });
    }

    if (testFile && hasPattern(codeText, /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/)) {
      findings.push({
        ruleId: 'no-skipped-or-todo-tests',
        mode: 'report-only',
        filePath: file.filePath,
        message: 'Skipped or todo tests are forbidden in committed test files.',
      });
    }

    if (testFile && hasPattern(codeText, /\b(?:const|let|var)\s+\w+\s*=\s*[^?\n]*\?\s*(?:it|test|describe)\s*:\s*(?:it|test|describe)\.skip\b/)) {
      findings.push({
        ruleId: 'no-hidden-skip-alias',
        mode: isProviderProbeTestFile(file.filePath) ? 'report-only' : 'enforce',
        filePath: file.filePath,
        message: 'Hidden skip aliases are forbidden in test files.',
      });
    }

    if (testFile && hasPattern(codeText, /\bconsole\.(?:log|warn|error|info)\s*\(/)) {
      findings.push({
        ruleId: 'no-console-in-tests',
        mode: 'report-only',
        filePath: file.filePath,
        message: 'Direct console logging is forbidden in test files.',
      });
    }

    if (detachedSpawnCount > 0) {
      findings.push({
        ruleId: 'no-raw-detached-background-test-spawn',
        mode: 'enforce',
        filePath: file.filePath,
        message: 'Detached background test processes must use the canonical test spawn helpers instead of raw child_process.spawn.',
      });
    }

    if (!testFile && hasPattern(file.content, /@happier-dev\/tests\//)) {
      findings.push({
        ruleId: 'no-testkit-imports-in-runtime',
        mode: 'enforce',
        filePath: file.filePath,
        message: 'Non-test source must not import @happier-dev/tests internals.',
      });
    }

    if (
      file.filePath.startsWith('apps/ui/sources/')
      && countActiveServerSnapshotEmptyMemoReads(file.filePath, file.content) > 0
    ) {
      findings.push({
        ruleId: 'no-active-server-snapshot-empty-memo',
        mode: 'enforce',
        filePath: file.filePath,
        message: 'Active server snapshots must not be captured in empty React useMemo dependencies; use useActiveServerSnapshot or include a reactive dependency.',
      });
    }

    if (
      file.filePath.startsWith('apps/ui/sources/')
      && countActiveServerSnapshotStateInitializerReads(file.filePath, file.content) > 0
    ) {
      findings.push({
        ruleId: 'no-active-server-snapshot-state-capture',
        mode: 'enforce',
        filePath: file.filePath,
        message: 'Active server snapshots must not be captured in React state initializers; use useActiveServerSnapshot or useSyncExternalStore.',
      });
    }

    if (
      file.filePath.startsWith('apps/ui/sources/')
      && countActiveServerSnapshotRefInitializerReads(file.filePath, file.content) > 0
    ) {
      findings.push({
        ruleId: 'no-active-server-snapshot-ref-capture',
        mode: 'enforce',
        filePath: file.filePath,
        message: 'Active server snapshots must not be captured in React ref initializers; use useActiveServerSnapshot or capture inside the event that needs the current value.',
      });
    }

    if (isUiTestPolicyFile(file.filePath)) {
      const familyStats = collectInlineMockFamilyStats(file.content, { filePath: file.filePath });
      const totalInlineMocks = summarizeInlineMockFamilies(familyStats, (stats) => stats.total);
      const adHocInlineMocks = summarizeInlineMockFamilies(familyStats, (stats) => stats.adHoc);

      if (adHocInlineMocks.length > 0) {
        findings.push({
          ruleId: 'no-ui-ad-hoc-inline-mock-family',
          mode: 'enforce',
          filePath: file.filePath,
          message: `Ad hoc UI inline mock families must use the canonical testkit shape (${adHocInlineMocks}).`,
        });
      }

      if (totalInlineMocks.length > 0) {
        findings.push({
          ruleId: 'ui-inline-mock-family-report',
          mode: 'report-only',
          filePath: file.filePath,
          message: `UI inline mock families remain in this file (${totalInlineMocks}).`,
        });
      }

      if (shouldReportUiTreeWalk(file, codeText)) {
        findings.push({
          ruleId: 'no-direct-ui-tree-walk-when-harness-exists',
          mode: 'report-only',
          filePath: file.filePath,
          message: 'Direct UI tree walking should be removed once a canonical harness already exists in the file.',
        });
      }
    }

    for (const match of findDeprecatedImportMatches(file.filePath, file.content)) {
      findings.push({
        ruleId: match.rule.id,
        mode: match.rule.mode,
        filePath: file.filePath,
        message: `Deprecated import ${match.rule.from} should be replaced with ${match.rule.replacement ?? 'a canonical helper'}.`,
      });
    }
  }

  return { findings };
}
