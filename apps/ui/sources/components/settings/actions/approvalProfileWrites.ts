import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionPolicySetInput } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import type { ApprovalProfileV1 } from '@happier-dev/protocol/actions';
import type { ReadableApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { ApprovalProfileArtifactChangeResultV1Schema, toApprovalProfileContentV1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';

import { Modal } from '@/modal';
import { t } from '@/text';

/** The Account policy writer (`actions.policy.set`): profile edits are ordinary policy intents. */
export type ApprovalProfileWriter = (input: ActionPolicySetInput) => Promise<ActionExecuteResult>;

function reportFailure(result: ActionExecuteResult): boolean {
    if (result.ok) return true;
    Modal.alert(t('common.error'), t('workflows.triggers.guided.profile.saveFailed'));
    return false;
}

/** Name a new profile and save it: Blank follows the Account everywhere; a copy starts with the source's changes. */
export async function createApprovalProfileFromStart(write: ApprovalProfileWriter,
    source: ApprovalProfileV1 | null): Promise<ApprovalProfileV1 | null> {
    const name = (await Modal.prompt(t('workflows.triggers.guided.profile.nameTitle'), undefined, {
        placeholder: t('workflows.triggers.guided.profile.namePlaceholder'),
        defaultValue: source ? t('workflows.triggers.guided.profile.startCopyOf', { name: source.name }) : '',
        confirmText: t('common.create'),
    }))?.trim();
    if (!name) return null;
    const profile = source ? { ...toApprovalProfileContentV1(source), name } : { name };
    const result = await write({ profileChange: { kind: 'create', profile } });
    if (!result.ok) {
        reportFailure(result);
        return null;
    }
    const receipt = ApprovalProfileArtifactChangeResultV1Schema.safeParse(
        result.result && typeof result.result === 'object' && 'profileChange' in result.result
            ? result.result.profileChange : undefined,
    );
    if (!receipt.success || receipt.data.kind !== 'create') {
        Modal.alert(t('common.error'), t('workflows.triggers.guided.profile.saveFailed'));
        return null;
    }
    return { ...profile, id: receipt.data.id };
}

export async function renameApprovalProfile(write: ApprovalProfileWriter, row: ReadableApprovalProfileV1): Promise<void> {
    const profile = row.profile;
    const name = (await Modal.prompt(t('workflows.triggers.guided.profile.renameTitle'), undefined, {
        defaultValue: profile.name, confirmText: t('common.save'),
    }))?.trim();
    if (!name || name === profile.name) return;
    reportFailure(await write({ profileChange: { kind: 'update', id: row.id, expectedRevision: row.revision,
        profile: { ...toApprovalProfileContentV1(profile), name } } }));
}

/** The stored Session reference becomes missing, so its approvals follow the Account settings. */
export async function confirmDeleteApprovalProfile(write: ApprovalProfileWriter, row: ReadableApprovalProfileV1): Promise<boolean> {
    const confirmed = await Modal.confirm(t('workflows.triggers.guided.profile.deleteTitle'),
        t('workflows.triggers.guided.profile.deleteMessage'),
        { confirmText: t('common.delete'), destructive: true });
    if (!confirmed) return false;
    return reportFailure(await write({ profileChange: { kind: 'delete', id: row.id, expectedRevision: row.revision } }));
}

/** My Sessions on this Machine use this profile by default (null: the Account settings). */
export async function setApprovalProfileMachineDefault(write: ApprovalProfileWriter, machineId: string,
    profileId: string | null): Promise<boolean> {
    return reportFailure(await write({ profileChange: { kind: 'machine_default', machineId, id: profileId } }));
}
