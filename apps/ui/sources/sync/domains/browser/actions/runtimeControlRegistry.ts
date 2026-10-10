import type {
    BrowserRuntimeAutomationAdapter,
    BrowserRuntimeControlAdapter,
} from './runtimeActionExecutor';

type BrowserRuntimeControlRegistrationToken = Readonly<{
    id: symbol;
}>;

type BrowserRuntimeControlRegistration = Readonly<{
    token: BrowserRuntimeControlRegistrationToken;
    control: BrowserRuntimeControlAdapter;
    automation?: BrowserRuntimeAutomationAdapter;
}>;

export type BrowserRuntimeControlAdapterRegistration = Readonly<{
    browserSessionId: string;
    control: BrowserRuntimeControlAdapter;
    automation?: BrowserRuntimeAutomationAdapter | null | undefined;
}>;

const registrationsBySessionId = new Map<string, BrowserRuntimeControlRegistration[]>();

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

function readRegistration(browserSessionId: string, viewId?: string): BrowserRuntimeControlRegistration | null {
    const sessionId = normalizeBrowserSessionId(browserSessionId);
    const registrations = registrationsBySessionId.get(sessionId) ?? [];
    // A Session can have several mounted tabs. Resolve an existing view at its actual host;
    // registration order only selects the host for a new view, or a relocated copy of one view.
    for (let index = registrations.length - 1; index >= 0; index--) {
        const registration = registrations[index];
        if (!viewId || registration.control.readState()?.viewsById[viewId]?.browserSessionId === sessionId) return registration;
    }
    return null;
}

export function readRegisteredBrowserRuntimeControlAdapter(
    browserSessionId: string,
    viewId?: string,
): BrowserRuntimeControlAdapter | null {
    return readRegistration(browserSessionId, viewId)?.control ?? null;
}

export function readRegisteredBrowserRuntimeAutomationAdapter(
    browserSessionId: string,
    viewId?: string,
): BrowserRuntimeAutomationAdapter | null {
    return readRegistration(browserSessionId, viewId)?.automation ?? null;
}

export function clearBrowserRuntimeControlRegistryForTests(): void {
    registrationsBySessionId.clear();
}
