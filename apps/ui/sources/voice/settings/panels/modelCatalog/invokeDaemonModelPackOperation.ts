import type { SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { DaemonVoiceInferenceClient, DaemonVoiceInferenceModelMachineScope } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import type { ModelCatalogRow } from './buildModelCatalogRows';

/** UI and Actions share eligibility, consent and exact-machine mutation admission. */
export async function invokeDaemonModelPackOperation(input: Readonly<{
    operation: 'install' | 'remove';
    row: ModelCatalogRow;
    client: Pick<DaemonVoiceInferenceClient, 'installModel' | 'acceptModelPackLicense' | 'removeModel'>;
    scope?: DaemonVoiceInferenceModelMachineScope;
    signal?: AbortSignal;
    isCurrent(): boolean | Promise<boolean>;
}>): Promise<SettingOperationResult> {
    const current = async () => {
        const admitted = await input.isCurrent();
        return admitted && !input.signal?.aborted;
    };
    const { row, client, scope } = input;
    if (!await current()) return { status: 'cancelled' };
    if (input.operation === 'remove') {
        if (!row.canRemove) return { status: 'unavailable', reason: 'model_not_installed' };
        const confirmed = await Modal.confirm(t('settingsVoice.local.models.removeConfirmTitle'),
            t('settingsVoice.local.models.removeConfirmBody', { name: row.displayName }),
            { confirmText: t(row.state === 'error' ? 'common.discard' : 'common.remove'), destructive: true });
        if (!confirmed || !await current()) return { status: 'cancelled' };
        if (scope) await client.removeModel(row.packId, scope);
        else await client.removeModel(row.packId);
    } else {
        if (!row.canInstall) return { status: 'unavailable', reason: row.state === 'downloading' ? 'model_install_in_progress' : 'model_install_unavailable' };
        const review = row.licenseReview;
        if (review && !review.accepted) {
            const accepted = await Modal.confirm(review.licenseTitle, review.licenseText, { confirmText: t('common.continue') });
            if (!accepted || !await current()) return { status: 'cancelled' };
            const license = { qualifiedPackId: `${review.pluginId}/${review.packId}`, pluginId: review.pluginId,
                packId: review.packId, pluginVersion: review.pluginVersion, packVersion: review.packVersion,
                licenseId: review.licenseId, licenseSourceUrl: review.licenseSourceUrl,
                licenseTextDigest: review.licenseTextDigest, artifactBinding: review.artifactBinding };
            if (scope) await client.acceptModelPackLicense(license, scope);
            else await client.acceptModelPackLicense(license);
        }
        if (!await current()) return { status: 'cancelled' };
        if (scope) await client.installModel({ packId: row.packId, signal: input.signal }, scope);
        else await client.installModel({ packId: row.packId, signal: input.signal });
    }
    return await current() ? { status: 'completed', value: { packId: row.packId } } : { status: 'cancelled' };
}
