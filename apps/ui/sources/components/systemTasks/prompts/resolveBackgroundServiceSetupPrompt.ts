import {
    parseReleaseChannelSwitchForSetupPromptData,
    parseReplaceLocalBackgroundServicesPromptData,
    parseReplaceRemoteBackgroundServicesPromptData,
    type ReleaseChannelSwitchForSetupPromptData,
    type ReplaceLocalBackgroundServicesPromptData,
    type ReplaceRemoteBackgroundServicesPromptData,
} from '@happier-dev/protocol';

import type { SystemTaskPromptEnvelope } from './readLatestSystemTaskPrompt';

export type ReleaseChannelSwitchSetupPrompt =
    Readonly<{ kind: 'releaseChannel.switchDefaultForSetup'; message: string }>
    & ReleaseChannelSwitchForSetupPromptData;

export type BackgroundServiceReplacementPrompt =
    | (Readonly<{ kind: 'daemon.replaceLocalBackgroundServices'; message: string }> & ReplaceLocalBackgroundServicesPromptData)
    | (Readonly<{ kind: 'daemon.replaceRemoteBackgroundServices'; message: string }> & ReplaceRemoteBackgroundServicesPromptData);

export function resolveReleaseChannelSwitchSetupPrompt(
    prompt: SystemTaskPromptEnvelope | null,
): ReleaseChannelSwitchSetupPrompt | null {
    if (!prompt || prompt.kind !== 'releaseChannel.switchDefaultForSetup') {
        return null;
    }

    const parsed = parseReleaseChannelSwitchForSetupPromptData(prompt.data);
    if (!parsed) {
        return null;
    }

    return {
        kind: prompt.kind,
        message: prompt.message,
        ...parsed,
    };
}

export function resolveBackgroundServiceReplacementPrompt(
    prompt: SystemTaskPromptEnvelope | null,
): BackgroundServiceReplacementPrompt | null {
    if (!prompt) {
        return null;
    }

    if (prompt.kind === 'daemon.replaceLocalBackgroundServices') {
        return {
            kind: prompt.kind,
            message: prompt.message,
            ...parseReplaceLocalBackgroundServicesPromptData(prompt.data),
        };
    }

    if (prompt.kind === 'daemon.replaceRemoteBackgroundServices') {
        return {
            kind: prompt.kind,
            message: prompt.message,
            ...parseReplaceRemoteBackgroundServicesPromptData(prompt.data),
        };
    }

    return null;
}
