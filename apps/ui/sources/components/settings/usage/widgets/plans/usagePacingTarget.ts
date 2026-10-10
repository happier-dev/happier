
export { readUsagePersonalPaceTarget, setUsagePersonalPaceTarget } from '@happier-dev/protocol/actions/settings/accountSettingChoiceReducers';

/** "Account · window" for each window whose current pace ends its window above the target. Unknown pace says nothing. */
export function selectUsageWindowsAboveTarget(
    accounts: readonly Readonly<{ title: string; windows: readonly Readonly<{ label: string; pace: Readonly<{ projectedUsedFraction: number }> | null }>[] }>[],
    fraction: number,
): string[] {
    return accounts.flatMap((account) => account.windows
        .filter((window) => window.pace !== null && window.pace.projectedUsedFraction > fraction)
        .map((window) => `${account.title} · ${window.label}`));
}
