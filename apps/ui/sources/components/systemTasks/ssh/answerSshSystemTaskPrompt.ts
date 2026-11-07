import { confirmSshHostKey } from '@/components/ssh/SshHostKeyTrustSheet';
import { Modal } from '@/modal';
import { t, tLoose } from '@/text';

import { getSystemTaskPromptSignature, readLatestSystemTaskPrompt } from '../prompts/readLatestSystemTaskPrompt';
import type { SystemTaskPromptContinuation, SystemTaskPromptEnvelope, SystemTaskRunner } from '../types';

function personalHomeCopy(key: string, fallback: string): string {
    const translationKey = `personalHome.settings.${key}`;
    const value = tLoose(translationKey);
    return value === translationKey ? fallback : value;
}

/** Presents human decisions; the runner owns response delivery and task lifetime. */
export async function answerSshSystemTaskPrompt(
    prompt: SystemTaskPromptEnvelope,
    options: Readonly<{ isCurrent: () => boolean; cancel: () => Promise<void>; supportsRememberHostKey?: boolean }>,
): Promise<unknown> {
    const { isCurrent } = options;
    if (!isCurrent()) return undefined;
    const cancel = async () => {
        if (isCurrent()) await options.cancel().catch(() => {});
        return undefined;
    };

    if (prompt.kind === 'personal_home.confirm_remote_erase.v1') {
        const rawPaths = Array.isArray(prompt.data.paths) ? prompt.data.paths : [];
        const paths = rawPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
        const sshHost = typeof prompt.data.sshHost === 'string' ? prompt.data.sshHost.trim() : '';
        const canonicalServerUrl = typeof prompt.data.canonicalServerUrl === 'string' ? prompt.data.canonicalServerUrl.trim() : '';
        const homeServerIdentityId = prompt.data.homeServerIdentityId === null
            || (typeof prompt.data.homeServerIdentityId === 'string' && prompt.data.homeServerIdentityId.trim().length > 0)
            ? prompt.data.homeServerIdentityId : undefined;
        const estimatedBytes = prompt.data.estimatedBytes;
        const factsAreExact = sshHost.length > 0 && canonicalServerUrl.length > 0
            && homeServerIdentityId !== undefined && paths.length > 0 && paths.length === rawPaths.length
            && (estimatedBytes === null || (typeof estimatedBytes === 'number' && Number.isFinite(estimatedBytes) && estimatedBytes >= 0));
        if (!factsAreExact) return { confirmed: false };
        const accepted = await Modal.confirm(
            prompt.message || personalHomeCopy('eraseDataTitle', 'Delete Personal Home data?'),
            [
                `${t('settings.machineEnrollRemoteSshHostLabel')}: ${sshHost}`,
                `${personalHomeCopy('canonicalServerUrl', 'Home URL')}: ${canonicalServerUrl}`,
                `${personalHomeCopy('identityTitle', 'Home identity')}: ${homeServerIdentityId || personalHomeCopy('notAvailable', 'Not available')}`,
                `${personalHomeCopy('estimatedSize', 'Estimated size')}: ${estimatedBytes === null ? personalHomeCopy('unknownSize', 'Unknown size') : String(estimatedBytes)}`,
                '',
                personalHomeCopy('eraseDataBody', 'This permanently deletes only the owner-validated Home paths below:'),
                ...paths.map((path) => `• ${path}`),
            ].join('\n'),
            { destructive: true, confirmText: personalHomeCopy('eraseDataAction', 'Delete Personal Home data'), cancelText: t('common.cancel') },
        );
        return isCurrent() ? { confirmed: accepted } : undefined;
    }

    if (prompt.kind === 'ssh.trustHost' || prompt.kind === 'ssh.replaceHostKey') {
        const fingerprint = typeof prompt.data.fingerprint === 'string' ? prompt.data.fingerprint.trim() : '';
        const existingFingerprint = typeof prompt.data.existingFingerprint === 'string' ? prompt.data.existingFingerprint.trim() : '';
        const host = typeof prompt.data.host === 'string' ? prompt.data.host.trim() : '';
        const keyType = typeof prompt.data.keyType === 'string' ? prompt.data.keyType.trim() : '';
        const isReplacement = prompt.kind === 'ssh.replaceHostKey';
        const accepted = await confirmSshHostKey({
            host, fingerprint, keyType: keyType || null, existingFingerprint: isReplacement ? existingFingerprint || null : null,
        });
        if (!isCurrent()) return undefined;
        if (!accepted) return cancel();
        if (options.supportsRememberHostKey === false) return { trusted: true };
        const remember = isReplacement || await Modal.confirm(
            t('settings.remoteHostsRememberHostKeyTitle'), host || undefined,
            { confirmText: t('settings.remoteHostsRememberHostKeyAction'), cancelText: t('settings.remoteHostsTrustOnceAction') },
        );
        return isCurrent() ? { trusted: true, ...(remember ? { remember: true } : {}) } : undefined;
    }

    if (prompt.kind === 'ssh.privateKeyPassphrase') {
        const host = typeof prompt.data.host === 'string' ? prompt.data.host.trim() : '';
        const passphrase = await Modal.prompt(t('settings.remoteHostsPrivateKeyPassphraseTitle'), host || undefined, {
            inputType: 'secure-text', confirmText: t('common.continue'), cancelText: t('common.cancel'),
        });
        if (!isCurrent()) return undefined;
        return passphrase == null ? cancel() : { passphrase };
    }

    if (prompt.kind === 'ssh.keyboardInteractive') {
        const rawPrompts = Array.isArray(prompt.data.prompts) ? prompt.data.prompts : [];
        const answers: Array<{ id: string; value: string }> = [];
        for (const rawPrompt of rawPrompts) {
            if (!rawPrompt || typeof rawPrompt !== 'object' || Array.isArray(rawPrompt)) continue;
            const entry = rawPrompt as Record<string, unknown>;
            const id = typeof entry.id === 'string' ? entry.id : String(answers.length);
            const label = typeof entry.label === 'string' && entry.label.trim()
                ? entry.label.trim() : t('settings.remoteHostsKeyboardInteractivePromptLabel');
            const value = await Modal.prompt(label, t('settings.remoteHostsKeyboardInteractiveTitle'), {
                inputType: entry.echo === true ? 'default' : 'secure-text',
                confirmText: t('common.continue'), cancelText: t('common.cancel'),
            });
            if (!isCurrent()) return undefined;
            if (value == null) return cancel();
            answers.push({ id, value });
        }
        return { keyboardInteractiveAnswers: answers };
    }

    if (prompt.kind === 'ssh.password') {
        const password = await Modal.prompt(prompt.message || t('settings.remoteHostsPasswordRequiredTitle'), undefined, {
            inputType: 'secure-text', confirmText: t('common.continue'), cancelText: t('common.cancel'),
        });
        if (!isCurrent()) return undefined;
        return password == null ? cancel() : { password };
    }

    if (prompt.kind === 'auth.approveRemoteProvisioning') {
        const accepted = await Modal.confirm(prompt.message || t('common.info'), undefined, {
            confirmText: t('common.continue'), cancelText: t('common.cancel'),
        });
        if (!isCurrent()) return undefined;
        return accepted ? { approved: true } : cancel();
    }

    if (prompt.kind === 'daemon.replaceRemoteBackgroundServices') {
        const accepted = await Modal.confirm(t('machine.backgroundServicePrompt.replaceTitle'), undefined, {
            confirmText: t('settings.machineSetupRemotePromptReplaceServicesAction'), cancelText: t('common.cancel'),
        });
        return isCurrent() ? { replaceExistingServices: accepted } : undefined;
    }

    if (prompt.kind === 'releaseChannel.switchDefaultForSetup') {
        const accepted = await Modal.confirm(prompt.message || t('common.info'), undefined, {
            confirmText: t('common.continue'), cancelText: t('common.cancel'),
        });
        return isCurrent() ? { switchDefaultReleaseChannel: accepted } : undefined;
    }
    return undefined;
}

export function createSshSystemTaskPromptContinuation(
    runner: SystemTaskRunner,
    taskId: string,
    isCurrent: () => boolean = () => true,
): SystemTaskPromptContinuation {
    return (prompt) => {
        const signature = getSystemTaskPromptSignature(prompt);
        return answerSshSystemTaskPrompt(prompt, {
            isCurrent: () => {
                if (!isCurrent()) return false;
                const snapshot = runner.getSnapshot(taskId);
                if (!snapshot || snapshot.result || snapshot.cancelRequested || !snapshot.awaitingInput) return false;
                const latestPrompt = readLatestSystemTaskPrompt(snapshot);
                return latestPrompt !== null && getSystemTaskPromptSignature(latestPrompt) === signature;
            },
            cancel: () => runner.cancel(taskId),
        });
    };
}
