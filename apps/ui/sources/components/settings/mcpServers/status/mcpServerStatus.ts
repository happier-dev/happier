import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { listValueRefSecretIdsV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import type { SavedSecretCatalogProjection } from '@/components/secrets/useSavedSecretCatalog';

import { pickMostBlockingCapabilityStatus, presentCapabilityStatus, type CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import type { SessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { describeCapabilityNoticeReason, readCapabilityNoticeReason } from '@/components/capabilities/status/capabilityNoticeReason';

/**
 * A server's sign-in as the status owner reads it (T2 states, U7.9's `useMcpServerSignIn`). `null`: the
 * server does not sign in (no OAuth), so sign-in never speaks.
 */
export type McpServerSignInFact =
    | Readonly<{ state: 'not_connected' | 'did_not_finish' | 'no_machine_online' | 'client_refused' | 'invalid_client' }>
    | Readonly<{ state: 'signing' }>
    | Readonly<{ state: 'connected' }>
    | Readonly<{ state: 'needs_more_access' }>
    | Readonly<{ state: 'expired'; reason: 'expired' | 'address_changed'; at?: string }>
    | Readonly<{ state: 'revoked' }>
    | null;

/** One machine's latest Test answer, held for the app session (T7). */
export type McpServerTestFact =
    | Readonly<{ ok: true; toolCount: number; checkedAt: number }>
    | Readonly<{ ok: false; errorCode: string; runtimeMissing?: string; checkedAt: number }>;

/** A machine where the server is on (P2 projection), with REACH's presence. */
export type McpServerMachineFact = Readonly<{ machineId: string; name: string; online: boolean | null; lastSeen?: string }>;

export type McpServerStatusFixes = Readonly<{
    signIn: () => void;
    reconnect: () => void;
    grantAccess: () => void;
    addKey?: () => void;
    howToFix: (machineId: string) => void;
    tryAgain: (machineId: string) => void;
}>;

export type McpServerStatusInput = Readonly<{
    entry: McpServerCatalogEntryV1;
    signIn: McpServerSignInFact;
    tests: Readonly<Record<string, McpServerTestFact | undefined>>;
    machines: readonly McpServerMachineFact[];
    savedSecretCatalog: McpSavedSecretAvailability;
    fixes: McpServerStatusFixes;
    /** Only the calling Session's transcript; Account settings pages omit this. */
    sessionNotices?: readonly SessionCapabilityNoticeV1[];
}>;

/** The Saved Secret owner alone decides whether a reference is usable. */
export type McpSavedSecretAvailability = Pick<SavedSecretCatalogProjection, 'resolveReference'>;

export function mcpServerNeedsKey(entry: McpServerCatalogEntryV1, catalog: McpSavedSecretAvailability): boolean {
    return mcpServerMissingKeyNames(entry, catalog).size > 0;
}

/** The env and header names whose Saved Secret is missing: where the banner's "Add key" lands. */
export function mcpServerMissingKeyNames(entry: McpServerCatalogEntryV1, catalog: McpSavedSecretAvailability): ReadonlySet<string> {
    const names = new Set<string>();
    const named = [...Object.entries(entry.env), ...Object.entries(entry.remote?.headers ?? {})];
    for (const [name, ref] of named) for (const secretId of listValueRefSecretIdsV1(ref)) {
        if (catalog.resolveReference(secretId).status !== 'ready') names.add(name);
    }
    return names;
}

/**
 * Every status a server has right now, in P5's vocabulary (T7 mapping). The page's banner and the rail
 * pick the most blocking one through `pickMostBlockingCapabilityStatus`; the machine rows read the
 * per-machine entries (each names its machine). Settings pages pass no session notices.
 */
export function mcpServerStatus(input: McpServerStatusInput): readonly CapabilityStatus[] {
    const statuses: CapabilityStatus[] = [];
    const { fixes } = input;
    const signIn = input.signIn;
    if (signIn) {
        switch (signIn.state) {
            case 'not_connected':
            case 'did_not_finish':
            case 'no_machine_online':
            case 'client_refused':
            case 'invalid_client':
                statuses.push({ kind: 'signin', fix: { kind: 'sign_in', onPress: fixes.signIn } });
                break;
            case 'signing':
                statuses.push({ kind: 'signing' });
                break;
            case 'connected':
                statuses.push({ kind: 'connected' });
                break;
            case 'needs_more_access':
                statuses.push({ kind: 'more_access', fix: { kind: 'grant_access', onPress: fixes.grantAccess } });
                break;
            case 'expired':
                statuses.push({ kind: 'expired', ...(signIn.at ? { detail: signIn.at } : {}), fix: { kind: 'reconnect', onPress: fixes.reconnect } });
                break;
            case 'revoked':
                statuses.push({ kind: 'revoked', fix: { kind: 'sign_in', onPress: fixes.signIn } });
                break;
        }
    }
    if (mcpServerNeedsKey(input.entry, input.savedSecretCatalog)) {
        statuses.push({ kind: 'key', ...(fixes.addKey ? { fix: { kind: 'add_key' as const, onPress: fixes.addKey } } : {}) });
    }
    statuses.push(...mcpServerMachineStatuses(input).values());
    for (const notice of input.sessionNotices ?? []) for (const item of notice.items) {
        if (item.kind !== 'mcp_server' || item.itemId !== input.entry.id) continue;
        // One reading of the runtime's reason (shared with the transcript notice): a reason the person can act
        // on is that status with its fix, and only an unexplained stop is a failure.
        const reason = readCapabilityNoticeReason(item);
        if (reason?.kind === 'sign_in') {
            // The current grant/attempt owner supersedes this historical missing-auth condition.
            if (!input.signIn) statuses.push({ kind: 'signin', fix: { kind: 'sign_in', onPress: fixes.signIn } });
            continue;
        }
        if (reason?.kind === 'missing_key') {
            if (!statuses.some(status => status.kind === 'key')) statuses.push({ kind: 'key', detail: reason.key,
                ...(fixes.addKey ? { fix: { kind: 'add_key' as const, onPress: fixes.addKey } } : {}) });
            continue;
        }
        const machine = input.machines[0];
        statuses.push({ kind: 'error', ...(machine ? { machineName: machine.name } : {}),
            ...(reason ? { detail: describeCapabilityNoticeReason(reason) } : {}),
            ...(machine ? { fix: { kind: 'try_again' as const, onPress: () => fixes.tryAgain(machine.machineId) } } : {}) });
    }
    return statuses;
}

/**
 * What a list says about a server: the most blocking sign-in, key or held Test status the person must act on, the
 * same one the page's banner leads with. Quiet while signing in, when connected and for a server that needs nothing;
 * null when it needs nothing. `open` is where every fix leads (the server's page); without it the status is drawn
 * fix-less, for a list whose action column owns the fix.
 */
export function mcpServerAttentionStatus(input: Pick<McpServerStatusInput, 'entry' | 'signIn' | 'savedSecretCatalog'>
    & Partial<Pick<McpServerStatusInput, 'tests' | 'machines'>> & Readonly<{ open?: () => void }>): CapabilityStatus | null {
    const go = input.open ?? (() => {});
    const needsYou = mcpServerStatus({
        entry: input.entry,
        signIn: input.signIn,
        savedSecretCatalog: input.savedSecretCatalog,
        tests: input.tests ?? {},
        machines: input.machines ?? [],
        fixes: { signIn: go, reconnect: go, grantAccess: go, addKey: go, howToFix: go, tryAgain: go },
    }).filter((status) => {
        const tone = presentCapabilityStatus(status, 'row').tone;
        return tone === 'needs_you' || tone === 'failed';
    });
    const top = pickMostBlockingCapabilityStatus(needsYou, 'row');
    if (top === null || input.open !== undefined) return top;
    return { kind: top.kind, ...(top.detail ? { detail: top.detail } : {}),
        ...(top.machineName ? { machineName: top.machineName } : {}) };
}

/** Each machine's own status (offline, can't run, stopped), keyed by machine id; healthy machines are absent. */
export function mcpServerMachineStatuses(input: Pick<McpServerStatusInput, 'tests' | 'machines' | 'fixes'>): ReadonlyMap<string, CapabilityStatus> {
    const result = new Map<string, CapabilityStatus>();
    for (const machine of input.machines) {
        const test = input.tests[machine.machineId];
        if (machine.online === null) continue;
        if (machine.online === false) {
            result.set(machine.machineId, { kind: 'offline', machineName: machine.name, ...(machine.lastSeen ? { detail: machine.lastSeen } : {}) });
            continue;
        }
        if (!test || test.ok) continue;
        result.set(machine.machineId, test.runtimeMissing
            ? { kind: 'cantrun', machineName: machine.name, detail: test.runtimeMissing, fix: { kind: 'how_to_fix', onPress: () => input.fixes.howToFix(machine.machineId) } }
            : { kind: 'error', machineName: machine.name, fix: { kind: 'try_again', onPress: () => input.fixes.tryAgain(machine.machineId) } });
    }
    return result;
}
