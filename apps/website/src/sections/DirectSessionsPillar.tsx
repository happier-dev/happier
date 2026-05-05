import { copy } from '@/theme/copy';
import { Pillar } from './Pillar';
import { DeviceStage } from '@/demo/DeviceStage';
import { directSessionsScenario } from '@/demo/scenarios/directSessions';

export function DirectSessionsPillar() {
    return (
        <Pillar
            id="direct-sessions"
            kicker={copy.directSessions.kicker}
            headline={copy.directSessions.headline}
            body={copy.directSessions.body}
            layout="stacked"
            visual={
                <DeviceStage
                    demoId="direct-sessions"
                    scenario={directSessionsScenario}
                    phoneView="phone-session"
                    desktopView="direct-browse"
                />
            }
        />
    );
}
