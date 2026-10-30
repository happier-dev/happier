type ThemeProfileColorOverrides = Readonly<Record<string, string>>;

const DEPRECATED_TOKEN_ID_MIGRATIONS: Readonly<Record<string, string>> = {
    'groupped.background': 'background.canvas',
    surfaceHigh: 'surface.inset',
    surfaceHighest: 'surface.elevated',
    warningCritical: 'state.danger.foreground',
    deleteAction: 'state.danger.foreground',
    syntaxKeyword: 'syntax.keyword',
    syntaxString: 'syntax.string',
    syntaxComment: 'syntax.comment',
    syntaxNumber: 'syntax.number',
    syntaxFunction: 'syntax.function',
    gitAddedText: 'versionControl.added.foreground',
    gitRemovedText: 'versionControl.removed.foreground',
};

export const migrateThemeProfileOverrideTokenId = (tokenId: string): string | undefined => (
    Object.prototype.hasOwnProperty.call(DEPRECATED_TOKEN_ID_MIGRATIONS, tokenId)
        ? DEPRECATED_TOKEN_ID_MIGRATIONS[tokenId] : undefined
);


export const migrateThemeProfileOverrideTokenIds = (overrides: ThemeProfileColorOverrides): Readonly<{
    overrides: ThemeProfileColorOverrides;
    migratedTokenIds: readonly string[];
}> => {
    const nextOverrides: Array<[string, string]> = [];
    const migratedTokenIds: string[] = [];

    for (const [tokenId, value] of Object.entries(overrides)) {
        const migratedTokenId = migrateThemeProfileOverrideTokenId(tokenId);
        if (migratedTokenId) {
            if (Object.prototype.hasOwnProperty.call(overrides, migratedTokenId)) {
                migratedTokenIds.push(tokenId);
                continue;
            }
            nextOverrides.push([migratedTokenId, value]);
            migratedTokenIds.push(tokenId);
            continue;
        }

        nextOverrides.push([tokenId, value]);
    }

    return { overrides: Object.fromEntries(nextOverrides.sort(([left], [right]) => left.localeCompare(right))), migratedTokenIds };
};

