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
        const promptId = prompt.data && typeof prompt.data === 'object' && !Array.isArray(prompt.data)
            && typeof (prompt.data as { promptId?: unknown }).promptId === 'string'
            ? (prompt.data as { promptId: string }).promptId
            : '';
        const promptKey = promptId
            ? `${taskId}:${prompt.kind}:${promptId}`
            : `${taskId}:${prompt.kind}:${JSON.stringify(prompt.data)}`;
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
                const remember = prompt.kind === 'ssh.replaceHostKey'
                    ? true
                    : await Modal.confirm(
                        t('settings.remoteHostsRememberHostKeyTitle'),
                        host || undefined,
                        {
                            confirmText: t('settings.remoteHostsRememberHostKeyAction'),
                            cancelText: t('settings.remoteHostsTrustOnceAction'),
                        },
                    );
                await params.runner.respond(taskId, {
                    trusted: true,
                    ...(remember ? { remember: true } : {}),
                });
            })();
            return;
        }

        if (prompt.kind === 'ssh.privateKeyPassphrase') {
            void (async () => {
                const host = typeof prompt.data.host === 'string' ? prompt.data.host.trim() : '';
                const passphrase = await Modal.prompt(
                    prompt.message || t('settings.remoteHostsPrivateKeyPassphraseTitle'),
                    host || undefined,
                    { inputType: 'secure-text', confirmText: t('common.continue'), cancelText: t('common.cancel') },
                );
                if (passphrase == null) {
                    await params.runner.cancel(taskId).catch(() => {});
                    return;
                }
                await params.runner.respond(taskId, { passphrase });
            })();
            return;
        }

        if (prompt.kind === 'ssh.keyboardInteractive') {
            void (async () => {
                const rawPrompts = Array.isArray(prompt.data.prompts) ? prompt.data.prompts : [];
                const answers: Array<{ id: string; value: string }> = [];
                for (const rawPrompt of rawPrompts) {
                    if (!rawPrompt || typeof rawPrompt !== 'object' || Array.isArray(rawPrompt)) {
                        continue;
                    }
                    const entry = rawPrompt as Record<string, unknown>;
                    const id = typeof entry.id === 'string' ? entry.id : String(answers.length);
                    const label = typeof entry.label === 'string' && entry.label.trim()
                        ? entry.label.trim()
                        : t('settings.remoteHostsKeyboardInteractivePromptLabel');
                    const echo = entry.echo === true;
                    const value = await Modal.prompt(
                        label,
                        prompt.message || t('settings.remoteHostsKeyboardInteractiveTitle'),
                        {
                            inputType: echo ? 'default' : 'secure-text',
                            confirmText: t('common.continue'),
                            cancelText: t('common.cancel'),
                        },
                    );
                    if (value == null) {
                        await params.runner.cancel(taskId).catch(() => {});
                        return;
                    }
                    answers.push({ id, value });
                }
                await params.runner.respond(taskId, { keyboardInteractiveAnswers: answers });
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
            return;
        }

        if (prompt.kind === 'auth.approveRemoteProvisioning') {
            void (async () => {
                const accepted = await Modal.confirm(
                    prompt.message || t('common.info'),
                    undefined,
                    { confirmText: t('common.continue'), cancelText: t('common.cancel') },
                );
                if (!accepted) {
                    await params.runner.cancel(taskId).catch(() => {});
                    return;
                }
                await params.runner.respond(taskId, { approved: true });
            })();
            return;
        }

        if (prompt.kind === 'daemon.replaceRemoteBackgroundServices') {
            void (async () => {
                const accepted = await Modal.confirm(
                    prompt.message || t('common.info'),
                    undefined,
                    { confirmText: t('common.continue'), cancelText: t('common.cancel') },
                );
                if (!accepted) {
                    await params.runner.respond(taskId, { replaceExistingServices: false }).catch(() => {});
                    return;
                }
                await params.runner.respond(taskId, { replaceExistingServices: true });
            })();
        }
    }, [params.runner, params.prompt, params.snapshot?.result, params.taskId]);
}
