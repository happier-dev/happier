import { getTranslationValue, preloadTranslations, resolveSupportedLanguageFromTag } from '@/text/i18n';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { VoiceWelcomeSettings } from '@/voice/settings/welcome';

function resolveWelcomeLanguage(assistantLanguage: string | null | undefined) {
    return assistantLanguage?.trim() ? resolveSupportedLanguageFromTag(assistantLanguage) : null;
}

export function isVoiceWelcomeLanguageSupported(assistantLanguage: string | null | undefined): boolean {
    return resolveWelcomeLanguage(assistantLanguage) !== null;
}

export async function preloadVoiceWelcomeText(assistantLanguage: string | null | undefined): Promise<void> {
    const supported = resolveWelcomeLanguage(assistantLanguage);
    if (supported) await preloadTranslations(supported);
}

/** A literal follows Reply in only; automatic and unsupported languages stay model-generated. */
export function resolveVoiceWelcomeText(
    assistantLanguage: string | null | undefined,
    bound?: Readonly<{ targetDisplayName: string }>,
): string | undefined {
    const supported = resolveWelcomeLanguage(assistantLanguage);
    if (!supported) return undefined;
    const template = getTranslationValue(bound ? 'voicePresence.boundWelcomeText' : 'voicePresence.welcomeText', supported);
    const text = typeof template === 'function' && bound ? template({ name: bound.targetDisplayName }) : template;
    return typeof text === 'string' && text.trim() ? text : undefined;
}

/** Selection is a Doc in the captured Account's Home; its text is a literal, not a prompt-stack block. */
export async function resolveSelectedVoiceWelcomeText(args: Readonly<{
    assistantLanguage: string | null | undefined;
    welcome: Pick<VoiceWelcomeSettings, 'enabled' | 'templateId'>;
    targetDisplayName?: string | null;
    serverId?: string | null;
    accountContext?: LazyActionAccountContext;
    signal?: AbortSignal;
}>): Promise<string | undefined> {
    args.signal?.throwIfAborted();
    args.accountContext?.assertCurrent();
    if (!args.welcome.enabled) return undefined;
    if (args.welcome.templateId !== null) {
        const ref = { kind: 'doc' as const, artifactId: args.welcome.templateId };
        try {
            const [{ readPromptDocInLibrary }, { withUiPromptLibraryArtifactReader }] = await Promise.all([
                import('@happier-dev/protocol/prompts/library/promptLibraryActionOperations'),
                import('@/sync/ops/promptLibrary/promptLibraryArtifactStore'),
            ]);
            args.signal?.throwIfAborted();
            args.accountContext?.assertCurrent();
            const doc = await withUiPromptLibraryArtifactReader(reader => readPromptDocInLibrary({
                store: { read: id => reader.readArtifact({ ...ref, artifactId: id }) },
                artifactId: ref.artifactId,
                signal: args.signal,
            }), args);
            args.signal?.throwIfAborted();
            args.accountContext?.assertCurrent();
            if (!doc.ok) throw new PromptStackPreparationError(doc.errorCode === 'prompt_doc_not_found' ? 'not_found'
                : doc.errorCode === 'prompt_doc_wrong_kind' ? 'wrong_kind' : 'malformed', ref);
            return doc.markdown;
        } catch (error) {
            args.signal?.throwIfAborted();
            if (error instanceof PromptStackPreparationError) throw error;
            throw new PromptStackPreparationError('unavailable', ref);
        }
    }
    await preloadVoiceWelcomeText(args.assistantLanguage);
    args.signal?.throwIfAborted();
    args.accountContext?.assertCurrent();
    return resolveVoiceWelcomeText(args.assistantLanguage,
        args.targetDisplayName ? { targetDisplayName: args.targetDisplayName } : undefined);
}
