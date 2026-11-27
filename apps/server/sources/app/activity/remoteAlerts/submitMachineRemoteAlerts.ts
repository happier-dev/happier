import { MachineRemoteAlertV1Schema, type MachineRemoteAlertV1 } from '@happier-dev/protocol/push/machineRemoteAlert';
import { AccountRemoteAlertPolicyBindingV1Schema, resolveAccountRemoteAlertPolicyCurrentness, resolveRemoteAlertPolicyDecision,
    type AccountRemoteAlertPolicyV1 } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import { resolveExpoNotificationSoundName, resolvePushNotificationAndroidChannelId } from '@happier-dev/protocol/push/pushNotificationActions';
import { resolveAttentionPushSoundId } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { shouldMuteMobileAlertsForComputerFocus } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { eventRouter } from '@/app/events/eventRouter';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { log } from '@/utils/logging/log';
import { sendAccountExpoPushMessages, type AccountPushDelivery } from '../accountPushTransport';

const recoveryRequestPrefix = (accountId: string) => `machine-remote-alert:recovery:${JSON.stringify(accountId)}:`;
const recoveryRequestKey = (accountId: string, machineId: string) => `${recoveryRequestPrefix(accountId)}${JSON.stringify(machineId)}`;

/** The settings CAS remembers only new enrollment while offline, for both UI and agent Actions. */
export async function reconcileMachineRecoveryNoticeRequestsInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    previousPolicy: unknown;
    nextPolicy: AccountRemoteAlertPolicyV1 | null;
}>): Promise<void> {
    const machineIds = params.nextPolicy?.machineOffline.machineIds ?? [];
    const previous = AccountRemoteAlertPolicyBindingV1Schema.safeParse(params.previousPolicy);
    const previousIds = previous.success ? previous.data.policy.machineOffline.machineIds : [];
    await params.tx.simpleCache.deleteMany({ where: { key: {
        startsWith: recoveryRequestPrefix(params.accountId),
        notIn: machineIds.map(machineId => recoveryRequestKey(params.accountId, machineId)),
    } } });
    const addedIds = machineIds.filter(machineId => !previousIds.includes(machineId));
    if (addedIds.length === 0) return;
    const offline = await params.tx.machine.findMany({ where: { accountId: params.accountId, id: { in: addedIds },
        active: false, revokedAt: null, replacedByMachineId: null }, select: { id: true } });
    for (const machine of offline) {
        const key = recoveryRequestKey(params.accountId, machine.id);
        await params.tx.simpleCache.upsert({ where: { key }, create: { key, value: 'pending' }, update: { value: 'pending' } });
    }
}

