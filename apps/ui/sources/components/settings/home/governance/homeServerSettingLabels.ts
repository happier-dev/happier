import type { HomeSettingIgnoredReasonV1 } from '@happier-dev/protocol/home/governance';

import { t, type TranslationKeyNoParams } from '@/text';
import { en } from '@/text/translations/en';

import { humanizeIdentifier } from './homeFeatureLabels';

/**
 * The one reader of server setting labels (`homeSettings.keys.<ENV_KEY>` and
 * `homeSettings.groups.<group>`). A label is looked up in the English tree, which defines the shape
 * every locale matches, then translated through `t`. A per-route rate limit is named from its route
 * through one template; a key newer than this app reads as its humanised name, never as nothing.
 */
const RATE_LIMIT_ROUTE_KEY = /^(?:HAPPIER_)?(.+)_RATE_LIMIT_(MAX|WINDOW)$/;

export function homeServerSettingTitleKey(key: string): TranslationKeyNoParams | null {
    return Object.hasOwn(en.homeSettings.keys, key)
        // Checked against the English tree above, which every locale must match.
        ? (`homeSettings.keys.${key}` as TranslationKeyNoParams)
        : null;
}

/** `HAPPIER_SESSION_MESSAGES_RATE_LIMIT_MAX` → the route words, or `null` for any other key. */
export function homeServerSettingRateLimitRoute(key: string): Readonly<{ route: string; part: 'max' | 'window' }> | null {
    const match = RATE_LIMIT_ROUTE_KEY.exec(key);
    if (!match || key.startsWith('HAPPIER_API_RATE_LIMITS_')) return null;
    return { route: humanizeIdentifier(match[1]!), part: match[2] === 'MAX' ? 'max' : 'window' };
}

export function homeServerSettingTitle(key: string): string {
    const labelKey = homeServerSettingTitleKey(key);
    if (labelKey) return t(labelKey);
    const rateLimit = homeServerSettingRateLimitRoute(key);
    if (rateLimit) {
        return rateLimit.part === 'max'
            ? t('homeSettings.rateLimit.max', { route: rateLimit.route })
            : t('homeSettings.rateLimit.window', { route: rateLimit.route });
    }
    return humanizeIdentifier(key.replace(/^HAPPIER_/, ''));
}

export function homeServerSettingGroupTitleKey(group: string): TranslationKeyNoParams | null {
    return Object.hasOwn(en.homeSettings.groups, group) ? (`homeSettings.groups.${group}` as TranslationKeyNoParams) : null;
}

export function homeServerSettingGroupTitle(group: string): string {
    const labelKey = homeServerSettingGroupTitleKey(group);
    return labelKey ? t(labelKey) : humanizeIdentifier(group);
}

/** A value the console has words for (`homeSettings.choices.<value>`), or `null`. */
export function homeSettingKnownChoiceLabel(value: string): string | null {
    return Object.hasOwn(en.homeSettings.choices, value) ? t(`homeSettings.choices.${value}` as TranslationKeyNoParams) : null;
}

/** A registry enum value in words (`homeSettings.choices.<value>`), else its humanised form. */
export function homeSettingChoiceLabel(value: string): string {
    return Object.hasOwn(en.homeSettings.choices, value)
        ? t(`homeSettings.choices.${value}` as TranslationKeyNoParams)
        : humanizeIdentifier(value);
}

const UNIT_SUFFIXES: ReadonlyArray<readonly [RegExp, TranslationKeyNoParams]> = [
    [/_MS$/, 'homeSettings.units.ms'],
    [/_SECONDS$/, 'homeSettings.units.seconds'],
    [/_MINUTES$/, 'homeSettings.units.minutes'],
    [/_BYTES$/, 'homeSettings.units.bytes'],
    [/_MB$/, 'homeSettings.units.megabytes'],
];

/**
 * The unit a numeric setting is typed in, read from the registry's own naming convention (`_MS`,
 * `_SECONDS`, `_BYTES`, `_MB`); `null` for a plain count.
 */
export function homeServerSettingUnit(key: string, type: string | undefined): string | null {
    if (type !== 'int' && type !== 'float') return null;
    const match = UNIT_SUFFIXES.find(([pattern]) => pattern.test(key));
    return match ? t(match[1]) : null;
}

/** Why the last start ignored a stored restart value, in words (Server settings and Overview). */
export function homeSettingIgnoredReasonLabel(reason: HomeSettingIgnoredReasonV1): string {
    switch (reason) {
        case 'invalid_type':
            return t('homeGovernance.features.ignoredInvalidType');
        case 'out_of_bounds':
            return t('homeGovernance.features.ignoredOutOfBounds');
        case 'secret_unreadable':
            return t('homeGovernance.features.ignoredSecretUnreadable');
    }
}
