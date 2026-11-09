import type { ScmStashEntry } from '@happier-dev/protocol/scm';

/** Current Git entries use captured objects; ref-only historical entries retain their explicit Details path. */
export function resolveScmStashIdentity(entry: Pick<ScmStashEntry, 'stashOid' | 'stashRef'>): string {
    return entry.stashOid || entry.stashRef;
}
