import type { TranslationKey } from '@/text';
import type { PermissionPromptProtocol } from '@/agents/registry/registryCore';

export type PermissionFooterCopy =
    | Readonly<{
        protocol: 'codexDecision';
        yesAlwaysAllowCommandKey: TranslationKey;
        yesForSessionKey: TranslationKey;
        stopKey: TranslationKey;
    }>
    | Readonly<{
        protocol: 'claude';
        yesAllowAllEditsKey: TranslationKey;
        yesForToolKey: TranslationKey;
        stopKey: TranslationKey;
    }>;

/**
 * Footer copy for whichever permission-prompt protocol the owning Agent speaks.
 *
 * The protocol arrives as a fact of the Agent's UI behavior — built from a
 * bundled Agent's core, declared by an installed Agent in the same public
 * `permissions` block — so the copy owner never has to know whether this build
 * ships that Agent. It stays total on purpose: a pending request is
 * unanswerable without a footer, so an Agent that declares no protocol (or one
 * this build does not recognise) lands on the neutral Claude-shaped default.
 */
export function getPermissionFooterCopy(
    promptProtocol: PermissionPromptProtocol | null | undefined,
): PermissionFooterCopy {
    if (promptProtocol === 'codexDecision') {
        return {
            protocol: promptProtocol,
            yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
            yesForSessionKey: 'codex.permissions.yesForSession',
            stopKey: 'codex.permissions.stop',
        };
    }

    return {
        protocol: 'claude',
        yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
        yesForToolKey: 'claude.permissions.yesForTool',
        stopKey: 'claude.permissions.stop',
    };
}
