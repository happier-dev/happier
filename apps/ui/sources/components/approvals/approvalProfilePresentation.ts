import type { ApprovalProfileV1 } from '@happier-dev/protocol/actions';

import { t } from '@/text';

const BUILTIN_COPY = {
    'builtin:read-propose': 'readPropose',
    'builtin:apply-safe': 'applySafe',
    'builtin:full-trust': 'fullTrust',
} as const;

/** A profile's person-facing name and consequence. Built-ins read in the app's language; custom profiles keep their own name. */
export function presentApprovalProfile(profile: Pick<ApprovalProfileV1, 'id' | 'name'> & Partial<Pick<ApprovalProfileV1, 'defaultMode' | 'categories'>>): Readonly<{ title: string; subtitle: string | undefined; builtIn: boolean }> {
    const copy = BUILTIN_COPY[profile.id as keyof typeof BUILTIN_COPY];
    if (!copy) return { title: profile.name, subtitle: customSummary(profile), builtIn: false };
    return {
        title: t(`workflows.triggers.guided.profile.${copy}Name`),
        subtitle: t(`workflows.triggers.guided.profile.${copy}Description`),
        builtIn: true,
    };
}

const MODE_COPY = { require: 'modeRequire', ask: 'modeAsk', allow: 'modeAllow' } as const;

/** A custom profile in one line: its default, then each category that differs from it. */
function customSummary(profile: Partial<Pick<ApprovalProfileV1, 'defaultMode' | 'categories'>>): string | undefined {
    if (!profile.defaultMode) return undefined;
    const mode = (value: keyof typeof MODE_COPY) => t(`workflows.triggers.guided.profile.${MODE_COPY[value]}`);
    const parts = [`${t('workflows.triggers.guided.profile.defaultLabel')}: ${mode(profile.defaultMode)}`];
    if (profile.categories?.safe) parts.push(`${t('workflows.triggers.guided.profile.safeLabel')}: ${mode(profile.categories.safe)}`);
    if (profile.categories?.danger) parts.push(`${t('workflows.triggers.guided.profile.dangerLabel')}: ${mode(profile.categories.danger)}`);
    return parts.join(' · ');
}
