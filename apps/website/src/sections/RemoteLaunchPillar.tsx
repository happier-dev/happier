import { copy } from '@/theme/copy';
import { Pillar } from './Pillar';
import { DeviceStage } from '@/demo/DeviceStage';
import { remoteLaunchScenario } from '@/demo/scenarios/remoteLaunch';

export function RemoteLaunchPillar() {
    return (
        <Pillar
            id="remote-launch"
            kicker={copy.remoteLaunch.kicker}
            headline={copy.remoteLaunch.headline}
            body={copy.remoteLaunch.body}
            layout="stacked"
            visual={
                <DeviceStage
                    demoId="remote-launch"
                    scenario={remoteLaunchScenario}
                    phoneView="phone-new-session"
                    desktopView="desktop-session"
                />
            }
        />
    );
}
