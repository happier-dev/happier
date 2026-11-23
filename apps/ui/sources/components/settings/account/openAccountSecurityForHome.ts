import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { focusExactHomeAndRefresh } from '@/sync/domains/server/focusExactHome';

export const ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT = 'email_password_connect' as const;

/** Focuses and connects the exact authenticated Home before mounting Settings consumers. */
export async function openAccountSecurityForHome(params: Readonly<{
    serverId: string;
    router: Pick<ReturnType<typeof useRouter>, 'replaceAdmitted'>;
    refreshAuth: () => Promise<void>;
    intent?: typeof ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT;
    verificationToken?: string;
}>): Promise<boolean> {
    // A capability link can target another Account credential on the current
    // Home, so the exact profile — not just its stable identity — must be
    // focused and refreshed before any Security reader is exposed.
    if (!await focusExactHomeAndRefresh({ serverId: params.serverId, refreshAuth: params.refreshAuth })) {
        return false;
    }
    params.router.replaceAdmitted({
        pathname: SETTINGS_ROUTES.accountSecurity,
        params: {
            serverId: params.serverId,
            ...(params.intent ? { intent: params.intent } : {}),
            ...(params.verificationToken ? { verificationToken: params.verificationToken } : {}),
        },
    });
    return true;
}
