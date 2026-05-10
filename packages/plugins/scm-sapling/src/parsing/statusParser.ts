import type { ScmWorkingEntry } from '@happier-dev/protocol';

export type SaplingStatusEntry = {
    kind: ScmWorkingEntry['kind'];
    path: string;
    pendingStatus: string;
};

export function parseSaplingStatusLine(rawLine: string): SaplingStatusEntry | null {
    const line = rawLine.trimEnd();
    if (!line) return null;
    const status = line[0];
    if (!status) return null;
    const path = line.slice(2);
    if (!path) return null;

    if (status === '?') {
        return { kind: 'untracked', path, pendingStatus: '?' };
    }
    if (status === 'A') {
        return { kind: 'added', path, pendingStatus: 'A' };
    }
    if (status === 'R' || status === '!') {
        return { kind: 'deleted', path, pendingStatus: 'D' };
    }
    if (status === 'U') {
        return { kind: 'conflicted', path, pendingStatus: 'U' };
    }
    if (status === 'M') {
        return { kind: 'modified', path, pendingStatus: 'M' };
    }
    return { kind: 'modified', path, pendingStatus: status };
}
