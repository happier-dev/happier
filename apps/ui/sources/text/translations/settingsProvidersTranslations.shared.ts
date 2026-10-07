declare const localTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { title: string; footer: string; detected: string; possible: string; detectedAtPort: ({ port }: { port: string }) => string; possibleAtPort: ({ provider, port }: { provider: string; port: string }) => string; addConnectionTitle: string; addConnectionDescription: string; defaultConnectionName: ({ provider }: { provider: string }) => string }>;
declare const providerManagedDeploymentTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { configureManaged: string; configureManagedDescription: string; subscriptionPolicyTitle: string; subscriptionPolicyDescription: string; accountScopeMismatchTitle: string; accountScopeMismatchDescription: string; editManagedDefaults: string; editManagedDefaultsDescription: string; purposeTargetTitle: string; purposeTargetDescription: string; invalidPurposeTargetTitle: string; invalidPurposeTargetDescription: string; useExternal: string; useExternalDescription: string; useExternalConfirmTitle: string; useExternalConfirmDescription: string }>;
declare const copyNameTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", ({ name }: { name: string }) => string>;
declare const providerSharedFieldTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { local: { installedNotRunning: string; appRunningServerOff: string; startManaged: ({ provider }: { provider: string }) => string; startedByHappier: string; runningOutsideHappier: string }; apiKeyOptionalDescription: string; models: { addDescription: string; addHelp: string; addFieldLabel: string; invalidModelIds: ({ ids }: { ids: string }) => string; noNewModels: string; providerManagedTitle: string; providerManagedDescription: string; showAll: string; hideAll: string; hideAllConfirmation: string; showOnly: string; showOnlyConfirmation: string } }>;
declare const providerFirstSessionValidationTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerMigrationTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { reviewTitle: string; reviewFooter: string; legacyProfileDescription: string; credentialTitle: string; credentialFooter: string; noCredential: string; credentialMoveDescription: string; noCredentialDescription: string; actionsTitle: string; preview: string; previewDescription: string; confirm: string; confirmDescription: string; reviewAction: string; reviewActionDescription: string; retainedTitle: string; retainedDescription: string }>;
declare const providerMigrationPreviewTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { willMoveTitle: string; willMoveFooter: string; willKeepTitle: string; willKeepFooter: string; permissionDefaults: string; persistenceDefaults: string }>;
declare const providerMigrationConflictTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { conflictReviewTitle: string; conflictReviewFooter: string; conflictCredential: string; conflictModels: string; conflictEditedConnection: string; keepExisting: string; keepExistingDescription: string; modelOutcomeTitle: string; modelOutcomeFooter: string; useExistingModel: string; useExistingModelDescription: string; preserveLegacyModel: string; preserveLegacyModelDescription: string; discardLegacyModel: string; discardLegacyModelDescription: string; createNamed: string; createNamedDescription: string; separateConnectionName: string; conflictReviewAction: string; conflictReviewActionDescription: string }>;
declare const providerCredentialSelectionRequiredTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerLinkTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { providerWebsite: string; getApiKey: string; failedToOpen: string }>;
declare const providerCredentialFormatSelectionRequiredTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerReservedEnvironmentValidationUnavailableTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerAdvancedAuthoringTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { advancedSetup: string; advancedSetupEnabled: string; advancedSetupDisabled: string; endpointEnabled: string; endpointEnabledDescription: string; endpointDisabledDescription: string; publicHeaders: string; publicHeadersPlaceholder: string; optionalProbePath: string; probeParserTitle: string; probeParser: { openaiModels: string; ollamaTags: string; lmStudioNative: string } }>;
declare const providerCustomBearerHeaderTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerNonSecretHeaderTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerProbePathsTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerLocalAuthoringTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { enableAfterSaving: string; enableOnCurrentMachine: string; enableAccountWide: string; localAddressTitle: string; localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => string }>;
declare const providerAuthoringReviewTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { destinationReview: string; destinationLoading: string; destinationSelection: string; destinationSelectionDescription: string; destinationScope: string; destinationMachine: string; destinationAccount: string }>;
declare const providerCompatibilityTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { title: string; footer: string; verified: string; experimental: string; incompatible: string; verifiedDescription: string; experimentalDescription: string; incompatibleDescription: string }>;
declare const providerModelNotLoadedTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerModelLoadCancellationTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { cancelLoad: string; loadCancelled: string; loadCancelledProviderMayContinue: string }>;
declare const providerPartialStatusTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerConnectedServiceSuppressedTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerMachineCleanupPendingTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", string>;
declare const providerConnectionChangedTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { title: string; description: string }>;
declare const providerModelSectionTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { available: string; manual: string }>;
declare const providerCompletenessTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { searchEmptyTitle: string; searchEmptyDescription: string; compatibilityReasons: { noCompatibleProtocol: string; noAuthUnsupported: string; credentialTransportUnavailable: string; optionalCredentialNoAuthUnsupported: string; capabilityUnsupported: string; capabilityUnknown: string; modelEvidenceRequired: string; modelCapabilityUnsupported: string; modelCapabilityUnknown: string; overrideIncompatible: string; overrideExperimental: string; evidenceMissing: string; agentUnsupported: string; adapterInvalid: string; unknown: string }; unsavedDescription: string; recoveryActions: { reviewFeatures: string; chooseConnection: string; restorePlugin: string; enableConnection: string; reviewAccountGrant: string; enableOnMachine: string; reviewMachineGrant: string; reviewCompatibility: string; addSecret: string; reviewCredentialTransport: string; reviewConnection: string; retry: string; replaceSecret: string; chooseModel: string; loadModel: string; reviewAndRestart: string; restartProbe: string; reduceProviderSettings: string; reviewProfileMigration: string; reviewCurrentState: string }; hiddenForAllAgents: string }>;
declare const providerAvailabilityTranslations: Record<"ca" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", { availabilityChecking: string; availabilityCheckingDescription: string; availabilityProblem: string; availabilityProblemDescription: string; availabilityUnsupported: string; availabilityUnsupportedDescription: string; availabilityContextUnsupported: string; availabilityContextUnsupportedDescription: string; availabilityPolicyDisabled: string; availabilityPolicyDisabledDescription: string }>;



