import type { TranslationKeyNoParams } from '@/text';

type TranslateFn = (key: TranslationKeyNoParams) => string;

function createBaseSocialStackScreenOptions(translate: TranslateFn, headerTitleKey: TranslationKeyNoParams) {
    return {
        headerShown: false,
        headerTitle: translate(headerTitleKey),
        headerBackTitle: translate('common.home'),
    };
}

export function createInboxStackScreenOptions(translate: TranslateFn) {
    return createBaseSocialStackScreenOptions(translate, 'tabs.inbox');
}

export function createFriendsStackScreenOptions(translate: TranslateFn) {
    return createBaseSocialStackScreenOptions(translate, 'tabs.friends');
}
