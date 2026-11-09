import type { AccountApiTokenSelfV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { deriveEmbedAccessFromGrantV1, type EmbedUiOverridesV1 } from '@happier-dev/protocol/embed';

import type { SessionViewEmbeddedPresentation } from '@/components/sessions/shell/embedded/embeddedSessionPresentation';

import type { EmbedSessionRuntimeSnapshot } from './runtime/createEmbedSessionRuntime';

/**
 * Whether the embed's chats may show the model picker: the host may hide it, never add it. The
 * enforced half is the grant's own "Change model" decision, the same derivation Settings → Embeds
 * edits and previews (`deriveEmbedAccessFromGrantV1().changeModel`), so a picker never offers a
 * change the grant refuses.
 */
export function isEmbedModelPickerShown(self: AccountApiTokenSelfV1 | null, ui: EmbedUiOverridesV1): boolean {
    if (ui.modelPicker === false || self === null) return false;
    return deriveEmbedAccessFromGrantV1(self.grant).changeModel;
}

/** The embedded Session presentation for the admitted scope; the renderer intersects capabilities itself. */
export function buildEmbedSessionPresentation(
    snapshot: Pick<EmbedSessionRuntimeSnapshot, 'phase' | 'self' | 'ui'> & Partial<Pick<EmbedSessionRuntimeSnapshot, 'reconnecting'>>,
): SessionViewEmbeddedPresentation {
    return {
        kind: 'embedded',
        navigation: 'none',
        // Approve may be granted without Send, so hiding the composer must not hide granted approval actions.
        composer: 'auto',
        composerInputLocked: snapshot.reconnecting === true,
        attachments: snapshot.self?.embedConfig?.ui.attachments !== false && snapshot.ui.attachments !== false,
        modelPicker: isEmbedModelPickerShown(snapshot.self, snapshot.ui),
        // Change model is its own grant decision, independent of Send.
        modelSelectionGranted: snapshot.self !== null && deriveEmbedAccessFromGrantV1(snapshot.self.grant).changeModel,
        allowedModels: snapshot.self?.grant.models ?? null,
        permissionModePicker: snapshot.self?.grant.permissionModes ?? null,
        readOnlyNotice: 'readOnly',
    };
}
