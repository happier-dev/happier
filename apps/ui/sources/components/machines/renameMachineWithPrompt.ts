import { Modal } from '@/modal';
import { machineUpdateMetadata } from '@/sync/ops';
import { sync } from '@/sync/sync';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

export type RenameMachineOutcome = 'renamed' | 'cancelled' | 'failed';

/**
 * The shared machine-rename flow: prompts for a display name, persists it through
 * `machineUpdateMetadata` at the machine's current metadata version, and on failure alerts and
 * refreshes machines so the caller sees the server's latest state. Cancelling the prompt changes
 * nothing. A successful write updates the machine store optimistically, so alias-driven UI
 * (strip chips, detail header) follows automatically.
 */
export async function renameMachineWithPrompt(machine: Machine): Promise<RenameMachineOutcome> {
    const newDisplayName = await Modal.prompt(
        t('machine.renameTitle'),
        t('machine.renameDescription'),
        {
            defaultValue: machine.metadata?.displayName || '',
            placeholder: machine.metadata?.host || t('machine.renamePlaceholder'),
            cancelText: t('common.cancel'),
            confirmText: t('common.rename'),
        },
    );

    if (newDisplayName === null) return 'cancelled';

    try {
        await machineUpdateMetadata(
            machine.id,
            {
                ...machine.metadata!,
                displayName: newDisplayName.trim() || undefined,
            },
            machine.metadataVersion,
        );
        return 'renamed';
    } catch (error) {
        Modal.alert(
            t('common.error'),
            error instanceof Error ? error.message : t('machine.renameFailed'),
        );
        await sync.refreshMachines();
        return 'failed';
    }
}
