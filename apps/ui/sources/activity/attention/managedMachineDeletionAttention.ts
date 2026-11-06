import { resolveProviderDeletionReminderV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

/** Called when the app opens; advancing time does not start a timer or native read. */
export function readManagedMachineDeletionAttention(
    input: Parameters<typeof resolveProviderDeletionReminderV1>[0],
): ReturnType<typeof resolveProviderDeletionReminderV1> {
    const reminder = resolveProviderDeletionReminderV1(input);
    return reminder?.due ? reminder : null;
}
