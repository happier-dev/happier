/** One demand edge for the private shared Host API response and control kernel. */
export function loadPluginUiHostSupport(): Promise<typeof import('@happier-dev/cli-common/plugins/ui')> {
    return import('@happier-dev/cli-common/plugins/ui');
}
