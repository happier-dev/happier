import { copy } from '@/theme/copy';
import { Pillar } from './Pillar';
import { DeviceStage } from '@/demo/DeviceStage';
import { parallelScenario } from '@/demo/scenarios/parallel';

/**
 * Parallel pillar — triple-parallel layout (three mini-terminals +
 * conductor phone). The phone shows the three independent sessions'
 * live state while each terminal streams its own task.
 */
export function ParallelPillar() {
    return (
        <Pillar
            id="parallel"
            kicker={copy.parallel.kicker}
            headline={copy.parallel.headline}
            body={copy.parallel.body}
            layout="stacked"
            visual={
                <DeviceStage
                    demoId="parallel"
                    scenario={parallelScenario}
                    phoneView="phone-session"
                    desktopView="desktop-session"
                />
            }
        />
    );
}
