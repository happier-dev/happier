/** One demand edge for the SDK's guest bootstrap and host response codecs. */
export function loadPluginUiHostSupport(): Promise<typeof import('@happier-dev/cli-common/plugins/ui')> {
    return import('@happier-dev/cli-common/plugins/ui');
}
