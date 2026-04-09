import { readLatestSystemTaskPrompt, type SystemTaskPromptEnvelope } from '../prompts/readLatestSystemTaskPrompt';
import {
    resolveBackgroundServiceReplacementPrompt,
    resolveReleaseChannelSwitchSetupPrompt,
    type BackgroundServiceReplacementPrompt,
    type ReleaseChannelSwitchSetupPrompt,
} from '../prompts/resolveBackgroundServiceSetupPrompt';
import type { SystemTaskRunState } from '../types';

export type ThisComputerSetupPrompt = ReleaseChannelSwitchSetupPrompt | Extract<
    BackgroundServiceReplacementPrompt,
    Readonly<{ kind: 'daemon.replaceLocalBackgroundServices' }>
>;

export function resolveThisComputerSetupPrompt(
    promptOrSnapshot: SystemTaskPromptEnvelope | SystemTaskRunState | null,
): ThisComputerSetupPrompt | null {
    const prompt = promptOrSnapshot && 'events' in promptOrSnapshot
        ? readLatestSystemTaskPrompt(promptOrSnapshot)
        : promptOrSnapshot;
    if (!prompt) {
        return null;
    }

    if (prompt.kind === 'releaseChannel.switchDefaultForSetup') {
        return resolveReleaseChannelSwitchSetupPrompt(prompt);
    }

    if (prompt.kind === 'daemon.replaceLocalBackgroundServices') {
        const parsed = resolveBackgroundServiceReplacementPrompt(prompt);
        return parsed?.kind === 'daemon.replaceLocalBackgroundServices' ? parsed : null;
    }

    return null;
}
