type LocaleCopyShape<T> = T extends string ? string : T extends (...args: infer Args) => infer Result ? (...args: Args) => Result : T extends object ? { [Key in keyof T]: LocaleCopyShape<T[Key]> } : T;
declare const marketplacePresentation: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", LocaleCopyShape<typeof marketplacePresentationEnglish.en>>;



export const updatePolicy = {
    title: 'Update policy',
    target: ({ machine, server }: { machine: string; server: string }) => `Applies on ${machine} via ${server}.`,
    pinned: 'Pinned',
    pinnedSubtitle: 'Do not update until you choose another policy.',
    allowed: 'Updates allowed',
    allowedSubtitle: 'Explicit updates proceed without another prompt unless declared authority expands.',
} as const;



export const installReviewSections = {
    archiveUrlRetention: 'Happier saves the full archive URL on the selected machine, including any credentials, for future updates. Expired or revoked URLs can make updates fail.',
    trustedCodeTitle: 'Trusted code',
    trustedCodeDisclosure: 'Plugins run as trusted code inside Happier, not in a sandbox. A plugin can use this app’s own authority directly — files, network, environment and processes — beyond the Happier-mediated services listed below. That list is what the plugin declared and what you can turn off later, not a limit on what its code can reach.',
    identity: 'Identity and package',
    evidence: 'Technical evidence',
    executableCode: 'Executable code and contributions',
    requiredAccess: 'Required host access',
    optionalAccess: 'Optional host access',
    requestInterceptors: 'Request interceptors',
    rawCredentials: 'Raw credential declarations',
    compatibility: 'Compatibility and updates',
    none: 'None declared',
    scope: ({ scope }: { scope: string }) => `Scope: ${scope}`,
    developmentPath: ({ locator }: { locator: string }) => `${locator} · development`,
    publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · unverified`,
    integrityBasis: {
        expected: ({ integrity }: { integrity: string }) => `${integrity} (expected)`,
        observed: ({ integrity }: { integrity: string }) => `${integrity} (observed)`,
    },
    signatureStatus: {
        // The registry signing key authenticates the registry response over the
        // exact package/version/integrity fact; it never attests the plugin
        // publisher a catalog displays.
        verified: ({ keyId }: { keyId: string }) => `Verified registry signature: ${keyId}`,
        unsupported: ({ keyId }: { keyId: string }) => `Unsupported registry signature: ${keyId}`,
    },
    provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `Declared, unverified: ${predicateType}`,
    provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `Retrieved, unverified: ${predicateTypes}`,
    provenanceUnavailable: ({ code }: { code: string }) => `Provenance unavailable: ${code}`,
    curationUnreviewed: ({ sourceId }: { sourceId: string }) => `Unreviewed catalog source: ${sourceId}`,
    curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `Reviewed by ${sourceId} on ${reviewedAt}${reason}`,
    savedSecret: 'Saved secret',
    connectedAccount: 'Connected account',
    secretKinds: ({ kinds }: { kinds: string }) => `Secret kinds: ${kinds}`,
    connectedAccountService: ({ service }: { service: string }) => `Service: ${service}`,
    credentialPurpose: ({ purpose }: { purpose: string }) => `Purpose: ${purpose}`,
    credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `Used in ${realm} during ${phase}`,
    credentialAccess: ({ access }: { access: string }) => `Access: ${access}`,
    credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `Headers sent to ${origin}: ${headers}`,
    credentialRequestEnvironment: ({ keys }: { keys: string }) => `Environment variables: ${keys}`,
    credentialRequestFiles: ({ files }: { files: string }) => `Files: ${files}`,
    realm: { web: 'web', ios: 'iOS', android: 'Android', daemon: 'daemon' },
    phase: { settings: 'settings', prepare: 'preparation', connection: 'connection', speech: 'speech' },
    runtimeApi: ({ version }: { version: number }) => `Runtime API ${version}`,
    source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}: ${locator}`,
    sourceKind: { path: 'Local path', archive: 'Archive', npm: 'npm package' },
    marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}: ${source}`,
    marketplaceSourceKind: { curated: 'Curated catalog', 'community-npm': 'Community npm catalog', user: 'User catalog' },
    executableRealm: { daemon: 'Background service code', reactNative: 'App interface code', hostedWeb: 'Isolated hosted-web code' },
    uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}: ${ids}`,
    uiArtifactStatus: { verified: 'Verified interface artifacts', none: 'No interface artifacts', unavailable: 'Interface artifacts unavailable' },
    authorizationClass: { cooperativeDisclosure: 'Cooperative disclosure', hostResourceSelection: 'Selected host resources', presentIntentOrOs: 'Current intent or operating-system permission' },
    priority: ({ priority }: { priority: number }) => `Priority ${priority}`,
} as const;



