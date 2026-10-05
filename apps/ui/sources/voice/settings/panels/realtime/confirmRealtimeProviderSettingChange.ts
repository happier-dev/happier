import { Modal } from '@/modal';
import { tLoose } from '@/text';
import type { RealtimeSettingsFieldDescriptor } from './descriptor';

function translate(value: unknown, fallback = ''): string {
    if (typeof value === 'string' && value.length > 0) return tLoose(value);
    if (value && typeof value === 'object' && 'fallback' in value && typeof value.fallback === 'string') return value.fallback;
    return fallback;
}

/** One consent owner for curated controls and exact declaration mutations. */
export async function confirmRealtimeProviderSettingChange(input: Readonly<{
    field: RealtimeSettingsFieldDescriptor;
    value: unknown;
    isCurrent(): boolean;
    signal?: AbortSignal;
}>): Promise<boolean> {
    const { field, value } = input;
    if (input.signal?.aborted || !input.isCurrent()) return false;
    let confirmation: Readonly<{ title: string; body: string; action: string }> | null = null;
    if (field.kind === 'model' && field.movingAliasRequiresOptIn === true
        && value && typeof value === 'object' && 'kind' in value && value.kind === 'moving_alias') {
        confirmation = { title: tLoose('settingsVoice.realtimeProviders.movingAlias.confirmTitle'),
            body: tLoose('settingsVoice.realtimeProviders.movingAlias.confirmBody'), action: tLoose('settingsVoice.realtimeProviders.movingAlias.confirmAction') };
    } else if (field.kind === 'privacy_opt_in' && value === true) {
        confirmation = { title: tLoose('settingsVoice.realtimeProviders.resumption.confirmTitle'),
            body: tLoose('settingsVoice.realtimeProviders.resumption.confirmBody').replace('{minutes}', String(field.retentionMinutes ?? 0)),
            action: tLoose('settingsVoice.realtimeProviders.resumption.confirmAction') };
    } else if (field.requiresOptIn === true && value !== null) {
        confirmation = { title: translate(field.confirmTitleKey, translate(field.titleKey)),
            body: translate(field.confirmBodyKey, translate(field.subtitleKey)), action: translate(field.confirmActionKey, tLoose('common.enable')) };
    }
    if (!confirmation) return true;
    const approved = await Modal.confirm(confirmation.title, confirmation.body, { confirmText: confirmation.action });
    return approved && !input.signal?.aborted && input.isCurrent();
}
