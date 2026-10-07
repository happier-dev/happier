import { parseSetupCliChoicePromptData, type SetupCliChoicePromptData } from '@happier-dev/protocol/system/tasks/promptPayloadContracts';

import { readLatestSystemTaskPrompt, type SystemTaskPromptEnvelope } from '../prompts/readLatestSystemTaskPrompt';
import {
    resolveBackgroundServiceReplacementPrompt,
    resolveManualRelayRuntimeTakeoverPrompt,
    resolveReleaseChannelSwitchSetupPrompt,
    type BackgroundServiceReplacementPrompt,
    type ManualRelayRuntimeTakeoverPrompt,
    type ReleaseChannelSwitchSetupPrompt,
} from '../prompts/resolveBackgroundServiceSetupPrompt';
import type { SystemTaskRunState } from '../types';

/** R12's one question: who manages this computer's `happier` command line. */
export type CliChoiceSetupPrompt = Readonly<{ kind: 'setup.cliChoice'; message: string }> & SetupCliChoicePromptData;

export type ThisComputerSetupPrompt = CliChoiceSetupPrompt | ReleaseChannelSwitchSetupPrompt | Extract<
    BackgroundServiceReplacementPrompt,
    Readonly<{ kind: 'daemon.replaceLocalBackgroundServices' }>
> | ManualRelayRuntimeTakeoverPrompt;

export function resolveThisComputerSetupPrompt(
    promptOrSnapshot: SystemTaskPromptEnvelope | SystemTaskRunState | null,
): ThisComputerSetupPrompt | null {
    const prompt = promptOrSnapshot && 'events' in promptOrSnapshot
        ? readLatestSystemTaskPrompt(promptOrSnapshot)
        : promptOrSnapshot;
    if (!prompt) {
        return null;
    }

    if (prompt.kind === 'setup.cliChoice') {
        const data = parseSetupCliChoicePromptData(prompt.data);
        return data ? { kind: 'setup.cliChoice', message: prompt.message, ...data } : null;
    }

    if (prompt.kind === 'releaseChannel.switchDefaultForSetup') {
        return resolveReleaseChannelSwitchSetupPrompt(prompt);
    }

    if (prompt.kind === 'daemon.replaceLocalBackgroundServices') {
        const parsed = resolveBackgroundServiceReplacementPrompt(prompt);
        return parsed?.kind === 'daemon.replaceLocalBackgroundServices' ? parsed : null;
    }

    if (prompt.kind === 'daemon.takeOverManualRelayRuntimeForSetup') {
        return resolveManualRelayRuntimeTakeoverPrompt(prompt);
    }

    return null;
}
