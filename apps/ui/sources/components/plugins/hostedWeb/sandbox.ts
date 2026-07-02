export type PluginHostedWebSandboxPolicy = Readonly<{
    scripts: boolean;
    sameOrigin: boolean;
    popups: boolean;
    topNavigation: boolean;
    mixedContent: boolean;
}>;

export function resolvePluginHostedWebIframeSandbox(policy: PluginHostedWebSandboxPolicy): string {
    const entries: string[] = [];
    if (policy.scripts) entries.push('allow-scripts');
    if (policy.sameOrigin) entries.push('allow-same-origin');
    if (policy.popups) entries.push('allow-popups');
    if (policy.topNavigation) entries.push('allow-top-navigation-by-user-activation');
    return entries.join(' ');
}
