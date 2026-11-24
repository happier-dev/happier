import { t } from '@/text';
import { ACTION_FAILURE_DETAIL_LABELS } from '@/utils/errors/alertActionFailure';

/**
 * Reads the Technical details an Action failure reveals ("Error: outcome_unknown", one labelled line per
 * reference) back into its keys, so a test asserts the references rather than their wording.
 */
export function readActionFailureDetails(text: unknown): Record<string, string> {
    const keyByLabel = new Map<string, string>(Object.entries(ACTION_FAILURE_DETAIL_LABELS).map(([key, label]) => [t(label), key]));
    const details: Record<string, string> = {};
    for (const line of String(text ?? '').split('\n')) {
        const at = line.indexOf(': ');
        if (at <= 0) continue;
        const label = line.slice(0, at);
        details[keyByLabel.get(label) ?? label] = line.slice(at + 2);
    }
    return details;
}
