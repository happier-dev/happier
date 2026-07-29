export const SAPLING_INSTALLABLE_DEP_ID = 'sapling-cli';

export const SAPLING_INSTALLABLE_DESCRIPTOR = {
    id: SAPLING_INSTALLABLE_DEP_ID,
    title: 'Sapling',
    description: 'Sapling source control command-line tool used for local Sapling repositories.',
    sources: [{
        kind: 'system' as const,
        executableNames: ['sl'],
        versionArguments: ['--version'],
    }],
    executable: 'sl',
};
