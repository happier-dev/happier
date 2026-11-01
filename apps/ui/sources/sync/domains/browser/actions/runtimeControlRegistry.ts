import type {
    BrowserRuntimeAutomationAdapter,
    BrowserRuntimeDiagnosticsAdapter,
    BrowserRuntimeControlAdapter,
    BrowserRuntimeWorkspaceOpeningAdapter,
} from './runtimeActionExecutor';
import { areServerAccountScopesEqual, serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type BrowserRuntimeControlRegistrationToken = Readonly<{
    id: symbol;
}>;

type BrowserRuntimeControlRegistration = Readonly<{
    token: BrowserRuntimeControlRegistrationToken;
    control: BrowserRuntimeControlAdapter;
    automation?: BrowserRuntimeAutomationAdapter;
    diagnostics?: BrowserRuntimeDiagnosticsAdapter;
}>;

export type BrowserRuntimeControlAdapterRegistration = Readonly<{
    browserSessionId: string;
    control: BrowserRuntimeControlAdapter;
    automation?: BrowserRuntimeAutomationAdapter | null | undefined;
    diagnostics?: BrowserRuntimeDiagnosticsAdapter | null | undefined;
}>;

const registrationsBySessionId = new Map<string, BrowserRuntimeControlRegistration[]>();
// Workspace presentation is registered here with the other Browser runtime owners. It does not
// register a view or create control state; Account qualification prevents same-id Home collisions.
const workspaceOpeners = new Map<string, BrowserRuntimeWorkspaceOpeningAdapter[]>();

export function registerBrowserRuntimeWorkspaceOpeningAdapter(owner: BrowserRuntimeWorkspaceOpeningAdapter): () => void {
    const lifetime = owner.accountLifetime;
    if (!lifetime?.isCurrent()) return () => {};
    const key = serverAccountScopedResourceKey(lifetime.scope, owner.scopeId);
    workspaceOpeners.set(key, [...(workspaceOpeners.get(key) ?? []), owner]);
    const dispose = () => {
        const remaining = (workspaceOpeners.get(key) ?? []).filter(candidate => candidate !== owner);
        if (remaining.length) workspaceOpeners.set(key, remaining);
        else workspaceOpeners.delete(key);
    };
    const retirement = lifetime.onRetire(dispose);
    return () => { retirement.dispose(); dispose(); };
}

/** The pane column a UI open came from; Details is kept off it (drawer over a side list). */
export type BrowserWorkspaceOpenerRegion = 'main' | 'side';

// The scope's current opener keeps deciding every open (platform, policy, tab). A UI caller in
// another pane column only lends the region it opened from, for the duration of its own command.
// Agents and external callers lend nothing, so their opens keep the owner's own region.
const claimedWorkspaceOpenRegions = new Map<string, BrowserWorkspaceOpenerRegion>();

function workspaceOpenCommandKey(scope: ServerAccountScope, scopeId: string, commandId: string): string {
    return JSON.stringify([serverAccountScopedResourceKey(scope, scopeId), commandId]);
}

/** Records, for one open command's duration, the pane column its UI caller sits in. */
export function claimBrowserRuntimeWorkspaceOpenRegion(
    input: Readonly<{ scope: ServerAccountScope; scopeId: string; commandId: string; region: BrowserWorkspaceOpenerRegion }>,
): () => void {
    const key = workspaceOpenCommandKey(input.scope, input.scopeId, input.commandId);
    claimedWorkspaceOpenRegions.set(key, input.region);
    return () => { claimedWorkspaceOpenRegions.delete(key); };
}

export function readClaimedBrowserRuntimeWorkspaceOpenRegion(
    scope: ServerAccountScope,
    scopeId: string,
    commandId: string,
): BrowserWorkspaceOpenerRegion | null {
    return claimedWorkspaceOpenRegions.get(workspaceOpenCommandKey(scope, scopeId, commandId)) ?? null;
}

export function readRegisteredBrowserRuntimeWorkspaceOpeningAdapter(
    scope: ServerAccountScope,
    scopeId: string,
): BrowserRuntimeWorkspaceOpeningAdapter | null {
    const owners = workspaceOpeners.get(serverAccountScopedResourceKey(scope, scopeId)) ?? [];
    for (let index = owners.length - 1; index >= 0; index--) {
        if (owners[index].accountLifetime?.isCurrent()) return owners[index];
    }
    return null;
}

function normalizeBrowserSessionId(browserSessionId: string): string {
    return browserSessionId.trim();
}

export function registerBrowserRuntimeControlAdapter(
    input: BrowserRuntimeControlAdapterRegistration,
): () => void {
    const browserSessionId = normalizeBrowserSessionId(input.browserSessionId);
    if (!browserSessionId) {
        return () => {};
    }

    const token = { id: Symbol(browserSessionId) };
    const registrations = registrationsBySessionId.get(browserSessionId) ?? [];
    registrations.push({
        token,
        control: input.control,
        ...(input.automation ? { automation: input.automation } : {}),
        ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    });
    registrationsBySessionId.set(browserSessionId, registrations);

    return () => {
        const current = registrationsBySessionId.get(browserSessionId);
        if (!current) return;
        const remaining = current.filter(registration => registration.token !== token);
        if (remaining.length) registrationsBySessionId.set(browserSessionId, remaining);
        else registrationsBySessionId.delete(browserSessionId);
    };
}

function readRegistration(browserSessionId: string, viewId?: string, scope?: ServerAccountScope): BrowserRuntimeControlRegistration | null {
    const sessionId = normalizeBrowserSessionId(browserSessionId);
    const registrations = registrationsBySessionId.get(sessionId) ?? [];
    // A Session can have several mounted tabs. Resolve an existing view at its actual host;
    // registration order only selects the host for a new view, or a relocated copy of one view.
    for (let index = registrations.length - 1; index >= 0; index--) {
        const registration = registrations[index];
        if (scope && (!registration.control.accountLifetime?.isCurrent()
            || !areServerAccountScopesEqual(scope, registration.control.accountLifetime.scope))) continue;
        if (!viewId || registration.control.readState()?.viewsById[viewId]?.browserSessionId === sessionId) return registration;
    }
    return null;
}

export function readRegisteredBrowserRuntimeControlAdapter(
    browserSessionId: string,
    viewId?: string,
    scope?: ServerAccountScope,
): BrowserRuntimeControlAdapter | null {
    return readRegistration(browserSessionId, viewId, scope)?.control ?? null;
}

export function readRegisteredBrowserRuntimeAutomationAdapter(
    browserSessionId: string,
    viewId?: string,
    scope?: ServerAccountScope,
): BrowserRuntimeAutomationAdapter | null {
    return readRegistration(browserSessionId, viewId, scope)?.automation ?? null;
}

export function readRegisteredBrowserRuntimeDiagnosticsAdapter(browserSessionId: string, viewId: string): BrowserRuntimeDiagnosticsAdapter | null {
    return readRegistration(browserSessionId, viewId)?.diagnostics ?? null;
}

export function clearBrowserRuntimeControlRegistryForTests(): void {
    registrationsBySessionId.clear();
    workspaceOpeners.clear();
    claimedWorkspaceOpenRegions.clear();
}
