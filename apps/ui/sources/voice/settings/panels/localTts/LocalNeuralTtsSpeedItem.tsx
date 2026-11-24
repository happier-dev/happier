import * as React from 'react';

import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { Slider } from '@/components/ui/forms/Slider';
import { Item } from '@/components/ui/lists/Item';
import { getPreferredLanguage, t } from '@/text';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

const MIN_SPEED = 0.5;
const MAX_SPEED = 2;
const SPEED_STEP = 0.1;

function formatSpeed(speed: number): string {
    return `${new Intl.NumberFormat(getPreferredLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(speed)}×`;
}

/**
 * Neural playback speed on device and daemon execution: the shared slider, read as "1.0×". A drag
 * previews the value and commits once, on release.
 */
export function LocalNeuralTtsSpeedItem(props: Readonly<{
    speed: number;
    onSelect: (speed: number) => void;
}>) {
    const [preview, setPreview] = React.useState<number | undefined>(undefined);
    const title = t(VOICE_CONVERSATIONS_SETTINGS.settings.ttsSpeed.titleKey);
    return (
        <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsSpeed}>
            <Item
                testID="settings.voice.localNeuralTts.speed-row"
                title={title}
                // The value leads the description, as the Pets size slider reads, so it stays beside the label on phones.
                subtitle={`${formatSpeed(preview ?? props.speed)} · ${t('settingsVoice.local.kokoro.speed.subtitle')}`}
                showChevron={false}
                // The settings row's inline slider (as Pets and Appearance draw it); phones move it beneath the label.
                accessoryLayout="adaptive"
                rightElement={(
                    <Slider
                        testID="settings.voice.localNeuralTts.speed"
                        accessibilityLabel={title}
                        min={MIN_SPEED}
                        max={MAX_SPEED}
                        step={SPEED_STEP}
                        trackWidth={180}
                        value={props.speed}
                        formatValueText={formatSpeed}
                        onValuePreview={setPreview}
                        onValueChange={props.onSelect}
                    />
                )}
            />
        </SettingAnchor>
    );
}
