import { Modal } from '@/modal';
import { t } from '@/text';

/** Why the outgoing payload cannot steer the active turn (mirrors the submit-mode classifier). */
export type NonSteerableSendBlockerReason =
    | 'mode_change_refused'
    | 'special_command'
    | 'provider_config_change_refused';

export type NonSteerableSendChoice =
    | 'apply_and_steer'
    | 'steer_without_applying'
    | 'interrupt_and_send'
    | 'queue'
    | 'cancel';

export function isNonSteerableSendBlockerReason(value: unknown): value is NonSteerableSendBlockerReason {
    return value === 'mode_change_refused'
        || value === 'special_command'
        || value === 'provider_config_change_refused';
}

/**
 * Composer affordance for a busy send whose payload cannot steer the active turn (G4 honesty
 * modal). Offers, in order and only when honest:
 *
 * - "Apply <setting> → <value> & steer now" — ONLY when the backend published the in-flight
 *   config-apply capability (`offerApplyAndSteer`, fail-closed) and the blocker is a mode change.
 *   The label NAMES the setting and target value when the caller provides labels.
 * - "Steer now without applying" — defer-and-steer: the TEXT steers the running turn while the
 *   setting stays desired-state and applies on the next message. Offered for mode-change blockers
 *   only — a special command's text IS the command, so there is nothing to steer without it.
 * - "Queue for after turn" — the honest `server_pending` default.
 * - "Interrupt & send now" — reuses the existing `interrupt` delivery mode (abort, then send).
 *
 * Dismissal resolves as `cancel` so the caller leaves the composer untouched.
 */
export async function confirmNonSteerableSend(
    reason: NonSteerableSendBlockerReason,
    opts?: {
        offerApplyAndSteer?: boolean;
        offerSteerWithoutApplying?: boolean;
        /** Friendly setting name (e.g. "Permission mode") for the honest apply label. */
        settingLabel?: string;
        /** Friendly target value (e.g. "Plan") for the honest apply label. */
        valueLabel?: string;
    },
): Promise<NonSteerableSendChoice> {
    const offerApplyAndSteer = opts?.offerApplyAndSteer === true && reason === 'mode_change_refused';
    const offerSteerWithoutApplying = opts?.offerSteerWithoutApplying === true && reason === 'mode_change_refused';
    const messageKey = reason === 'special_command'
        ? 'agentInput.nonSteerableSend.specialCommandMessage'
        : reason === 'provider_config_change_refused'
            ? 'agentInput.nonSteerableSend.providerConfigMessage'
            : 'agentInput.nonSteerableSend.modeChangeMessage';
    const applyLabel = opts?.settingLabel && opts?.valueLabel
        ? t('agentInput.nonSteerableSend.applyNamedSettingAndSteer', {
            setting: opts.settingLabel,
            value: opts.valueLabel,
        })
        : t('agentInput.nonSteerableSend.applySettingAndSteer');
    return new Promise<NonSteerableSendChoice>((resolve) => {
        let settled = false;
        const choose = (choice: NonSteerableSendChoice) => {
            if (settled) return;
            settled = true;
            resolve(choice);
        };
        void Modal.alertAsync(
            t('agentInput.nonSteerableSend.title'),
            t(messageKey),
            [
                ...(offerApplyAndSteer
                    ? [{ text: applyLabel, onPress: () => choose('apply_and_steer') }]
                    : []),
                ...(offerSteerWithoutApplying
                    ? [{ text: t('agentInput.nonSteerableSend.steerWithoutApplying'), onPress: () => choose('steer_without_applying') }]
                    : []),
                { text: t('agentInput.nonSteerableSend.queueForAfterTurn'), onPress: () => choose('queue') },
                { text: t('agentInput.nonSteerableSend.interruptAndSend'), style: 'destructive', onPress: () => choose('interrupt_and_send') },
                { text: t('common.cancel'), style: 'cancel', onPress: () => choose('cancel') },
            ],
        ).then(() => choose('cancel'));
    });
}
