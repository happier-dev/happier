export interface Disposable {
    dispose(): void | Promise<void>;
}

export type PluginCancellationOptions = Readonly<{
    signal?: AbortSignal;
}>;
