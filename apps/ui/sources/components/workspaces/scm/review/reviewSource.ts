import type { ScmComparison } from '@happier-dev/protocol/scm';

/** Captured paths are repository-relative; live paths use the current workspace base. */
export function fileBaseOfReviewSource(comparison: ScmComparison | null | undefined, liveRoot: string): string {
    return comparison?.repository.rootPath ?? liveRoot;
}
