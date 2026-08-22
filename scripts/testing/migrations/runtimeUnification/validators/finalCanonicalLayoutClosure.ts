import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const VALIDATOR_ID = 'F.7-final-canonical-layout-closure';

export interface FinalCanonicalLayoutClosureResult {
  validatorId: typeof VALIDATOR_ID;
  ok: boolean;
  errors: readonly string[];
  scannedFiles: readonly string[];
}

type PathCheck = Readonly<{
  rowId: string;
  path: string;
  kind: 'file' | 'directory';
  expected: 'present' | 'absent';
  detail: string;
}>;

const F7_PATH_CHECKS: readonly PathCheck[] = Object.freeze([
  {
    rowId: 'STR-00189',
    path: 'apps/cli/src/agent/permissions/permissionRequestCoordinator.ts',
    kind: 'file',
    expected: 'present',
    detail: 'canonical permissions coordinator owner must remain in place',
  },
  {
    rowId: 'STR-00380',
    path: 'apps/cli/src/agent/systemTasks',
    kind: 'directory',
    expected: 'absent',
    detail: 'stale agent/systemTasks citation must not be recreated',
  },
  {
    rowId: 'STR-00380',
    path: 'apps/cli/src/capabilities/systemTasks',
    kind: 'directory',
    expected: 'present',
    detail: 'system task runtime owner must stay under capabilities/systemTasks',
  },
  {
    rowId: 'STR-00380',
    path: 'apps/cli/src/capabilities/registry/toolSystemTasks.ts',
    kind: 'file',
    expected: 'present',
    detail: 'system task tool registry owner must stay under capabilities/registry',
  },
  {
    rowId: 'STR-04509',
    path: 'packages/protocol/src/runtimeEvents',
    kind: 'directory',
    expected: 'absent',
    detail: 'stale protocol runtimeEvents folder must not be recreated',
  },
  {
    rowId: 'STR-04509',
    path: 'packages/protocol/src/runtime/events/v1.ts',
    kind: 'file',
    expected: 'absent',
    detail: 'retired generic RuntimeEventV1 owner must not be recreated',
  },
  {
    rowId: 'STR-04509',
    path: 'packages/protocol/src/runtime/agentSessionV1.ts',
    kind: 'file',
    expected: 'present',
    detail: 'canonical AgentSessionRuntimeEventV1 owner must stay under runtime',
  },
]);

export function validateFinalCanonicalLayoutClosure(options?: Readonly<{
  rootDir?: string;
}>): FinalCanonicalLayoutClosureResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const errors: string[] = [];
  const scannedFiles: string[] = [];

  for (const check of F7_PATH_CHECKS) {
    scannedFiles.push(check.path);
    const absolutePath = resolve(rootDir, check.path);
    const existsWithExpectedKind = pathExistsWithKind(absolutePath, check.kind);
    if (check.expected === 'present' && !existsWithExpectedKind) {
      errors.push(`${check.rowId}: missing ${check.kind} ${check.path}; ${check.detail}.`);
    }
    if (check.expected === 'absent' && existsWithExpectedKind) {
      errors.push(`${check.rowId}: stale ${check.kind} still exists at ${check.path}; ${check.detail}.`);
    }
  }

  return {
    validatorId: VALIDATOR_ID,
    ok: errors.length === 0,
    errors,
    scannedFiles,
  };
}

function pathExistsWithKind(path: string, kind: 'file' | 'directory'): boolean {
  if (!existsSync(path)) {
    return false;
  }
  const stats = statSync(path);
  return kind === 'file' ? stats.isFile() : stats.isDirectory();
}
