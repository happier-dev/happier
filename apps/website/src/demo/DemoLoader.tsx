import { DeviceStage } from './DeviceStage';
import { handoffScenario } from './scenarios/handoff';

/**
 * The hero demo — cinematic stage + captions, always.
 * Variant switches removed (2026-04): the single-cinematic + captions path
 * is the only supported composition.
 */
export function DemoLoader() {
    return (
        <DeviceStage
            demoId="hero"
            scenario={handoffScenario}
            phoneView="phone-session"
            desktopView="desktop-session"
        />
    );
}
