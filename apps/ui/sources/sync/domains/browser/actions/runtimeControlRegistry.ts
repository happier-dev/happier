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

const registrationsBySessionId = new Map<string, BrowserRuntimeControlRegistration>();

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
    registrationsBySessionId.set(browserSessionId, {
        token,
        control: input.control,
        ...(input.automation ? { automation: input.automation } : {}),
    });

    return () => {
        if (registrationsBySessionId.get(browserSessionId)?.token === token) {
            registrationsBySessionId.delete(browserSessionId);
        }
    };
}

export function readRegisteredBrowserRuntimeControlAdapter(
    browserSessionId: string,
): BrowserRuntimeControlAdapter | null {
    return registrationsBySessionId.get(normalizeBrowserSessionId(browserSessionId))?.control ?? null;
}

export function readRegisteredBrowserRuntimeAutomationAdapter(
    browserSessionId: string,
): BrowserRuntimeAutomationAdapter | null {
    return registrationsBySessionId.get(normalizeBrowserSessionId(browserSessionId))?.automation ?? null;
}

export function clearBrowserRuntimeControlRegistryForTests(): void {
    registrationsBySessionId.clear();
}
