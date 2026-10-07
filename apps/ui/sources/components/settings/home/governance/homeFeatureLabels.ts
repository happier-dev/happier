import type { FeatureId } from '@happier-dev/protocol';

import { t, type TranslationKeyNoParams } from '@/text';
import { en } from '@/text/translations/en';

/**
 * The one reader of Home feature labels (`homeFeatures.<featureId>.title|description`, and
 * `homeFeatures.<family>.group` for Advanced sections). The labels live in
 * `en.homeFeatures`; a label is looked up in the English tree, which defines the shape
 * every locale matches, and then translated through `t`. The console never shows a raw id: an id
 * without a label (a feature newer than this app) reads as its humanised last segment.
 */
type LabelNode = Readonly<{ [segment: string]: LabelNode | string }>;

function labelNode(path: string): LabelNode | null {
    let node: LabelNode | string | undefined = en.homeFeatures as LabelNode;
    for (const segment of path.split('.')) {
        if (!node || typeof node === 'string') return null;
        node = node[segment];
    }
    return node && typeof node !== 'string' ? node : null;
}

function labelKey(path: string, leaf: 'title' | 'description' | 'group'): TranslationKeyNoParams | null {
    return typeof labelNode(path)?.[leaf] === 'string'
        // Checked against the English tree above, which every locale must match.
        ? (`homeFeatures.${path}.${leaf}` as TranslationKeyNoParams)
        : null;
}

/** `sessions.usageLimitRecovery` → `Usage limit recovery`. */
export function humanizeIdentifier(identifier: string): string {
    const words = identifier
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .trim()
        .toLowerCase();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : identifier;
}

export function homeFeatureTitleKey(featureId: FeatureId): TranslationKeyNoParams | null {
    return labelKey(featureId, 'title');
}

export function homeFeatureDescriptionKey(featureId: FeatureId): TranslationKeyNoParams | null {
    return labelKey(featureId, 'description');
}

export function homeFeatureTitle(featureId: FeatureId): string {
    const key = homeFeatureTitleKey(featureId);
    return key ? t(key) : humanizeIdentifier(featureId.split('.').at(-1) ?? featureId);
}

export function homeFeatureDescription(featureId: FeatureId): string | null {
    const key = homeFeatureDescriptionKey(featureId);
    return key ? t(key) : null;
}

/** The label of an Advanced family: its `group` label, else the family feature's own title. */
export function homeFeatureFamilyTitle(family: string): string {
    const key = labelKey(family, 'group') ?? labelKey(family, 'title');
    return key ? t(key) : humanizeIdentifier(family);
}

/**
 * A feature's limit or mode key (`homeFeatures.keys.<ENV_KEY>.title|description`). A key with no
 * label is not rendered: the console shows neither an env key nor a name guessed from one, and
 * `homeFeatureLabels.test.ts` fails when the server declares a features key this tree lacks.
 */
function settingLabelKey(key: string, leaf: 'title' | 'description'): TranslationKeyNoParams | null {
    const node = labelNode('keys')?.[key];
    return node && typeof node !== 'string' && typeof node[leaf] === 'string'
        // Checked against the English tree above, which every locale must match.
        ? (`homeFeatures.keys.${key}.${leaf}` as TranslationKeyNoParams)
        : null;
}

export function homeFeatureSettingTitleKey(key: string): TranslationKeyNoParams | null {
    return settingLabelKey(key, 'title');
}

export function homeFeatureSettingDescriptionKey(key: string): TranslationKeyNoParams | null {
    return settingLabelKey(key, 'description');
}