export function withProviderSharedFields<T extends {
    readonly authoring: Readonly<Record<string, unknown>> & {
        readonly credentialStyle: Readonly<Record<string, string>>;
    };
    readonly detail: Readonly<Record<string, unknown>>;
    readonly models: Readonly<Record<string, unknown>>;
    readonly status: Readonly<Record<string, string>>;
    readonly errors: Readonly<Record<string, string>>;
}, Parts extends {
    providerAvailabilityTranslations: typeof providerAvailabilityTranslations[keyof typeof providerAvailabilityTranslations];
    providerLinkTranslations: typeof providerLinkTranslations[keyof typeof providerLinkTranslations];
    providerCompletenessTranslations: typeof providerCompletenessTranslations[keyof typeof providerCompletenessTranslations];
    providerPartialStatusTranslations: typeof providerPartialStatusTranslations[keyof typeof providerPartialStatusTranslations];
    providerMachineCleanupPendingTranslations: typeof providerMachineCleanupPendingTranslations[keyof typeof providerMachineCleanupPendingTranslations];
    providerConnectionChangedTranslations: typeof providerConnectionChangedTranslations[keyof typeof providerConnectionChangedTranslations];
    providerCompatibilityTranslations: typeof providerCompatibilityTranslations[keyof typeof providerCompatibilityTranslations];
    providerMigrationTranslations: typeof providerMigrationTranslations[keyof typeof providerMigrationTranslations];
    providerMigrationPreviewTranslations: typeof providerMigrationPreviewTranslations[keyof typeof providerMigrationPreviewTranslations];
    providerMigrationConflictTranslations: typeof providerMigrationConflictTranslations[keyof typeof providerMigrationConflictTranslations];
    providerCredentialSelectionRequiredTranslations: typeof providerCredentialSelectionRequiredTranslations[keyof typeof providerCredentialSelectionRequiredTranslations];
    providerCredentialFormatSelectionRequiredTranslations: typeof providerCredentialFormatSelectionRequiredTranslations[keyof typeof providerCredentialFormatSelectionRequiredTranslations];
    providerReservedEnvironmentValidationUnavailableTranslations: typeof providerReservedEnvironmentValidationUnavailableTranslations[keyof typeof providerReservedEnvironmentValidationUnavailableTranslations];
    localTranslations: typeof localTranslations[keyof typeof localTranslations];
    providerSharedFieldTranslations: typeof providerSharedFieldTranslations[keyof typeof providerSharedFieldTranslations];
    providerManagedDeploymentTranslations: typeof providerManagedDeploymentTranslations[keyof typeof providerManagedDeploymentTranslations];
    copyNameTranslations: typeof copyNameTranslations[keyof typeof copyNameTranslations];
    providerFirstSessionValidationTranslations: typeof providerFirstSessionValidationTranslations[keyof typeof providerFirstSessionValidationTranslations];
    providerAdvancedAuthoringTranslations: typeof providerAdvancedAuthoringTranslations[keyof typeof providerAdvancedAuthoringTranslations];
    providerLocalAuthoringTranslations: typeof providerLocalAuthoringTranslations[keyof typeof providerLocalAuthoringTranslations];
    providerAuthoringReviewTranslations: typeof providerAuthoringReviewTranslations[keyof typeof providerAuthoringReviewTranslations];
    providerNonSecretHeaderTranslations: typeof providerNonSecretHeaderTranslations[keyof typeof providerNonSecretHeaderTranslations];
    providerProbePathsTranslations: typeof providerProbePathsTranslations[keyof typeof providerProbePathsTranslations];
    providerCustomBearerHeaderTranslations: typeof providerCustomBearerHeaderTranslations[keyof typeof providerCustomBearerHeaderTranslations];
    providerModelSectionTranslations: typeof providerModelSectionTranslations[keyof typeof providerModelSectionTranslations];
    providerModelLoadCancellationTranslations: typeof providerModelLoadCancellationTranslations[keyof typeof providerModelLoadCancellationTranslations];
    providerModelNotLoadedTranslations: typeof providerModelNotLoadedTranslations[keyof typeof providerModelNotLoadedTranslations];
    providerConnectedServiceSuppressedTranslations: typeof providerConnectedServiceSuppressedTranslations[keyof typeof providerConnectedServiceSuppressedTranslations];
}>(
    translation: T,
    parts: Parts,
) {
    return {
        ...translation,
        ...parts.providerAvailabilityTranslations,
        links: parts.providerLinkTranslations,
        searchEmptyTitle: parts.providerCompletenessTranslations.searchEmptyTitle,
        searchEmptyDescription: parts.providerCompletenessTranslations.searchEmptyDescription,
        status: { ...translation.status, partial: parts.providerPartialStatusTranslations },
        errors: {
            ...translation.errors,
            machineCleanupPendingDescription: parts.providerMachineCleanupPendingTranslations,
            connectionChangedTitle: parts.providerConnectionChangedTranslations.title,
            connectionChangedDescription: parts.providerConnectionChangedTranslations.description,
            rpcResponseInvalidTitle: translation.errors.genericTitle,
            rpcResponseInvalidDescription: translation.errors.genericDescription,
            mutationOutcomeUnknownTitle: translation.errors.genericTitle,
            mutationOutcomeUnknownDescription: translation.errors.genericDescription,
            accessChangedTitle: translation.errors.notEnabledOnMachineTitle,
            accessChangedDescription: translation.errors.notEnabledOnMachineDescription,
            incompatibleTitle: parts.providerCompatibilityTranslations.incompatible,
            incompatibleDescription: parts.providerCompatibilityTranslations.incompatibleDescription,
            unverifiedTitle: parts.providerCompatibilityTranslations.experimental,
            unverifiedDescription: parts.providerCompatibilityTranslations.experimentalDescription,
            credentialUnsupportedTitle: parts.providerCompatibilityTranslations.incompatible,
            credentialUnsupportedDescription: parts.providerCompatibilityTranslations.incompatibleDescription,
            machineUnavailableTitle: translation.errors.genericTitle,
            machineUnavailableDescription: translation.errors.genericDescription,
            managedRequiresDaemonTitle: translation.errors.genericTitle,
            managedRequiresDaemonDescription: translation.errors.genericDescription,
            connectionInvalidTitle: translation.errors.genericTitle,
            connectionInvalidDescription: translation.errors.genericDescription,
            modelNotFoundTitle: translation.errors.notFoundTitle,
            modelNotFoundDescription: translation.errors.notFoundDescription,
            modelUnloadedTitle: translation.errors.genericTitle,
            modelUnloadedDescription: translation.errors.genericDescription,
            restartRequiredTitle: translation.errors.genericTitle,
            restartRequiredDescription: translation.errors.genericDescription,
            probeExpiredTitle: translation.errors.genericTitle,
            probeExpiredDescription: translation.errors.genericDescription,
            settingsLimitTitle: translation.errors.genericTitle,
            settingsLimitDescription: translation.errors.genericDescription,
            migrationChangedTitle: translation.errors.genericTitle,
            migrationChangedDescription: translation.errors.genericDescription,
            migrationMissingTitle: translation.errors.notFoundTitle,
            migrationMissingDescription: translation.errors.notFoundDescription,
            migrationConflictTitle: translation.errors.genericTitle,
            migrationConflictDescription: translation.errors.genericDescription,
            actions: parts.providerCompletenessTranslations.recoveryActions,
        },
        compatibility: {
            ...parts.providerCompatibilityTranslations,
            reasons: parts.providerCompletenessTranslations.compatibilityReasons,
        },
        migration: {
            ...parts.providerMigrationTranslations,
            ...parts.providerMigrationPreviewTranslations,
            ...parts.providerMigrationConflictTranslations,
            credentialSelectionRequired: parts.providerCredentialSelectionRequiredTranslations,
            credentialFormatSelectionRequired: parts.providerCredentialFormatSelectionRequiredTranslations,
            reservedEnvironmentValidationUnavailable: parts.providerReservedEnvironmentValidationUnavailableTranslations,
        },
        local: {
            ...parts.localTranslations,
            ...parts.providerSharedFieldTranslations.local,
            ...parts.providerManagedDeploymentTranslations,
        },
        detail: {
            ...translation.detail,
            copyName: parts.copyNameTranslations,
            testOnFirstSession: parts.providerFirstSessionValidationTranslations,
        },
        authoring: {
            ...translation.authoring,
            ...parts.providerAdvancedAuthoringTranslations,
            ...parts.providerLocalAuthoringTranslations,
            ...parts.providerAuthoringReviewTranslations,
            unsavedDescription: parts.providerCompletenessTranslations.unsavedDescription,
            publicHeaders: parts.providerNonSecretHeaderTranslations,
            optionalProbePath: parts.providerProbePathsTranslations,
            credentialStyle: {
                ...translation.authoring.credentialStyle,
                customHeaderBearer: parts.providerCustomBearerHeaderTranslations,
            },
            credentialHeaderPlaceholder: 'X-API-Key',
            modelsPathPlaceholder: '/v1/models',
            apiKeyOptionalDescription: parts.providerSharedFieldTranslations.apiKeyOptionalDescription,
        },
        models: {
            ...translation.models,
            ...parts.providerSharedFieldTranslations.models,
            ...parts.providerModelSectionTranslations,
            ...parts.providerModelLoadCancellationTranslations,
            notLoaded: parts.providerModelNotLoadedTranslations,
            connectedServiceSuppressed: parts.providerConnectedServiceSuppressedTranslations,
            hiddenForAllAgents: parts.providerCompletenessTranslations.hiddenForAllAgents,
        },
    } as const;
}