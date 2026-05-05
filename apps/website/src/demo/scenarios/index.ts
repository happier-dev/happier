import { handoffScenario } from './handoff';
import { remoteLaunchScenario } from './remoteLaunch';
import { directSessionsScenario } from './directSessions';
import { voiceScenario } from './voice';
import { parallelScenario } from './parallel';

export { handoffScenario } from './handoff';
export { remoteLaunchScenario } from './remoteLaunch';
export { directSessionsScenario } from './directSessions';
export { voiceScenario } from './voice';
export { parallelScenario } from './parallel';

export const scenarios = {
    handoff: handoffScenario,
    remoteLaunch: remoteLaunchScenario,
    directSessions: directSessionsScenario,
    voice: voiceScenario,
    parallel: parallelScenario,
};

export default scenarios;
