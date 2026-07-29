import { classifyAgentSessionComposerNonSteerablePayload } from '@/agents/registry/registryUiBehavior';
import type { AgentType } from '@/sync/domains/models/modelOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import {
    getPermissionModeLabelForAgentType,
    getPermissionModeTitleForAgentType,
} from '@/sync/domains/permissions/permissionModeOptions';
import {
    canApplySteerConfigInFlight,
    decideSessionMessageDelivery,
    type BusySteerSendPolicy,
    type MessageSendMode,
} from '@/sync/domains/session/control/submitMode';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import { confirmNonSteerableSend, isNonSteerableSendBlockerReason } from './confirmNonSteerableSend';

export type NonSteerableSendPlan =
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{
        kind: 'proceed';
        /** Interrupt the active turn before sending (user chose "Interrupt & send now"). */
        explicitMode?: Extract<MessageSendMode, 'interrupt'>;
        /** Explicit per-message choice: apply the config delta in-turn and steer (capability-gated). */
        applyConfigAndSteer?: boolean;
        /** Explicit per-message choice: steer the text only; the config stays desired-state. */
        steerWithoutConfig?: boolean;
        /**
         * Steer-without-applying rides the published (server-known) permission mode so the payload
         * carries no config delta; the desired mode applies on the next message via the normal path.
         */
        steerWithoutConfigMetaOverrides?: Readonly<Record<string, unknown>>;
    }>;

const PROCEED: NonSteerableSendPlan = { kind: 'proceed' };

/**
 * G4 busy-send honesty preflight. When a send cannot steer the active turn (fresh permission-mode
 * change, special command, or provider-refused config delta), asks the user what to do via
 * `confirmNonSteerableSend` and maps the choice onto explicit submit flags. Explicit intents
 * (force-immediate, queue-to-pending) and the `off` setting skip the prompt entirely — the
 * decision layer then handles the payload with its default honest queueing.
 */
export async function resolveNonSteerableSendPlan(opts: {
    session: Session | null;
    agentId: AgentType | null;
    text: string;
    configuredMode: MessageSendMode;
    busySteerSendPolicy: BusySteerSendPolicy;
    permissionModeApplyTiming: 'current_turn' | 'next_prompt';
    nonSteerableSendPrompt: 'on' | 'off';
    forceImmediate?: boolean;
    explicitPendingIntent?: boolean;
    structuredInputMetaOverrides?: Record<string, unknown> | null;
    nowMs?: number;
}): Promise<NonSteerableSendPlan> {
    if (
        opts.nonSteerableSendPrompt !== 'on'
        || opts.forceImmediate === true
        || opts.explicitPendingIntent === true
    ) {
        return PROCEED;
    }

    const preflight = decideSessionMessageDelivery({
        configuredMode: opts.configuredMode,
        busySteerSendPolicy: opts.busySteerSendPolicy,
        session: opts.session,
        text: opts.text,
        permissionModeApplyTiming: opts.permissionModeApplyTiming,
        nonSteerableSendPrompt: opts.nonSteerableSendPrompt,
        providerNonSteerableReason: classifyAgentSessionComposerNonSteerablePayload({
            session: opts.session,
            metaOverrides: opts.structuredInputMetaOverrides ?? null,
        }),
        nowMs: opts.nowMs,
    });

    const reason = preflight.nonSteerablePayloadReason;
    if (!reason || !isNonSteerableSendBlockerReason(reason)) {
        return PROCEED;
    }

    const isModeChangeBlocker = reason === 'mode_change_refused';
    const ownerMetadata = opts.session
        ? readSessionOwnerMetadataView(opts.session)
        : null;
    const desiredMode: PermissionMode | null =
        typeof opts.session?.permissionMode === 'string' && opts.session.permissionMode.length > 0
            ? opts.session.permissionMode
            : null;
    const choice = await confirmNonSteerableSend(reason, {
        offerApplyAndSteer: canApplySteerConfigInFlight(opts.session),
        offerSteerWithoutApplying: isModeChangeBlocker,
        ...(isModeChangeBlocker && desiredMode && opts.agentId
            ? {
                settingLabel: getPermissionModeTitleForAgentType(opts.agentId),
                valueLabel: getPermissionModeLabelForAgentType(opts.agentId, desiredMode),
            }
            : {}),
    });

    switch (choice) {
        case 'cancel':
            return { kind: 'cancelled' };
        case 'interrupt_and_send':
            return { kind: 'proceed', explicitMode: 'interrupt' };
        case 'apply_and_steer':
            return { kind: 'proceed', applyConfigAndSteer: true };
        case 'steer_without_applying':
            return {
                kind: 'proceed',
                steerWithoutConfig: true,
                steerWithoutConfigMetaOverrides: {
                    permissionMode:
                        typeof ownerMetadata?.permissionMode === 'string'
                            && ownerMetadata.permissionMode.length > 0
                            ? ownerMetadata.permissionMode
                            : 'default',
                },
            };
        case 'queue':
            return PROCEED;
    }
}
