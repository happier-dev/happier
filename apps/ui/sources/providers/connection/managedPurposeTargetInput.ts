import {
    QualifiedConnectedAccountPurposeBindingTargetV1Schema,
    type PluginContributionIdentityV1,
    type QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';

export function formatManagedPurposeTargetInput(
    target: QualifiedConnectedAccountPurposeBindingTargetV1,
): string {
    return target.kind === 'account'
        ? `account:${target.account.accountId}`
        : `group:${target.groupId}`;
}

export function parseManagedPurposeTargetInput(input: Readonly<{
    input: string;
    service: PluginContributionIdentityV1;
}>): QualifiedConnectedAccountPurposeBindingTargetV1 | null {
    const match = /^(account|group):(.*)$/u.exec(input.input.trim());
    if (!match) return null;
    const id = match[2]?.trim();
    if (!id) return null;
    const parsed =
        QualifiedConnectedAccountPurposeBindingTargetV1Schema.safeParse(
            match[1] === 'account'
                ? {
                    kind: 'account',
                    account: { service: input.service, accountId: id },
                }
                : { kind: 'group', service: input.service, groupId: id },
        );
    return parsed.success ? parsed.data : null;
}