export const sourceAdministration = {
    title: 'Sources & registries',
    subtitle: 'Choose where this machine discovers exact npm packages and how it reaches their registries.',
    communityTitle: 'Community npm',
    communitySubtitle: 'Built in · unreviewed discovery of eligible Happier plugins on public npm, not arbitrary npm packages.',
    configuredTitle: 'Marketplace sources',
    configuredEmpty: 'No additional marketplace sources configured.',
    add: 'Add source',
    edit: 'Edit source',
    remove: 'Remove source',
    removeTitle: 'Remove marketplace source?',
    removeBody: ({ name }: { name: string }) => `${name} will no longer be used for discovery on this machine. Installed plugins are not changed.`,
    sourceUrl: 'Source URL',
    displayName: 'Display name',
    description: 'Description (optional)',
    enabled: 'Enabled',
    disabled: 'Disabled',
    curated: 'Curated source',
    user: 'Your source',
    loadError: 'Marketplace sources could not be loaded.',
    retry: 'Retry',
    operationFailed: 'This change could not be applied. Check the machine connection and try again.',
    operationOutcomeUnknownTitle: 'Change needs review',
    operationOutcomeUnknownBody: 'The selected machine may have applied this change, but Happier could not confirm the result. Review the refreshed settings before changing it again.',
} as const;



export const pluginChangeOutcomeUnknown = {
    pluginChangeOutcomeUnknownTitle: 'Outcome not confirmed',
    pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) =>
        `Happier could not confirm whether ${action} for ${name} finished on ${machine} (${server}). Check Installed on that machine and its current version there before trying again.`,
} as const;



export const secretFieldActions = {
    delete: 'Delete saved secret',
    deleteHint: 'Erases the stored secret value. This cannot be undone.',
    unbind: 'Remove from this plugin',
    unbindHint: 'Detaches the saved secret from this setting. The secret itself is kept.',
} as const;


export const marketplacePresentationEnglish = { en: {
        diagnosticsIssueTitle: 'Plugin issue',
        diagnosticsRecovery: 'Review the detail above, then reload the plugin or refresh this page after correcting it.',
        diagnosticsTechnicalCode: ({ code }: { code: string }) => `Technical code: ${code}`,
        discover: {
            publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `Publisher label: ${displayName} (${id})`,
            categories: ({ values }: { values: string }) => `Categories: ${values}`,
            runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `Runs in: ${realms} · Platforms: ${platforms}`,
            reviewStatus: { curated: 'Curated recommendation', unreviewed: 'Unreviewed', withdrawn: 'Withdrawn' },
            executableRealm: { daemon: 'background service', client: 'app', hostedWeb: 'hosted web' },
            platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: 'Web', ios: 'iOS', android: 'Android' },
            diagnostic: { title: 'Marketplace source issue', recovery: 'Refresh Discover. If this continues, review Sources & registries.', unreachableTitle: ({ source }: { source: string }) => `Couldn’t reach ${source}`, behindTitle: ({ source }: { source: string }) => `${source} answered with older or missing data`, indexTitle: 'The plugin index is incomplete', otherSourcesShown: 'Results from other sources are still shown.' },
        },
    } } as const;



export const english = {
    ...marketplacePresentationEnglish.en,
    installReviewSections,
    sourceAdministration,
    secretFieldActions,
    ...pluginChangeOutcomeUnknown,
    updateFromInstalledRecordSubtitle: 'Advance this installation through its own trusted update channel.',
    updatePolicy,
    discover: {
        ...marketplacePresentationEnglish.en.discover,
        status: {
            loading: 'Searching every marketplace source…',
            loadingSource: ({ source }: { source: string }) => `Searching ${source}…`,
            results: ({ count, sources }: { count: number; sources: number }) =>
                `${count} plugin(s) from ${sources} source(s)`,
            empty: 'No plugins matched this search.',
            error: ({ message }: { message: string }) => `Discover could not be refreshed: ${message}`,
            errorTitle: 'Discover could not be refreshed',
            stale: 'These results answer an earlier search. Search again to apply the controls above.',
            partial: ({ count }: { count: number }) =>
                `${count} source(s) answered with older or missing data, so results may be incomplete.`,
            nonInstallable: ({ count }: { count: number }) =>
                `${count} listing(s) were found but cannot be installed on this machine right now.`,
        },
        sourceFreshness: {
            stale: 'Older than this source',
            'stale-offline': 'Last known results, source offline',
            unavailable: 'Source unavailable',
            'auth-unavailable': 'Sign-in required for this source',
            corrupt: 'Source index could not be read',
        },
        nonInstallableReason: {
            sourceStale: 'Its marketplace source is not current.',
            artifactUnavailable: 'Its package cannot be reached with this machine’s registry access.',
            notApproved: 'It is not approved for install from this source.',
            unsupportedSourceKind: 'Its source kind is not supported by this version of Happier.',
        },
        installSubtitle: ({ source }: { source: string }) =>
            `Review everything this plugin declares before anything from ${source} is trusted.`,
        registrySelectionRequired: ({ origin }: { origin: string }) => `Needs a registry profile for ${origin}`,
        registrySelection: {
            title: ({ name }: { name: string }) => `Choose a registry for ${name}`,
            body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                `${name} is published on ${origin}. Choose the registry profile ${source} uses on this machine, or add one and sign in. Nothing is downloaded until the Install and Trust review.`,
            continue: 'Continue',
        },
    },
} as const;


export const pluginMarketplaceDiscoverTranslationsEnglish = { en: english } as const;