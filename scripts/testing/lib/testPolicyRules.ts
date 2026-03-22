import { findDeprecatedImportMatches } from '../migrations/lib/deprecatedImportRules.ts';
import { type EnforcementMode, type InventoryFile } from '../migrations/lib/migrationTypes.ts';
import {
  countDirectDetachedSpawnCalls,
  isCanonicalTestSpawnHelperPath,
  isTestPolicyFile,
  stripStringsAndComments,
} from './testPolicySurface.ts';

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
        mode: 'report-only',
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
