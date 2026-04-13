import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';

import type { SystemTaskRunState, SystemTaskRunner } from '../types';
import type { SystemTaskPromptEnvelope } from '../prompts/readLatestSystemTaskPrompt';
import { buildBackgroundServiceReplacementPromptBody } from '../prompts/backgroundServiceReplacementPromptPresentation';

import { resolveThisComputerSetupPrompt } from './resolveThisComputerSetupPrompt';

function buildPromptBody(prompt: ReturnType<typeof resolveThisComputerSetupPrompt>): string | undefined {
    if (!prompt) {
        return undefined;
    }

    if (prompt.kind === 'releaseChannel.switchDefaultForSetup') {
        const lines = [
            prompt.targetServerUrl,
            prompt.currentDefaultReleaseChannel && `${prompt.currentDefaultReleaseChannel} → ${prompt.targetReleaseChannel}`,
            ...prompt.managedReleaseChannels.map((entry) => {
                const version = entry.version ? ` • ${entry.version}` : '';
                return `${entry.label}${version}`;
            }),
        ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
        return lines.length > 0 ? lines.join('\n') : undefined;
    }

    if (prompt.kind === 'daemon.takeOverManualRelayRuntimeForSetup') {
        const lines = [
            prompt.targetServerUrl,
            prompt.targetReleaseChannel,
            prompt.currentReleaseChannel && prompt.currentCliVersion
                ? `${prompt.currentReleaseChannel} • ${prompt.currentCliVersion}`
                : prompt.currentReleaseChannel ?? prompt.currentCliVersion ?? null,
        ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
        return lines.length > 0 ? lines.join('\n') : undefined;
    }

    return buildBackgroundServiceReplacementPromptBody({
        targetServerUrl: prompt.targetServerUrl,
        targetReleaseChannel: prompt.targetReleaseChannel,
        services: prompt.services,
        format: 'compact',
    });
}

export function useThisComputerSetupPromptModals(params: Readonly<{
    runner: SystemTaskRunner;
    taskId: string | null;
    snapshot: SystemTaskRunState | null;
    prompt: SystemTaskPromptEnvelope | null;
}>): void {
    const handledPromptRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        const taskId = params.taskId;
        const parsedPrompt = resolveThisComputerSetupPrompt(params.prompt);
        if (!taskId || !parsedPrompt || params.snapshot?.result) {
            return;
        }

        const promptKey = `${taskId}:${parsedPrompt.kind}:${JSON.stringify(parsedPrompt)}`;
        if (handledPromptRef.current === promptKey) {
            return;
        }
        handledPromptRef.current = promptKey;

        void (async () => {
            const confirmed = await Modal.confirm(
                parsedPrompt.message,
                buildPromptBody(parsedPrompt),
                {
                    confirmText: t('common.continue'),
                    cancelText: t('common.cancel'),
                },
            );

            if (parsedPrompt.kind === 'releaseChannel.switchDefaultForSetup') {
                await params.runner.respond(taskId, { switchDefaultReleaseChannel: confirmed });
                return;
            }

            if (parsedPrompt.kind === 'daemon.takeOverManualRelayRuntimeForSetup') {
                await params.runner.respond(taskId, { takeOverManualRelayRuntime: confirmed });
                return;
            }

            await params.runner.respond(taskId, { replaceExistingServices: confirmed });
        })();
    }, [params.prompt, params.runner, params.snapshot?.result, params.taskId]);
}
