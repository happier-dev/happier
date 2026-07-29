import type { BrowserViewTargetV1 } from '@happier-dev/protocol';

export type BrowserRecentTarget = Readonly<{
    target: BrowserViewTargetV1;
    openedAt: number;
}>;

export function rememberBrowserRecentTarget(
    recents: readonly BrowserRecentTarget[],
    input: BrowserRecentTarget,
    maxEntries = 12,
): readonly BrowserRecentTarget[] {
    const next = [
        input,
        ...recents.filter((entry) => entry.target.targetId !== input.target.targetId),
    ];
    return next.slice(0, Math.max(1, maxEntries));
}
