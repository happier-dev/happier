import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';

export type BrowserRecentTarget = Readonly<{
    target: BrowserViewTargetV1;
    openedAt: number;
}>;

export function rememberBrowserRecentTarget(
    recents: readonly BrowserRecentTarget[],
    input: BrowserRecentTarget,
): readonly BrowserRecentTarget[] {
    return [
        input,
        ...recents.filter((entry) => entry.target.targetId !== input.target.targetId),
    ];
}
