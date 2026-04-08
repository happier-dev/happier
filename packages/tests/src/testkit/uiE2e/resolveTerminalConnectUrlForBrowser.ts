export function resolveTerminalConnectUrlForBrowser(params: Readonly<{
    connectUrl: string;
    uiBaseUrl: string;
    serverUrl?: string | null | undefined;
}>): string {
    void params.uiBaseUrl;
    const normalizedUrl = String(params.connectUrl ?? '').trim().replace(/\/+$/, '');
    const fallbackServerUrl = String(params.serverUrl ?? '').trim();
    if (!fallbackServerUrl) return normalizedUrl;

    try {
        const parsed = new URL(normalizedUrl);
        const hashTail = String(parsed.hash ?? '').replace(/^#/, '');
        if (!hashTail) return normalizedUrl;

        const hashParams = new URLSearchParams(hashTail);
        if (!hashParams.get('key')) return normalizedUrl;
        if ((hashParams.get('server') ?? '').trim()) return normalizedUrl;

        hashParams.set('server', fallbackServerUrl);
        parsed.hash = hashParams.toString();
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return normalizedUrl;
    }
}
