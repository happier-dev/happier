import { copy } from '@/theme/copy';
import { Pillar } from './Pillar';
import { DeviceStage } from '@/demo/DeviceStage';
import { voiceScenario } from '@/demo/scenarios/voice';

/**
 * Voice pillar — phone-only layout, scenario-driven orb + waveform +
 * scripted transcript. Visual-only (no audio).
 */
export function VoicePillar() {
    return (
        <Pillar
            id="voice"
            kicker={copy.voice.kicker}
            headline={copy.voice.headline}
            body={copy.voice.body}
            layout="stacked"
            visual={
                <DeviceStage
                    demoId="voice"
                    scenario={voiceScenario}
                    phoneView="voice"
                />
            }
        />
    );
}
