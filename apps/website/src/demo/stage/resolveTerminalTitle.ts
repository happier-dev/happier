import type { ScenarioBeat } from '../timeline/scenarioTypes';

export function resolveTerminalTitle(
    activeBeat: Pick<ScenarioBeat, 'terminal'> | undefined,
    sessionTitle: string,
): string {
    const command = activeBeat?.terminal?.commands?.at(-1);
    return command ? `${command} · ${sessionTitle}` : sessionTitle;
}
