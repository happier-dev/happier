import { useCallback } from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { usePluginTranslation } from '@happier-dev/plugin-ui';
import { projectPluginActionRejectionV1 } from '@happier-dev/plugin-ui/hostApi';
import { readTriageSessionHandoffChoicesV1 } from '@happier-dev/triage-sources/runtime';
import type { TriageSessionHandoffSelectionV1 } from '@happier-dev/triage-protocol/v1';
import type { ForgeReleaseActionInputByOperationV1 } from '@happier-dev/triage-protocol/releases/v1';
import { requestReleaseNotesAssistanceV1 } from './assistance.js';
import { readReleaseSessionChoicesV1, type ReleaseSessionHelpV1 } from './ReleaseStory.js';

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>> : null;
}

/** Presentation only: the Action retains selection, delivery and refusal authority. */
function refusalCode(result: unknown): string | null {
    const outer = record(result);
    if (outer?.ok === false) return typeof outer.errorCode === 'string' ? outer.errorCode : 'plugin_action_refused';
    const value = record(outer?.ok === true ? outer.result : result);
    if (isPluginActionApprovalRequestCreated(value)) return null;
    const handoff = record(value?.handoff) ?? value;
    if (handoff?.kind === 'composed' || handoff?.kind === 'sendResult' || handoff?.kind === 'cancelled') return null;
    if (readReleaseSessionChoicesV1(result) !== null) return null; // The person is choosing; nothing was sent.
    if (handoff?.kind === 'uncertain') return 'uncertain';
    if (handoff?.kind === 'selectionRequired') return 'selection_required';
    if (handoff?.kind === 'unavailable') {
        if (typeof handoff.reason === 'string') return handoff.reason;
        const failure = record(handoff.failure);
        if (typeof failure?.code === 'string') return failure.code;
    }
    return 'release_session_help_outcome_unavailable';
}

/**
 * Only a deliberate help intent reads choices/evidence. Triage retains selection and delivery. With no default (or
 * when the person asks to choose), the offered configured actions come back for the person to pick from; the first
 * row is never taken on their behalf.
 */
export function useReleaseSessionHelpV1(context: RenderContext): ReleaseSessionHelpV1 {
    const { hostApi: host, signal } = context;
    const target = context.surface.target;
    const t = usePluginTranslation();
    const request = useCallback<ReleaseSessionHelpV1>(async (intent, evidence, explicitChoice) => {
        if (signal.aborted) return { kind: 'cancelled' };
        if (target.kind !== 'project' || target.repository?.kind !== 'github')
            return { kind: 'unavailable', reason: 'repositoryUnavailable' };
        const selector: ForgeReleaseActionInputByOperationV1['readNotesContext']['selector'] | undefined =
            intent.kind === 'notes' && intent.releaseId !== null
                ? { kind: 'existingDraft', releaseId: intent.releaseId } : evidence?.selector;
        if (!selector || (selector.kind === 'proposed' && (!selector.tagName.trim() || !selector.targetCommitish.trim())))
            return { kind: 'unavailable', reason: 'evidenceInvalid' };
        let choice: TriageSessionHandoffSelectionV1 | undefined = explicitChoice === 'choose' ? undefined : explicitChoice;
        if (!choice) {
            const offered = await readTriageSessionHandoffChoicesV1(host, { signal });
            if (signal.aborted) return { kind: 'cancelled' };
            if (offered.kind === 'actionOutcome') return offered.outcome;
            if (offered.kind === 'unavailable') return offered;
            choice = explicitChoice === 'choose' ? undefined
                : offered.actions.find(action => action.selection.configuredActionId === offered.defaultActionId)?.selection;
            if (!choice) return offered.actions.length > 0 ? { kind: 'choose', actions: offered.actions }
                : { kind: 'unavailable', reason: 'configuredActionUnavailable' };
        }
        if (signal.aborted) return { kind: 'cancelled' };
        return requestReleaseNotesAssistanceV1(host, {
            target: { repository: target.repository }, selector,
            ...(evidence?.proposedNotes === undefined ? {} : { proposedNotes: evidence.proposedNotes }),
            ...(target.checkout ? { workspace: { serverId: target.checkout.serverId, workspaceId: target.checkout.id,
                machineId: target.checkout.machineId, rootPath: target.checkout.rootPath } } : {}),
            ...choice,
        }, { signal });
    }, [host, signal, target]);
    return useCallback<ReleaseSessionHelpV1>(async (...args) => {
        // Feedback uses the existing host notice owner, not a second composer,
        // navigation path or retry. Its failure cannot replace delivery custody.
        const notify = async (message: string) => {
            if (!signal.aborted) await host.notify(message, { severity: 'warning', signal }).catch(() => undefined);
        };
        let result: unknown;
        try { result = await request(...args); }
        catch (error) {
            const settled = projectPluginActionRejectionV1(error, t);
            if (settled.status === 'error' || settled.status === 'outcomeUnknown') {
                await notify(t('plugins.github.releases.session.failed', 'Session help: {message} ({code})', {
                    message: settled.message, code: settled.code,
                }));
            }
            throw error;
        }
        const code = refusalCode(result);
        if (code !== null) await notify(code === 'uncertain'
            ? t('plugins.github.releases.session.uncertain', 'Session help may still finish. Check its outcome before trying again. ({code})', { code })
            : code === 'selection_required'
                ? t('plugins.github.releases.session.selectionRequired', 'Session help needs a selection before it can continue. ({code})', { code })
                : t('plugins.github.releases.session.unavailable', 'Session help needs attention. ({code})', { code }));
        return result;
    }, [request, host, signal, t]);
}
