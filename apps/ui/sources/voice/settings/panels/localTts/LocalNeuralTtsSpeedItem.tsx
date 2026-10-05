import * as React from 'react';

import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

/** Neural playback uses the same supported speed choice on device and daemon execution. */
export function LocalNeuralTtsSpeedItem(props: Readonly<{
    speed: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (speed: number | null) => void;
    popoverBoundaryRef?: React.ComponentProps<typeof DropdownMenu>['popoverBoundaryRef'];
}>) {
    return (
        <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsSpeed}>
            <DropdownMenu
                open={props.open}
                onOpenChange={props.onOpenChange}
                variant="selectable"
                search={false}
                selectedId={String(props.speed)}
                showCategoryTitles={false}
                matchTriggerWidth
                connectToTrigger
                rowKind="item"
                popoverBoundaryRef={props.popoverBoundaryRef}
                itemTrigger={{
                    title: t(VOICE_CONVERSATIONS_SETTINGS.settings.ttsSpeed.titleKey),
                    subtitle: t('settingsVoice.local.kokoro.speed.subtitle'),
                    showSelectedSubtitle: false,
                }}
                items={[0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2].map((speed) => ({ id: String(speed), title: String(speed) }))}
                onSelect={(id) => {
                    const parsed = Number(id);
                    props.onSelect(Number.isFinite(parsed) ? parsed : null);
                    props.onOpenChange(false);
                }}
            />
        </SettingAnchor>
    );
}
