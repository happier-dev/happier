import { t } from '@/text';

/** The refusal in the person's terms; the exact code stays behind Details. */
export function projectOpenRefusalPresentation(code: string, gitRef: string | null): Readonly<{ title: string; description?: string }> {
    if (code === 'target_mismatch') return {
        title: t('projects.open.targetMismatch'), description: t('projects.open.targetMismatchHint'),
    };
    if (code.includes('offline') || code.includes('unreachable')) return { title: t('projects.open.accessLost') };
    if (gitRef && code.includes('ref')) return { title: t('projects.open.refMissing', { ref: gitRef }) };
    if (code.includes('folder') || code.includes('path')) return { title: t('projects.open.invalidFolder') };
    if (code.includes('source') && code.includes('changed')) return { title: t('projects.open.sourceChanged') };
    if (code.includes('source')) return { title: t('projects.open.sourceUnavailable') };
    return { title: t('projects.open.unsupported') };
}
