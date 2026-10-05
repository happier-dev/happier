import * as React from 'react';

import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { t } from '@/text';
import { useVoiceSttSettingRefs } from '@/voice/settings/useVoiceSttSettingRefs';

/** Device and daemon recognizers consume this same independent recognition-language field. */
export function LocalNeuralSttLanguageItem(props: Readonly<{
    language: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (language: string | null) => void;
    popoverBoundaryRef?: React.ComponentProps<typeof DropdownMenu>['popoverBoundaryRef'];
}>) {
    const settings = useVoiceSttSettingRefs();
    const [customLanguageOpen, setCustomLanguageOpen] = React.useState(false);
    const language = props.language ?? '';
    const options = [
        { id: 'en', titleKey: 'settingsVoice.language.options.english' as const },
        { id: 'en-US', titleKey: 'settingsVoice.language.options.englishUs' as const },
        { id: 'fr', titleKey: 'settingsVoice.language.options.french' as const },
        { id: 'es', titleKey: 'settingsVoice.language.options.spanish' as const },
    ];
    return <>
        <SettingAnchor setting={settings.sttLanguage}>
            <DropdownMenu
                open={props.open}
                onOpenChange={props.onOpenChange}
                variant="selectable"
                search
                selectedId={language}
                showCategoryTitles={false}
                matchTriggerWidth
                connectToTrigger
                rowKind="item"
                popoverBoundaryRef={props.popoverBoundaryRef}
                itemTrigger={{
                    title: t(settings.sttLanguage.titleKey),
                    subtitle: t('settingsVoice.local.localNeuralStt.language.subtitle'),
                    showSelectedSubtitle: false,
                    detailFormatter: () => language || t('settingsVoice.language.autoDetect'),
                }}
                items={[
                    { id: '', title: t('settingsVoice.language.autoDetect'), subtitle: t('settingsVoice.language.autoDetectSubtitle') },
                    ...options.map((option) => ({ id: option.id, title: t(option.titleKey), subtitle: option.id })),
                    { id: '__custom__', title: t('settingsVoice.language.customTitle'), subtitle: t('settingsVoice.language.customSubtitle') },
                ]}
                onSelect={(id) => {
                    if (id === '__custom__') setCustomLanguageOpen(true);
                    else props.onSelect(id || null);
                    props.onOpenChange(false);
                }}
            />
        </SettingAnchor>
        {customLanguageOpen ? <FieldValueItem
            title={t('settingsVoice.local.localNeuralStt.language.promptTitle')}
            subtitle={t('settingsVoice.local.localNeuralStt.language.promptBody')}
            fieldTestID="settings.voice.localNeuralStt.language.custom.field"
            autoCapitalize="none"
            autoFocus
            placeholder={t('settingsVoice.language.autoDetect')}
            value={language}
            onCommit={(draft) => {
                setCustomLanguageOpen(false);
                props.onSelect(draft || null);
            }}
        /> : null}
    </>;
}
