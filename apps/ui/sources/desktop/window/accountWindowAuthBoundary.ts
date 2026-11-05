import { z } from 'zod/mini';
import { desktopHostKind, getDesktopHostWindowLabel, invokeDesktopHost } from '@/utils/platform/desktopHost';
import { emitDesktopWindowActionResult, executeDesktopWindowActionWithResult, listenDesktopWindowAction } from '@/utils/platform/desktopWindowActionBridge';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { HomeCredentialMutationNotice } from '@/auth/storage/tokenStorage';

export type DesktopAccountCredentialMutationNotice = Readonly<{
    mutations: readonly HomeCredentialMutationNotice[];
    sourceWindowLabel: string;
}>;

const DESKTOP_ADMITTED_AUTH_LOGOUT = 'desktop.auth.logout.admitted';
const DESKTOP_ACCOUNT_CREDENTIAL_JOURNEY = 'desktop.auth.credentialJourney';
const DesktopCredentialJourneySchema = z.strictObject({
    sourceHome: z.strictObject({ serverId: z.string(), serverUrl: z.string() }),
    entry: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('account_directory'), params: z.record(z.string(), z.string()) }),
        z.strictObject({ kind: z.literal('home'), profileRef: z.string(), returnTo: z.string() }),
        z.strictObject({ kind: z.literal('team'), profileRef: z.string(), teamId: z.string() }),
    ]),
});
export type DesktopCredentialJourney = z.infer<typeof DesktopCredentialJourneySchema>;
const DesktopAdmittedAuthLogoutSchema = z.strictObject({
    activeServer: z.strictObject({ serverUrl: z.string(), serverId: z.optional(z.string()) }),
    forgottenScope: z.nullable(z.strictObject({ serverId: z.string(), accountId: z.string() })),
    archiveServerId: z.string(),
    forgetAll: z.boolean(),
    targeted: z.boolean(),
    expectedCredentialScopeKey: z.optional(z.string()),
});

/** Admitted continuation: addresses and credential fingerprints, never bearer/key material. */
export type DesktopAdmittedAuthLogout = z.infer<typeof DesktopAdmittedAuthLogoutSchema>;

export async function requestAdmittedDesktopLogout(data: DesktopAdmittedAuthLogout): Promise<void> {
    const windowLabel = getDesktopHostWindowLabel();
    if (!windowLabel?.startsWith('destination_')) throw new Error('Desktop window identity unavailable');
    const outcome = await executeDesktopWindowActionWithResult({
        windowLabel: windowLabel as `destination_${string}`,
        actionIdentifier: DESKTOP_ADMITTED_AUTH_LOGOUT,
        data,
    });
    if (!outcome.ok) throw new Error('Failed to remove desktop Account credentials');
}

/** Restarts the existing sign-in in main; the envelope carries routing facts only. */
export async function requestDesktopCredentialJourney(data: DesktopCredentialJourney): Promise<void> {
    const windowLabel = getDesktopHostWindowLabel();
    if (!windowLabel?.startsWith('destination_')) throw new Error('Desktop window identity unavailable');
    const outcome = await executeDesktopWindowActionWithResult({
        windowLabel: windowLabel as `destination_${string}`,
        actionIdentifier: DESKTOP_ACCOUNT_CREDENTIAL_JOURNEY,
        data,
    });
    if (!outcome.ok) throw new Error('Failed to open Account sign-in in main');
}

export function listenDesktopAccountAuthActions(handlers: Readonly<{
    logout: (data: DesktopAdmittedAuthLogout) => Promise<void>;
    credentialJourney: (data: DesktopCredentialJourney) => Promise<void>;
}>): Promise<() => void> {
    return listenDesktopWindowAction(request => {
        if (!request.requestId || (request.actionIdentifier !== DESKTOP_ADMITTED_AUTH_LOGOUT
            && request.actionIdentifier !== DESKTOP_ACCOUNT_CREDENTIAL_JOURNEY)) return;
        const address = { windowLabel: request.windowLabel, requestId: request.requestId };
        fireAndForget((async () => {
            try {
                if (request.actionIdentifier === DESKTOP_ADMITTED_AUTH_LOGOUT) {
                    await handlers.logout(DesktopAdmittedAuthLogoutSchema.parse(request.data));
                } else {
                    await handlers.credentialJourney(DesktopCredentialJourneySchema.parse(request.data));
                }
                await emitDesktopWindowActionResult({ ...address, ok: true, phase: 'settled' });
            } catch {
                await emitDesktopWindowActionResult({ ...address, ok: false, phase: 'settled', errorCode: 'action_failed' });
            }
        })(), { tag: 'AuthContext.desktopLogout' });
    });
}

/** Logout retires windows after admission and before removing the outgoing credential. */
export async function retireDesktopAccountWindowsBeforeCredentialChange(scopes: readonly ServerAccountScope[]): Promise<void> {
    if (desktopHostKind() !== 'tauri' || scopes.length === 0) return;
    await invokeDesktopHost<void>('desktop_app_windows_teardown', { scopes });
}

/** A2: unsuccessful replacement must leave the outgoing windows alive. */
export async function completeDesktopAccountCredentialReplacement(scopes: readonly ServerAccountScope[], mutation: HomeCredentialMutationNotice): Promise<void> {
    if (desktopHostKind() !== 'tauri' || scopes.length === 0) return;
    try {
        await retireDesktopAccountWindowsBeforeCredentialChange(scopes);
    } finally {
        // Credentials have committed even if native destruction only partly succeeded.
        await publishDesktopAccountCredentialMutation([mutation]);
    }
}

/** Every app realm consumes the committed mutation through its existing local subscribers. */
export async function publishDesktopAccountCredentialMutation(mutations: readonly HomeCredentialMutationNotice[]): Promise<void> {
    if (desktopHostKind() !== 'tauri') return;
    await invokeDesktopHost<void>('desktop_app_windows_auth_changed', {
        mutations: mutations.map(({ kind, serverId, serverUrl }) => ({ kind, serverId, serverUrl })),
    });
}
