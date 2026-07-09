export type UnsupportedAccountUsage<Reason extends string> = Readonly<{
    status: 'unsupported';
    reason: Reason;
    displayGauge: false;
    canonicalRecord: null;
}>;

export function unsupportedAccountUsage<const Reason extends string>(
    reason: Reason,
): UnsupportedAccountUsage<Reason> {
    return {
        status: 'unsupported',
        reason,
        displayGauge: false,
        canonicalRecord: null,
    };
}
