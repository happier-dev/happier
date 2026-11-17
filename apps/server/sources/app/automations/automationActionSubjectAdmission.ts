import {
    isPluginAutomationActionSubjectV1,
    readPluginAutomationSubjectV1,
} from '@happier-dev/protocol/automations/automationPluginSubjectV1';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { readCurrentPluginDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import type { Tx } from '@/storage/inTx';
import { AutomationValidationError } from './automationValidation';

/** Public trigger writes admit the same declared plugin operand as Action authoring. */
export async function assertAutomationActionSubjectInTx(tx: Tx, input: Readonly<{
    accountId: string;
    actionIds: readonly string[];
    subject?: AutomationSubjectV1;
}>): Promise<void> {
    const subject = input.subject;
    if (subject?.kind !== 'plugin') return;
    const pluginId = subject.pluginId;
    const intent = await tx.accountPluginIntent.findUnique({
        where: { accountId_pluginId: { accountId: input.accountId, pluginId } },
        select: { enabled: true, desiredVersion: true, releaseLessDeclaration: true },
    });
    const release = intent?.desiredVersion ? await tx.accountPluginRelease.findUnique({
        where: { accountId_pluginId_version: { accountId: input.accountId, pluginId, version: intent.desiredVersion } },
        select: { version: true, normalizedManifest: true, archiveDigestSha256: true },
    }) : null;
    const declaration = readCurrentPluginDeclarationV1({ pluginId, intent, release });
    const supported = input.actionIds.some(actionId => {
        const ref = parseQualifiedPluginActionId(actionId);
        if (ref?.pluginId !== pluginId) return false;
        const action = declaration?.manifest.contributes.actions.find(candidate => candidate.id === ref.localId);
        return action !== undefined && isPluginAutomationActionSubjectV1(subject, { pluginId, approvalScope: action.approvalScope });
    });
    if (!supported) throw new AutomationValidationError('subject_kind_unavailable');
    const admitted = readPluginAutomationSubjectV1({ ...subject,
        subjectKinds: (declaration?.manifest.contributes.subjectKinds ?? []).map(definition => ({ pluginId, definition })),
    });
    if (!admitted.ok) throw new AutomationValidationError(admitted.code);
}
