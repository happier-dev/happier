import type { ItemAction } from '@/components/ui/lists/itemActions';
import {
    isConnectedServiceCredentialHealthStatusUsable,
    type ConnectedServiceCredentialHealthStatusV1,
} from '@happier-dev/protocol';
import { t } from '@/text';

/**
 * The reconnect / re-authenticate glyph for a connected-service account row.
 *
 * Deliberately NOT a refresh icon: a refresh-style glyph now means "refresh this
 * account's usage + limits" (the dedicated control on `AccountBlock`), so the
 * advanced reconnect action must read as a distinct re-auth/sign-in action. This
 * is the SINGLE source of truth for the reconnect glyph — every reconnect
 * affordance (account-detail row kebab, profile-detail header, inline rows) reads
 * it from here so the icon can never drift back to a refresh look.
 */
export const CONNECTED_SERVICE_RECONNECT_ICON = 'log-in-outline';

export type ConnectedServiceAccountKind = 'token' | 'oauth' | null;

/**
 * Build the ordered overflow-menu actions for a connected-service account row.
 *
 * ONE builder for every account surface (the per-provider detail list, the
 * single-profile detail header, …) so the action set, ordering, icons, and
 * kind/status gating live in exactly one place. Each action is included only when
 * its handler is supplied AND its kind/status precondition holds, so a caller that
 * lacks (say) an open/disconnect handler simply omits it — no parallel inline
 * action arrays drifting across screens.
 */
export function buildConnectedServiceAccountRowActions(params: Readonly<{
    kind: ConnectedServiceAccountKind;
    status: ConnectedServiceCredentialHealthStatusV1 | null;
    /** Open the account's own detail screen. */
    onOpen?: () => void;
    /** Rename the account's display label. */
    onEditLabel?: () => void;
    /** Replace the stored token (token accounts only). */
    onReplaceToken?: () => void;
    /** Re-run the OAuth connect flow (oauth accounts only). */
    onReconnect?: () => void;
    /** Disconnect / remove the credential (usable account records only). */
    onDisconnect?: () => void;
}>): ItemAction[] {
    const { kind, status } = params;
    const actions: ItemAction[] = [];

    if (params.onOpen) {
        actions.push({
            id: 'open',
            title: t('connectedServices.detail.actions.openAccount'),
            icon: 'open-outline',
            onPress: params.onOpen,
        });
    }
    if (params.onEditLabel) {
        actions.push({
            id: 'label',
            title: t('connectedServices.detail.actions.editLabel'),
            icon: 'pencil-outline',
            onPress: params.onEditLabel,
        });
    }
    if (kind === 'token' && params.onReplaceToken) {
        actions.push({
            id: 'replace-token',
            title: t('connectedServices.detail.actions.replaceToken'),
            icon: 'key-outline',
            onPress: params.onReplaceToken,
        });
    }
    if (kind === 'oauth' && params.onReconnect) {
        actions.push({
            id: 'reconnect',
            title: t('connectedServices.detail.actions.reconnect'),
            icon: CONNECTED_SERVICE_RECONNECT_ICON,
            onPress: params.onReconnect,
        });
    }
    if (isConnectedServiceCredentialHealthStatusUsable(status) && params.onDisconnect) {
        actions.push({
            id: 'disconnect',
            title: t('modals.disconnect'),
            icon: 'trash-outline',
            destructive: true,
            onPress: params.onDisconnect,
        });
    }

    return actions;
}
