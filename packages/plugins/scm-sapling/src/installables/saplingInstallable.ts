import { ManagedDependencyDescriptorSchema } from '@happier-dev/plugin-sdk/experimental/managedDependencies';

export const SAPLING_INSTALLABLE_DEP_ID = 'dep.sapling';

export const SAPLING_INSTALLABLE_DESCRIPTOR = ManagedDependencyDescriptorSchema.parse({
    id: SAPLING_INSTALLABLE_DEP_ID,
    key: SAPLING_INSTALLABLE_DEP_ID,
    kind: 'dep',
    version: '1',
    capabilityId: SAPLING_INSTALLABLE_DEP_ID,
    display: {
        name: 'Sapling',
        subtitle: 'Sapling source control CLI',
    },
    description: 'Sapling source control command-line tool used for local Sapling repositories.',
    source: {
        kind: 'manual_only',
        setupUrl: 'https://sapling-scm.com/docs/introduction/installation',
    },
    binary: {
        commands: ['sl'],
        systemFirst: true,
        managedFallback: false,
    },
    defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'notify',
    },
    consent: {
        install: 'required',
        update: 'required',
        commandsPreviewRequired: true,
    },
    stability: {
        experimental: false,
        supported: true,
    },
});
