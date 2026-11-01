import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { CurrentSessionPresentationIntentV1, CurrentSessionPresentationIntentResultV1 } from '@happier-dev/protocol/sessions';

import { readSessionPresentationAdapterAtAddress } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { publishPresentationNotice, type PresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

import { applySessionCompanionMutationWithNotice, type SessionCompanionMutationObserver } from './sessionCompanionPresentationAdapter';
import type { SessionCompanionController, SessionCompanionMutationOutcome } from '../state/useSessionCompanionController';
import type { SessionCompanionItemRefV1 } from '../state/sessionCompanionPreference';

type CompanionIntent = Extract<CurrentSessionPresentationIntentV1, { kind: `companion.${string}` }>;

/** Human edits enter the same Actions and mounted semantic writer as Agent edits. */
export function applySessionCompanionHumanIntent(input: Readonly<{
    address: SessionAddress | null;
    intent: CompanionIntent;
    onCompanionMutation?: SessionCompanionMutationObserver;
}>): Promise<boolean> {
    return executeHumanIntent(input);
}

/** Showing a new reference also reveals it, preserving the incumbent one-write Show semantics. */
export async function showSessionCompanionItem(input: Readonly<{
    address: SessionAddress | null;
    companion: SessionCompanionController;
    publishNotice: (notice: PresentationNotice) => void;
    noticeKeyPrefix: string | null;
    item: Exclude<SessionCompanionItemRefV1, { kind: 'instance' }>;
    revealAfterMutation: (outcome: SessionCompanionMutationOutcome) => void;
}>): Promise<void> {
    let outcome: SessionCompanionMutationOutcome | null = null;
    const admitted = await executeHumanIntent({
        address: input.address,
        intent: { kind: 'companion.item.add', item: input.item },
        applyPresentation: () => {
            outcome = applySessionCompanionMutationWithNotice({ ...input,
                kind: 'companion.item.add', message: t('sessionBoard.companion.notices.added'),
                apply: companion => companion.show(input.item) });
            return { status: outcome ? 'applied' : 'unchanged' };
        },
    });
    if (admitted && outcome) input.revealAfterMutation(outcome);
}

async function executeHumanIntent(input: Readonly<{
    address: SessionAddress | null;
    intent: CompanionIntent;
    onCompanionMutation?: SessionCompanionMutationObserver;
    applyPresentation?: () => CurrentSessionPresentationIntentResultV1;
}>): Promise<boolean> {
    const { address, intent } = input;
    if (!address) return false;
    const adapter = readSessionPresentationAdapterAtAddress(address);
    if (!adapter && !input.applyPresentation) return false;
    try {
        const account = await resolveServerCredentialAccountScope(address.serverId);
        if (account.kind !== 'bound') return false;
        const surface = { ...account.scope, owner: { kind: 'companion' as const, sessionId: address.sessionId } };
        let actionId: ActionId = 'session.presentation.apply';
        let actionInput: unknown = { intent };
        if (intent.kind === 'companion.item.add' && intent.item.kind === 'instance') {
            actionId = 'widgets.item.add';
            actionInput = { surface, instance: intent.item.instance };
        } else if ((intent.kind === 'companion.item.remove' || intent.kind === 'companion.item.frameStyle.set') && intent.item.kind === 'instance') {
            const ref = { surface, instanceId: intent.item.instance.id };
            actionId = intent.kind === 'companion.item.remove' ? 'widgets.item.remove' : 'widgets.item.frame.set';
            actionInput = intent.kind === 'companion.item.remove' ? { ref } : { ref, frameStyle: intent.frameStyle };
        } else if (intent.kind === 'companion.instance.rename') {
            actionId = 'widgets.item.rename';
            actionInput = { ref: { surface, instanceId: intent.instanceId }, displayName: intent.displayName };
        } else if (intent.kind === 'companion.instance.inputs.set') {
            actionId = 'widgets.item.inputs.set';
            actionInput = { ref: { surface, instanceId: intent.instanceId }, bindings: intent.bindings };
        }
        const execute = createFrontDoorActionExecute(undefined, {
            currentSessionPresentationApply: {
                ...account.scope,
                sessionId: address.sessionId,
                // The captured adapter owns its mounted target's currentness.
                isCurrent: () => true,
                apply: async ({ input: admitted }) => {
                    const outcome = input.applyPresentation?.() ?? adapter?.apply(admitted.intent, input.onCompanionMutation) ?? { status: 'unavailable' };
                    return outcome.status === 'applied' || outcome.status === 'unchanged'
                        ? { status: outcome.status, revision: '0' }
                        : { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                },
            },
        });
        requireActionSuccess(await execute(actionId, actionInput, {
            surface: 'ui', serverId: address.serverId, defaultSessionId: address.sessionId,
        }));
        return true;
    } catch {
        publishPresentationNotice({ key: 'session-companion-edit', severity: 'error', message: t('widgetAdd.saveFailed') });
        return false;
    }
}
