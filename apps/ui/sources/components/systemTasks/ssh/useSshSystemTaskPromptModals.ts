import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';

import type { SystemTaskRunState, SystemTaskRunner } from '../types';
import type { SystemTaskPromptEnvelope } from '../prompts/readLatestSystemTaskPrompt';

export function useSshSystemTaskPromptModals(params: Readonly<{
    runner: SystemTaskRunner;
    taskId: string | null;
    snapshot: SystemTaskRunState | null;
    prompt: SystemTaskPromptEnvelope | null;
}>): void {
    const handledPromptRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        const taskId = params.taskId;
        const prompt = params.prompt;
        if (!taskId || !prompt || params.snapshot?.result) return;
        const promptKey = `${taskId}:${prompt.kind}:${JSON.stringify(prompt.data)}`;
        if (handledPromptRef.current === promptKey) return;
        handledPromptRef.current = promptKey;

        if (prompt.kind === 'ssh.trustHost' || prompt.kind === 'ssh.replaceHostKey') {
            void (async () => {
                const fingerprint = typeof prompt.data.fingerprint === 'string' ? prompt.data.fingerprint.trim() : '';
                const host = typeof prompt.data.host === 'string' ? prompt.data.host.trim() : '';
                const accepted = await Modal.confirm(
                    prompt.message || t('settings.remoteHostsHostTrustTitle'),
                    `${host}\n${fingerprint}`.trim(),
                    { confirmText: t('setupOnboarding.remoteSshChecklist.trustHostTitle'), cancelText: t('common.cancel') },
                );
                if (!accepted) {
                    await params.runner.cancel(taskId).catch(() => {});
                    return;
                }
                await params.runner.respond(taskId, { trusted: true });
            })();
            return;
        }

        if (prompt.kind === 'ssh.password') {
            void (async () => {
                const password = await Modal.prompt(
                    prompt.message || t('settings.remoteHostsPasswordRequiredTitle'),
                    undefined,
                    { inputType: 'secure-text', confirmText: t('common.continue'), cancelText: t('common.cancel') },
                );
                if (password == null) {
                    await params.runner.cancel(taskId).catch(() => {});
                    return;
                }
                await params.runner.respond(taskId, { password });
            })();
        }
    }, [params.runner, params.prompt, params.snapshot?.result, params.taskId]);
}
