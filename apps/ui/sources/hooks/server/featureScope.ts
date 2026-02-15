export type FeatureScopeParams =
    | Readonly<{ scopeKind?: 'main_selection' }>
    | Readonly<{ scopeKind: 'runtime' }>
    | Readonly<{ scopeKind: 'spawn'; serverId: string | null | undefined }>;

