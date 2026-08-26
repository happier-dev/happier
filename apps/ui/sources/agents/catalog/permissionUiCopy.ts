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
    }>
    | Readonly<{
        /**
         * A missing or unsupported prompt contract must never acquire another
         * Agent's approval semantics. The footer can only reject it.
         */
        protocol: 'unavailable';
        denyKey: TranslationKey;
    }>;

/**
 * Footer copy for whichever permission-prompt protocol the owning Agent speaks.
 *
 * The protocol arrives as a fact of the Agent's UI behavior — built from a
 * bundled Agent's core, declared by an installed Agent in the same public
 * `permissions` block — so the copy owner never has to know whether this build
 * ships that Agent. It stays total on purpose: a pending request is
 * unanswerable without a footer, so an Agent that declares no known protocol
 * gets only the neutral rejecting action.
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

    if (promptProtocol === 'claude') {
        return {
            protocol: promptProtocol,
            yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
            yesForToolKey: 'claude.permissions.yesForTool',
            stopKey: 'claude.permissions.stop',
        };
    }

    return {
        protocol: 'unavailable',
        denyKey: 'common.no',
    };
}
