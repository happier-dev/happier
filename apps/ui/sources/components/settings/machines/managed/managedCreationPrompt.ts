import { answerSshSystemTaskPrompt } from '@/components/systemTasks/ssh/answerSshSystemTaskPrompt';
import type { ManagedMachineBootstrapEstablishPromptV1, ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import { Modal } from '@/modal';
import { t } from '@/text';

type Response = Readonly<{ kind: 'completed'; value: unknown }> | Readonly<{ kind: 'failed'; code: string }>;

/** Reuse the installer's human question; the managed Action remains the only answer authority. */
export async function answerManagedCreationPrompt(input: Readonly<{
    prompt: Exclude<ManagedMachineBootstrapPromptV1, { kind: 'administrator.establish' }>;
    isCurrent: () => boolean;
    respond: (approved: boolean) => Promise<Response>;
}>): Promise<Response> {
    let declined: Promise<Response> | undefined;
    const { prompt } = input;
    const answer = await answerSshSystemTaskPrompt({ kind: prompt.kind, message: prompt.message,
        data: 'host' in prompt ? { host: prompt.host, keyType: prompt.keyType, fingerprint: prompt.fingerprint,
            existingFingerprint: prompt.existingFingerprint } : {},
    }, {
        isCurrent: input.isCurrent,
        supportsRememberHostKey: false,
        cancel: async () => { declined = input.respond(false); await declined; },
    });
    // The SSH presenter deliberately absorbs cancellation errors. Consume the same
    // response again here so a failed managed decline cannot appear to have resumed.
    if (declined) return declined;
    if (!input.isCurrent()) return { kind: 'failed', code: 'continuation_retired' };
    if (typeof answer !== 'object' || answer === null) {
        return { kind: 'failed', code: 'no_prompt' };
    }
    const approved = 'approved' in answer ? answer.approved : 'trusted' in answer ? answer.trusted
        : 'replaceExistingServices' in answer ? answer.replaceExistingServices : undefined;
    return typeof approved === 'boolean' ? input.respond(approved) : { kind: 'failed', code: 'no_prompt' };
}

/**
 * The named administrator's new password, asked in the same Modal the installer uses for other secrets.
 * The password goes straight into the exact-prompt response and is not kept; declining cancels the creation.
 */
export async function answerManagedCreationEstablish(input: Readonly<{
    prompt: ManagedMachineBootstrapEstablishPromptV1;
    isCurrent: () => boolean;
    respond: (password: string) => Promise<Response>;
    decline: () => Promise<Response>;
}>): Promise<Response> {
    for (;;) {
        const password = await Modal.prompt(
            // Asked only when setup is creating this account; an existing account keeps its password and is never asked.
            t('managedMachines.identity.administratorPromptTitle'),
            t('managedMachines.identity.administratorPromptBody', { administrator: input.prompt.administratorUsername }),
            { inputType: 'secure-text', confirmText: t('common.continue'), cancelText: t('common.cancel') },
        );
        if (!input.isCurrent()) return { kind: 'failed', code: 'continuation_retired' };
        if (password === null) return input.decline();
        // The response contract requires a non-empty password; an empty field asks again.
        if (password) return input.respond(password);
    }
}
