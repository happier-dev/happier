import { z } from 'zod/mini';
import { SessionOpenDestinationSchema } from '@happier-dev/protocol/actions/sessionOpenDestination';
import { resolveBootCredentials } from '@/boot/resolveBootCredentials';
import { invokeDesktopHost } from '@/utils/platform/desktopHost';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { DesktopWindowTarget } from '@happier-dev/protocol/actions/actionSpecs';
import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { scmComparisonSourceOf } from '@/sync/domains/scm/diffSummary/selection';
import { runAppBootSequence, type AppBootSequence } from '@/boot/runAppBootSequence';

const identifier = z.string().check(z.minLength(1));
const AppWindowAddressSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('home') }),
    z.object({ kind: z.literal('session'), sessionId: identifier, destination: z.optional(SessionOpenDestinationSchema) }),
    z.object({ kind: z.literal('workspaceTab'), tabId: identifier }),
    z.object({ kind: z.literal('destination'), target: z.object({ kind: identifier, params: z.record(z.string(), z.string()) }) }),
    z.object({ kind: z.literal('paneTab'), layoutId: identifier, scopeId: identifier, resourceId: z.optional(identifier), tabKey: identifier }),
]);

export const AppWindowRecordSchema = z.object({
    windowId: identifier,
    accountId: identifier,
    homeId: identifier,
    layoutId: identifier,
    chrome: z.optional(z.literal('full')),
    sourceLayoutId: z.optional(identifier),
    sourceTabId: z.optional(identifier),
    selectedAddress: AppWindowAddressSchema,
});

export type AppWindowAddress = z.infer<typeof AppWindowAddressSchema>;
export type AppWindowRecord = z.infer<typeof AppWindowRecordSchema>;

/** The ordinary route owner has already admitted the destination and its exact scope. */
export function desktopSessionTargetForDestination(ref: DestinationRef, scope: ServerAccountScope): Extract<DesktopWindowTarget, { kind: 'session' }> | null {
    if (ref.kind !== 'session' || !ref.params.id) return null;
    const details = parseSessionPaneUrlState(ref.params)?.details;
    return { kind: 'session', sessionId: ref.params.id,
        serverId: ref.params.serverId ?? scope.serverId, accountId: ref.params.accountId ?? scope.accountId,
        ...(details?.kind === 'scmReview' && details.comparison && details.view ? { destination: { kind: 'scmReview',
            comparison: scmComparisonSourceOf(details.comparison, ref.params.id), view: details.view,
            ...(details.comparison.comparisonId ? { comparisonId: details.comparison.comparisonId } : {}),
            ...(typeof details.explain === 'boolean' ? { explain: details.explain } : {}),
        } } : {}),
    };
}

/** Native resolves the actual caller label. Records contain context, never credentials or roles. */
export async function readDesktopAppWindowRecord(): Promise<AppWindowRecord | null> {
    const record = await invokeDesktopHost<unknown>('desktop_app_window_read');
    return record === null ? null : AppWindowRecordSchema.parse(record);
}

/** Selects this realm's saved Home before credential resolution and the ordinary Sync boot. */
export async function resolveDesktopAppWindowBootCredentials(platformOs: string): Promise<AuthCredentials | null> {
    let record: AppWindowRecord | undefined;
    try {
        record = await readDesktopAppWindowRecord() ?? undefined;
        const credentials = record ? await resolveBootCredentials(platformOs, { serverId: record.homeId, accountId: record.accountId }) : null;
        if (credentials) return credentials;
        if (record?.chrome === 'full') return null;
    } catch {
        // The recipient is still hidden: settle its opener even when ordinary Auth cannot mount it.
    }
    const { failDesktopAppWindow } = await import('./appWindowRuntime');
    await failDesktopAppWindow(record, 'metadata_unavailable');
    return null;
}

/** A hidden recipient must settle its opener even when boot fails before the route mounts. */
export async function runDesktopAppWindowBootSequence(sequence: AppBootSequence): Promise<void> {
    try {
        await runAppBootSequence(sequence);
    } catch (error) {
        const { failDesktopAppWindow } = await import('./appWindowRuntime');
        try {
            await failDesktopAppWindow(undefined, 'presentation_unavailable');
        } finally {
            throw error;
        }
    }
}
