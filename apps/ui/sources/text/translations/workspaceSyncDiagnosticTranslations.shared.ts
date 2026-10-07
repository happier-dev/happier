import type { TranslationStructure } from './en';


declare const workspaceSyncDiagnosticTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", WorkspaceSyncDiagnosticTranslation>;
declare const workspaceSyncSetAttentionTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", Pick<WorkspaceSyncTranslation, 'attention'>>;
declare const workspaceSyncAddMachineTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>;
declare const workspaceSyncReviewOutcomeTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>;
declare const workspaceSyncCoverageIncompleteTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", WorkspaceSyncTranslation['review']['coverageIncomplete']>;
declare const workspaceSyncReviewLifecycleTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>;
declare const workspaceSyncLocalOnlyTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", WorkspaceSyncTranslation['review']['localOnly']>;
declare const workspaceSyncKeepAlternativesTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", WorkspaceSyncTranslation['review']['keepAlternatives']>;
declare const workspaceSyncReviewDecisionTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>;
declare const workspaceSyncReviewTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", WorkspaceSyncReviewBase>;
declare const workspaceSyncReviewSelectionTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>;



export type WorkspaceSyncDiagnosticTranslation = Readonly<{
    diagnostics: Readonly<{
        title: string;
        relationshipId: string;
        controllerMachineId: string;
        alphaMachineId: string;
        betaMachineId: string;
        alphaRoot: string;
        betaRoot: string;
        engineMode: string;
        engineState: string;
        errorCode: string;
    }>;
    error: Readonly<{ updateRequired: string }>;
    resolve: Readonly<{
        title: string;
        body: (params: Readonly<{ path: string; side: string }>) => string;
        unverifiedFile: string;
    }>;
}>;



export type WorkspaceSyncTranslation = TranslationStructure['workspaceSync'];



export type WorkspaceSyncLocale = keyof typeof workspaceSyncDiagnosticTranslations;



export type WorkspaceSyncTranslationCore = Omit<WorkspaceSyncTranslation, 'availableOn' | 'addMachine' | 'attention' | 'diagnostics' | 'error' | 'resolve' | 'review'> & Readonly<{
    error: Omit<WorkspaceSyncTranslation['error'], 'updateRequired'>;
    resolve: Omit<WorkspaceSyncTranslation['resolve'], 'title' | 'body' | 'unverifiedFile'>;
}>;



export type WorkspaceSyncReviewBase = Omit<WorkspaceSyncTranslation['review'],
    keyof typeof workspaceSyncReviewSelectionTranslations.de
    | keyof typeof workspaceSyncReviewOutcomeTranslations.de
    | keyof typeof workspaceSyncReviewLifecycleTranslations.de
    | keyof typeof workspaceSyncReviewDecisionTranslations.de
    | 'localOnly' | 'keepAlternatives'>;



export function completeWorkspaceSyncTranslation(
    parts: {
        diagnostic: typeof workspaceSyncDiagnosticTranslations[WorkspaceSyncLocale];
        review: typeof workspaceSyncReviewTranslations[WorkspaceSyncLocale];
        selection: typeof workspaceSyncReviewSelectionTranslations[WorkspaceSyncLocale];
        outcome: typeof workspaceSyncReviewOutcomeTranslations[WorkspaceSyncLocale];
        lifecycle: typeof workspaceSyncReviewLifecycleTranslations[WorkspaceSyncLocale];
        decision: typeof workspaceSyncReviewDecisionTranslations[WorkspaceSyncLocale];
        coverage: typeof workspaceSyncCoverageIncompleteTranslations[WorkspaceSyncLocale];
        localOnly: typeof workspaceSyncLocalOnlyTranslations[WorkspaceSyncLocale];
        alternatives: typeof workspaceSyncKeepAlternativesTranslations[WorkspaceSyncLocale];
        addMachine: typeof workspaceSyncAddMachineTranslations[WorkspaceSyncLocale];
        attention: typeof workspaceSyncSetAttentionTranslations[WorkspaceSyncLocale];
    },
    core: WorkspaceSyncTranslationCore,
): WorkspaceSyncTranslation {
    const overlay = parts.diagnostic;
    const review: WorkspaceSyncTranslation['review'] = {
        ...parts.review,
        ...parts.selection,
        ...parts.outcome,
        ...parts.lifecycle,
        ...parts.decision,
        coverageIncomplete: parts.coverage,
        localOnly: parts.localOnly,
        keepAlternatives: parts.alternatives,
    };
    return {
        ...core,
        ...parts.addMachine,
        ...parts.attention,
        diagnostics: overlay.diagnostics,
        error: { ...core.error, ...overlay.error },
        resolve: { ...core.resolve, ...overlay.resolve },
        review,
    };
}