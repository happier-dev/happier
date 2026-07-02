export function createProviderSettingsRoute(providerId: string): string {
    return `/(app)/settings/providers/${encodeURIComponent(providerId)}`;
}
