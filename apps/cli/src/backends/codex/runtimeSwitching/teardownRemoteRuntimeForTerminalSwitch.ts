type CodexRemoteRuntimeForLocalSwitch = Readonly<{
    reset: () => Promise<void>;
}>;

type CodexRemoteClientForLocalSwitch = Readonly<{
    disconnect: () => Promise<void>;
}>;

export async function teardownRemoteRuntimeForTerminalSwitch<TPending>(params: Readonly<{
    client: CodexRemoteClientForLocalSwitch | null;
    getRemoteRuntime: () => CodexRemoteRuntimeForLocalSwitch | null;
    setWasCreated: (value: boolean) => void;
    setPending: (value: TPending | null) => void;
    setThinking: (value: boolean) => void;
}>): Promise<'local'> {
    try {
        if (params.client) {
            await params.client.disconnect();
        } else {
            await params.getRemoteRuntime()?.reset();
        }
    } catch {
        // ignore
    }

    params.setWasCreated(false);
    params.setPending(null);
    params.setThinking(false);

    return 'local';
}
