import { t } from '@/text';

export function buildSshHostKeyPromptBody(params: Readonly<{
    host: string;
    fingerprint: string;
    existingFingerprint?: string | null;
}>): string {
    const lines = [params.host.trim()].filter(Boolean);
    const existingFingerprint = params.existingFingerprint?.trim() ?? '';
    const fingerprint = params.fingerprint.trim();
    if (existingFingerprint) {
        lines.push(`${t('settings.remoteHostsHostKeyCurrentFingerprintLabel')}: ${existingFingerprint}`);
        lines.push(`${t('settings.remoteHostsHostKeyNewFingerprintLabel')}: ${fingerprint}`);
        return lines.join('\n');
    }
    if (fingerprint) {
        lines.push(fingerprint);
    }
    return lines.join('\n');
}