/** Presence owns the transition; current Machine custody and published consent own delivery. */
export async function submitMachineRemoteAlerts(params: Readonly<{
    machines: readonly Readonly<{ machineId: string; accountId: string }>[];
    phase: MachineRemoteAlertV1['phase'];
}>): Promise<void> {
    if (params.machines.length === 0) return;
    try {
        // Recheck custody at submission, rather than disclosing an old owner's
        // Machine identity after ownership, revocation or replacement changes.
        const machines = await db.machine.findMany({
            where: { OR: params.machines.map(({ machineId, accountId }) => ({ id: machineId, accountId })),
                revokedAt: null, replacedByMachineId: null },
            select: { id: true, accountId: true },
        });
        if (machines.length === 0) return;
        const accountIds = [...new Set(machines.map(machine => machine.accountId))];
        const [accounts, tokens] = await Promise.all([
            db.account.findMany({ where: { id: { in: accountIds } },
                select: { id: true, settingsVersion: true, remoteAlertPolicy: true } }),
            db.accountPushToken.findMany({ where: { accountId: { in: accountIds } },
                select: { accountId: true, token: true, remoteAlerts: true } }),
        ]);
        const now = new Date();
        const serverId = await getOrCreateServerIdentityId(process.env);
        const deliveries: AccountPushDelivery[] = [];
        const recoveryClaims: string[] = [];
        if (params.phase === 'recovered') {
            // Consume this return even when current delivery policy suppresses
            // it; a later outage must not revive an earlier one-shot request.
            for (const machine of machines) {
                const key = recoveryRequestKey(machine.accountId, machine.id);
                const claimed = await db.simpleCache.updateMany({ where: { key, value: 'pending' }, data: { value: 'submitted' } });
                if (claimed.count === 1) recoveryClaims.push(key);
            }
        }
        for (const account of accounts) {
            const current = resolveAccountRemoteAlertPolicyCurrentness(account.remoteAlertPolicy, account.settingsVersion);
            if (current.status !== 'current') continue;
            const policy = current.policy;
            if (!policy.events.machine_offline.enabled || !policy.channels.expo_push.enabled
                || !policy.channels.expo_push.events.machine_offline.enabled) continue;
            const enrolled = machines.filter(machine => machine.accountId === account.id
                && policy.machineOffline.machineIds.includes(machine.id));
            if (enrolled.length === 0) continue;
            let computerMuted: boolean | undefined;
            const readComputerMuted = async () => policy.mutePhoneWhenComputerFocused === true
                && shouldMuteMobileAlertsForComputerFocus({ mutePhoneWhenComputerFocused: true,
                    computerFocused: await eventRouter.hasFocusedComputerUi(account.id) });
            if (params.phase === 'offline') {
                computerMuted = await readComputerMuted();
                if (computerMuted) continue;
            }
            const deviceDecisions = tokens.filter(row => row.accountId === account.id).map(token => ({ token,
                decision: resolveRemoteAlertPolicyDecision({ accountPolicy: policy,
                    devicePolicy: token.remoteAlerts, event: 'machine_offline', now }) }));
            for (const machine of enrolled) {
                const key = recoveryRequestKey(account.id, machine.id);
                // The atomic claim above also handles batched/concurrent alive.
                const notifyReturn = recoveryClaims.includes(key);
                if (notifyReturn && computerMuted === undefined) computerMuted = await readComputerMuted();
                for (const { token, decision } of deviceDecisions) {
                    if (!decision || (params.phase === 'offline' && decision.delivery === 'suppress')) continue;
                    const data = MachineRemoteAlertV1Schema.parse({ type: 'machine_alert', v: 1,
                        serverId, accountId: account.id, machineId: machine.id, phase: params.phase,
                        previewBehavior: decision.previewBehavior });
                    if (params.phase === 'recovered' && (!notifyReturn || computerMuted || decision.delivery === 'suppress')) {
                        // Dismissal is not a new alert: quiet hours and focused
                        // computer muting must not leave an obsolete notice up.
                        deliveries.push({ accountId: account.id, token: token.token,
                            message: { to: token.token, priority: 'normal', _contentAvailable: true, data } });
                        continue;
                    }
                    const soundId = resolveAttentionPushSoundId(decision);
                    const sound = resolveExpoNotificationSoundName(soundId);
                    deliveries.push({ accountId: account.id, token: token.token, message: {
                        to: token.token, title: 'Happier', body: params.phase === 'recovered'
                            ? 'A machine you follow is back online.' : 'A machine you follow went offline.',
                        ...(params.phase === 'recovered' ? { _contentAvailable: true } : {}),
                        ...(sound === null ? {} : { sound }),
                        channelId: resolvePushNotificationAndroidChannelId({ kind: 'ready', soundId }),
                        priority: decision.delivery === 'silent' ? 'normal' : 'high', mutableContent: true, data,
                    } });
                }
            }
        }
        await sendAccountExpoPushMessages(deliveries, 'machine-remote-alerts');
        if (recoveryClaims.length > 0) {
            await db.simpleCache.deleteMany({ where: { key: { in: recoveryClaims }, value: 'submitted' } });
        }
    } catch (error) {
        // Optional push failure may not interrupt presence publication or change
        // the established timeout/heartbeat lifecycle.
        log({ module: 'machine-remote-alerts', level: 'warn', err: error }, 'Machine remote alert submission failed');
    }
}
