import { t } from '@/text';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { resolveSessionSubagentKindLabelKey } from './resolveSessionSubagentKindLabelKey';

const SUBAGENT_INTENT_LABEL_KEYS = {
    review: 'session.subagents.intent.review',
    plan: 'session.subagents.intent.plan',
    delegate: 'session.subagents.intent.delegate',
} as const;

function resolveKindLabel(subagent: SessionSubagent): string {
    return t(resolveSessionSubagentKindLabelKey(subagent.kind));
}

function resolveIntentLabel(intent: string | null | undefined): string | null {
    const normalized = typeof intent === 'string' ? intent.trim() : '';
    if (!normalized) return null;
    if (normalized === 'review' || normalized === 'plan' || normalized === 'delegate') {
        return t(SUBAGENT_INTENT_LABEL_KEYS[normalized]);
    }
    return normalized;
}

export function resolveSessionSubagentFactPills(subagent: SessionSubagent): readonly string[] {
    const intentLabel = resolveIntentLabel(subagent.runRef?.intent);

    return [
        t('session.subagents.panel.typeFact', { value: resolveKindLabel(subagent) }),
        subagent.display.providerLabel?.trim()
            ? t('session.subagents.panel.providerFact', { value: subagent.display.providerLabel.trim() })
            : subagent.runRef?.backendId?.trim()
                ? t('session.subagents.panel.backendFact', { value: subagent.runRef.backendId.trim() })
                : null,
        intentLabel
            ? t('session.subagents.panel.intentFact', { value: intentLabel })
            : null,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}
