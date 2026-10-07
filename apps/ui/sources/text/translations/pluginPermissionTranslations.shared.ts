

export type PermissionDetailsTranslation = Readonly<{
    fields: Readonly<{
        pluginId: string;
        capability: string;
        scope: string;
        requester: string;
        authority: string;
        requestedAt: string;
        reason: string;
    }>;
    scope: Readonly<{ account: string; project: string; workspace: string }>;
    requester: Readonly<{ user: string; host: string; plugin: string }>;
    authority: Readonly<{ bundled: string; machineInstallation: string }>;
    identifiers: Readonly<{
        session: string;
        request: string;
        machine: string;
        installation: string;
    }>;
    accessibilitySummary: (params: Readonly<{ details: string }>) => string;
}>;


export const pluginPermissionTranslationsEnglish = { en: {
        fields: {
            pluginId: 'Plugin ID',
            capability: 'Capability',
            scope: 'Scope',
            requester: 'Requester',
            authority: 'Authority',
            requestedAt: 'Request time',
            reason: 'Reason',
        },
        scope: { account: 'Account', project: 'Project', workspace: 'Workspace' },
        requester: { user: 'User', host: 'Host', plugin: 'Plugin' },
        authority: { bundled: 'Bundled', machineInstallation: 'Machine installation' },
        identifiers: {
            session: 'Session',
            request: 'Request',
            machine: 'Machine',
            installation: 'Installation',
        },
        accessibilitySummary: ({ details }) => `Permission request details. ${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "en">;