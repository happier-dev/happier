import React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import * as Localization from 'expo-localization';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useSettingMutable } from '@/sync/domains/state/storage';
import {
    t,
    getLanguageEnglishName,
    getLanguageNativeName,
    SUPPORTED_LANGUAGES,
    SUPPORTED_LANGUAGE_CODES,
    type SupportedLanguage,
} from '@/text';
import { Modal } from '@/modal';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { LANGUAGE_SETTINGS } from '@/components/settings/language/languageSettings';
import { preloadTranslationsForSettings } from '@/text/i18n';

type LanguageOption = 'auto' | SupportedLanguage;

type LanguageItem = Readonly<{
    key: LanguageOption;
    title: string;
    subtitle?: string;
}>;

export function LanguageSettingsScreen() {
    const { theme } = useUnistyles();
    const [preferredLanguage, setPreferredLanguage] = useSettingMutable('preferredLanguage');
    const { reloadApp } = useUpdates();

    const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
    const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
    const detectedLanguageName = deviceLanguage in SUPPORTED_LANGUAGES
        ? getLanguageNativeName(deviceLanguage as SupportedLanguage)
        : getLanguageNativeName('en');

    const currentSelection: LanguageOption = preferredLanguage === null
        ? 'auto'
        : SUPPORTED_LANGUAGE_CODES.includes(preferredLanguage as SupportedLanguage)
            ? preferredLanguage as SupportedLanguage
            : 'auto';

    // Each language is shown in its own name; the English name follows when it differs, so someone
    // who landed in a language they cannot read can still find theirs.
    const languageOptions: readonly LanguageItem[] = [
        {
            key: 'auto',
            title: t('settingsLanguage.automatic'),
            subtitle: `${t('settingsLanguage.automaticSubtitle')} · ${detectedLanguageName}`,
        },
        ...SUPPORTED_LANGUAGE_CODES.map((code) => {
            const nativeName = getLanguageNativeName(code);
            const englishName = getLanguageEnglishName(code);
            return {
                key: code,
                title: nativeName,
                subtitle: englishName !== nativeName ? englishName : undefined,
            };
        }),
    ];

    const handleLanguageChange = async (newLanguage: LanguageOption) => {
        if (newLanguage === currentSelection) return;

        const confirmed = await Modal.confirm(
            t('settingsLanguage.needsRestart'),
            t('settingsLanguage.needsRestartMessage'),
        );
        if (!confirmed) return;

        const selected = newLanguage === 'auto' ? null : newLanguage;
        try {
            await preloadTranslationsForSettings(selected);
        } catch {
            Modal.alert(t('common.error'), t('errors.operationFailed'));
            return;
        }
        setPreferredLanguage(selected);
        // Small delay so the setting is saved before the app restarts.
        setTimeout(() => {
            reloadApp();
        }, 100);
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsLanguage.pageDescription')} />
            <SettingAnchor setting={LANGUAGE_SETTINGS.settings.appLanguage}>
                <ItemGroup
                    title={t(LANGUAGE_SETTINGS.settings.appLanguage.titleKey)}
                    description={t('settingsLanguage.listDescription')}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t(LANGUAGE_SETTINGS.settings.appLanguage.titleKey)}
                >
                    {languageOptions.map((option) => {
                        const selected = currentSelection === option.key;
                        return (
                            <Item
                                key={option.key}
                                testID={`settings-language-option-${option.key}`}
                                title={option.title}
                                subtitle={option.subtitle}
                                accessibilityRole="radio"
                                accessibilityChecked={selected}
                                rightElement={selected
                                    ? <Icon name="check" size={ICON_SIZE.md} color={theme.colors.text.primary} />
                                    : null}
                                onPress={() => handleLanguageChange(option.key)}
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>
            </SettingAnchor>
        </ItemList>
    );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { LanguageSettingsScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={LanguageSettingsScreen} />; }
