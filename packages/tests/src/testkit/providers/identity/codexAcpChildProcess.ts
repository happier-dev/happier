import { basename } from 'node:path';

import {
  listProcessSnapshot,
  type ProcessSnapshotEntry,
} from '../../../../../../apps/cli/src/daemon/processSnapshotCache';
import {
  readProcessIdentityByPid,
} from '../../../../../../apps/cli/src/daemon/processIdentity';
import { tokenizeObservedProcessCommand } from './processCommand';

type ExactProcessIdentity = NonNullable<Awaited<ReturnType<typeof readProcessIdentityByPid>>>;

export type CodexAcpChildProcessObserverDependencies = Readonly<{
  listProcessSnapshot?: () => Promise<readonly ProcessSnapshotEntry[]>;
  readProcessIdentityByPid?: (pid: number) => Promise<ExactProcessIdentity | null>;
  expectedExecutable?: string;
}>;

function collectDescendantPids(
  runnerPid: number,
  processes: readonly ProcessSnapshotEntry[],
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid);
    if (children) children.push(process.pid);
    else childrenByParent.set(process.ppid, [process.pid]);
  }
  const descendants: number[] = [];
  const seen = new Set<number>();
  const queue = [...(childrenByParent.get(runnerPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function normalizedExecutableBasename(value: string): string {
  return basename(value.replaceAll('\\', '/')).toLowerCase();
}

function isExactCodexAcpIdentity(
  identity: ExactProcessIdentity,
  expectedExecutable: string,
): boolean {
  const expectedName = normalizedExecutableBasename(expectedExecutable);
  const expectedStem = expectedName.replace(/\.(?:cmd|exe)$/u, '');
  const allowedNames = new Set([
    expectedName,
    expectedStem,
    `${expectedStem}.cmd`,
    `${expectedStem}.exe`,
  ]);
  const tokens = tokenizeObservedProcessCommand(identity.command);
  const executableName = tokens[0]
    ? normalizedExecutableBasename(tokens[0])
    : '';
  if (allowedNames.has(executableName)) return true;

  if (executableName === 'node' || executableName === 'node.exe') {
    return Boolean(tokens[1] && allowedNames.has(normalizedExecutableBasename(tokens[1])));
  }
  if (new Set([
    'cmd',
    'cmd.exe',
    'powershell',
    'powershell.exe',
    'pwsh',
    'pwsh.exe',
    'sh',
    'bash',
    'zsh',
  ]).has(executableName)) {
    return tokens.some((token) => allowedNames.has(normalizedExecutableBasename(token)));
  }
  return false;
}

export async function observeExactCodexAcpChildProcess(
  params: Readonly<{ runnerPid: number }>,
  dependencies: CodexAcpChildProcessObserverDependencies = {},
): Promise<Readonly<{
  pid: number;
  processStartTimeMs: number;
}> | null> {
  const processes = await (dependencies.listProcessSnapshot ?? (
    async () => await listProcessSnapshot({ ttlMs: 0 })
  ))();
  const descendantPids = collectDescendantPids(params.runnerPid, processes);
  const readIdentity = dependencies.readProcessIdentityByPid ?? readProcessIdentityByPid;
  const configuredExecutable = dependencies.expectedExecutable
    ?? process.env.HAPPIER_CODEX_ACP_BIN?.trim();
  const expectedExecutable = configuredExecutable || 'codex-acp';
  const snapshotByPid = new Map(processes.map((process) => [process.pid, process] as const));
  const observations = await Promise.all(
    descendantPids.map(async (pid) => ({ pid, identity: await readIdentity(pid) })),
  );
  const matches = observations.flatMap(({ pid, identity }) => {
    const snapshot = snapshotByPid.get(pid);
    if (
      !identity
      || !snapshot
      || identity.ppid !== snapshot.ppid
      || !isExactCodexAcpIdentity(identity, expectedExecutable)
    ) {
      return [];
    }
    return [identity];
  });
  if (matches.length !== 1) return null;
  const [match] = matches;
  if (match.processStartTimeMs === undefined) return null;
  return {
    pid: match.pid,
    processStartTimeMs: match.processStartTimeMs,
  };
}
