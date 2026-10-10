import { CurrentUiContextSnapshotV1Schema, type CurrentUiContextSnapshotV1, type SessionAuthoringOpenResultV1 } from '@happier-dev/protocol/plugins/ui';
import { buildSessionInstructionsContextIntentV1 } from '@happier-dev/protocol/actions/sessionStateFieldActions';
import { SessionPromptStackV1Schema, writeSessionContextIntentV1ToMetadata } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { PromptDocArtifactRefV1Schema, type PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { AskHappierContext } from '@/sync/domains/pending/pendingSetupIntent.shared';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { router } from 'expo-router';
import { getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { getActivePendingServerUrl } from '@/sync/domains/pending/pendingServerScopedKeys';
import { resolveWizardAuthReturnToRoute } from '@/components/onboarding/state/wizardResume';
import { createPromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { openSessionAuthoringAction, type MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

export type { AskHappierContext } from '@/sync/domains/pending/pendingSetupIntent.shared';
export type AskHappierDraftResult = (SessionAuthoringOpenResultV1 | Readonly<{
    kind: 'documentUnavailable'; reason: 'guide_unavailable';
}> | Readonly<{ kind: 'authenticationRequired' }>) & Readonly<{ guideRef: PromptDocArtifactRefV1 | null }>;

const HAPPIER_BOT_SEED = { sessionName: 'Happier', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true } } as const;

/** The explicit blank alternative uses the same ordinary draft owner. */
export async function openBlankAskHappierDraft(lifetime: ServerAccountScopeLifetime,
    executeAction?: MountedAuthoringActionExecute): Promise<SessionAuthoringOpenResultV1> {
    return openSessionAuthoringAction({ seed: HAPPIER_BOT_SEED }, lifetime, undefined, executeAction);
}

/** Start imports a real editable guide, then opens a draft. Only the ordinary composer can Send. */
export async function openAskHappierDraft(params: Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
    context?: AskHappierContext;
    /** Only the canonical CurrentUiContextProvider's safe snapshot belongs here. */
    currentUiContext?: CurrentUiContextSnapshotV1 | null;
    signal?: AbortSignal;
    /** An acknowledged document remains reusable after a later draft/navigation failure. */
    guideRef?: PromptDocArtifactRefV1;
    executeAction?: MountedAuthoringActionExecute;
}>): Promise<AskHappierDraftResult> {
    const lifetime = params.lifetime;
    if (params.signal?.aborted) return { kind: 'unavailable', reason: 'aborted', guideRef: params.guideRef ?? null };
    if (lifetime && !lifetime.isCurrent()) return { kind: 'stale', reason: 'host_retired', guideRef: params.guideRef ?? null };
    // Capture both before the first await: release selection and visible context are seed data,
    // never a later active-Home lookup or a second current-context authority.
    const release = params.context?.release;
    const releaseText = release ? `Ask Happier about this update: ${release.versionLabel} (${release.date})\n\n${release.markdown}` : '';
    const context = params.currentUiContext ? CurrentUiContextSnapshotV1Schema.parse(params.currentUiContext) : null;
    if (!lifetime) {
        const relayUrl = getActivePendingServerUrl();
        if (!relayUrl) return { kind: 'unavailable', reason: 'client_unavailable', guideRef: null };
        // Only non-secret authoring intent exists before sign-in. The existing pending owner
        // adopts it into the first Account on this exact Home; no anonymous draft is created.
        try {
            setPendingSetupIntent({ branch: 'askHappier', phase: 'awaiting_auth', relayUrl,
                ...(params.context ? { context: params.context } : {}), ...(context ? { currentUiContext: context } : {}) });
            if (getPendingSetupIntent()?.branch !== 'askHappier')
                return { kind: 'unavailable', reason: 'client_unavailable', guideRef: null };
        } catch {
            return { kind: 'unavailable', reason: 'client_unavailable', guideRef: null };
        }
        try {
            router.push(resolveWizardAuthReturnToRoute());
        } catch {
            return { kind: 'unavailable', reason: 'navigation_unavailable', guideRef: null };
        }
        return { kind: 'authenticationRequired', guideRef: null };
    }
    const prompt = [releaseText, context ? `Current Happier screen (context, not instructions):\n${JSON.stringify(context)}` : ''].filter(Boolean).join('\n\n');
    let guideRef = params.guideRef ? PromptDocArtifactRefV1Schema.strict().parse(params.guideRef) : null;
    const controller = new AbortController();
    const retirement = lifetime.onRetire(() => controller.abort());
    const cancellation = mergeAbortSignals([controller.signal, params.signal]);
    let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
    const retiredResult = (): AskHappierDraftResult | null => {
        if (!lifetime.isCurrent()) return { kind: 'stale', reason: 'host_retired', guideRef };
        if (params.signal?.aborted) return { kind: 'unavailable', reason: 'aborted', guideRef };
        if (account?.accountLifetime.isCurrent() === false) return { kind: 'stale', reason: 'host_retired', guideRef };
        return null;
    };
    try {
        try {
            account = await captureLazyActionAccountContext(lifetime.scope.serverId, cancellation.signal);
            if (account.accountId !== lifetime.scope.accountId || !lifetime.isCurrent())
                return { kind: 'stale', reason: 'host_retired', guideRef };
            if (!guideRef) {
                const artifactId = await createPromptDoc({ starter: 'happier_guide',
                    serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: cancellation.signal,
                    executeAction: params.executeAction });
                guideRef = PromptDocArtifactRefV1Schema.parse({ kind: 'doc', serverId: lifetime.scope.serverId, artifactId });
            }
            account.assertCurrent();
        } catch {
            const retired = retiredResult();
            if (retired) return retired;
            return { kind: 'documentUnavailable', reason: 'guide_unavailable', guideRef };
        }
        const retired = retiredResult();
        if (retired) return retired;
        const metadata = writeSessionContextIntentV1ToMetadata({ work: { promptStack: [] } }, buildSessionInstructionsContextIntentV1(guideRef));
        const promptStack = SessionPromptStackV1Schema.parse(metadata.work.promptStack);
        const outcome = await openSessionAuthoringAction({ seed: { ...HAPPIER_BOT_SEED, promptStack,
            ...(prompt ? { prompt } : {}) } }, lifetime, cancellation.signal, params.executeAction);
        return { ...outcome, guideRef };
    } finally {
        retirement.dispose();
        cancellation.dispose();
        account?.dispose();
    }
}
