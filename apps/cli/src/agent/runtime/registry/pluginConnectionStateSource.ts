export type PluginDaemonConnectionStateSource = Readonly<{
    onConnectionStateChange(listener: (state: unknown) => void): () => void;
}>;

let activeDaemonConnectionStateSource: PluginDaemonConnectionStateSource | null = null;

export function bindPluginDaemonConnectionStateSource(
    source: PluginDaemonConnectionStateSource,
): () => void {
    activeDaemonConnectionStateSource = source;
    let disposed = false;
    return () => {
        if (disposed) {
            return;
        }
        disposed = true;
        if (activeDaemonConnectionStateSource === source) {
            activeDaemonConnectionStateSource = null;
        }
    };
}

export function readPluginDaemonConnectionStateSource(): PluginDaemonConnectionStateSource | null {
    return activeDaemonConnectionStateSource;
}
