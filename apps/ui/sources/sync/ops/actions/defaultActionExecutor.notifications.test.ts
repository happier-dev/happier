import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import type { StorageState } from '@/sync/store/types';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';

let daemonResult: unknown;
let beforeDaemonReply: (() => Promise<void>) | undefined;

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
let machineState: Pick<StorageState, 'machines' | 'machineListByServerId'>;

// Boundary installation above must run before loading the real Action graph;
// module preparation belongs to collection rather than the first hook timeout.
await import('@/sync/domains/state/storage');
await import('./defaultActionExecutor');

async function addHome() {
    const serverId = await harness.addHome({
        name: 'Notification Home',
        serverUrl: 'https://notifications-home.example',
        accountId: 'account-a',
        serverIdentityId: 'srv_notifications', currentAccount: true,
    });
    const machine = createMachineFixture({ id: 'machine-one', activeAt: Date.now(), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        access: { custodian: { accountId: 'account-a', displayName: 'Account A' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    await publishMachineInventoryForTest({ serverId, accountId: 'account-a' }, [machine]);
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
    const publishedMachine = { ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine }),
        installationId: 'notification-installation', installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null,
        replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null };
    harness.answer(serverId, '/v1/machines', { body: [publishedMachine] });
    // Requester custody uses the canonical exact read, not the ordinary census.
    harness.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine: publishedMachine } });
    for (const actionId of ['notifications.notify_me', 'action.options.resolve'] as const) {
        harness.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: { v: 1, token: 'notification-root', binding: { accountId: 'account-a',
                authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_notifications', machineId: machine.id,
                installationId: 'notification-installation', custodianAccountId: 'account-a', accountEncryptionMode: 'plain', actionId,
                requestId: request.envelope.requestId, target: request.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } } };
        } });
        harness.answer(serverId, `/v1/actions/${actionId}`, { select: async body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization, purpose: { kind: 'external_action' },
                machineId: machine.id, installationId: 'notification-installation', serverIdentityId: 'srv_notifications',
                installationPrivateKey: installation.secretKey, includeInvocation: true });
            expect(opened).toMatchObject({ invocation: {
                    caller: { kind: 'host' }, authority: actionId === 'notifications.notify_me' ? 'account_automation' : 'present_user',
                    surface: actionId === 'notifications.notify_me' ? 'voice' : 'ui' } });
            if (!opened?.invocation) throw new Error('Missing authenticated invocation');
            await beforeDaemonReply?.();
            // Only HTTP and the daemon's channel catalog are boundaries. In particular,
            // keep the real field-options surface admission beneath the UI adapter.
            const execution = actionId === 'action.options.resolve'
                ? await createActionExecutor(createActionExecutorBoundaryFixture({ notificationChannelsList: async () => {
                    if (daemonResult && typeof daemonResult === 'object' && 'options' in daemonResult
                        && Array.isArray(daemonResult.options)) return { items: daemonResult.options };
                    throw new Error('Missing channel catalog fixture');
                } })).execute(actionId, ExternalActionRequestEnvelopeV1Schema.parse(request.envelope).input, {
                    surface: opened.invocation.surface,
                    serverId, runtimeAccountId: 'account-a',
                })
                : daemonResult && typeof daemonResult === 'object' && 'ok' in daemonResult
                    ? daemonResult : { ok: true, result: daemonResult };
            return { body: { v: 1, actionId, requestId: request.envelope.requestId,
                execution } };
        } });
    }
    return serverId;
}

describe('default Action notification daemon transport', () => {
    beforeEach(async () => {
        await harness.reset();
        daemonResult = undefined;
        beforeDaemonReply = undefined;
        const { storage } = await import('@/sync/domains/state/storage');
        const state = storage.getState();
        machineState = { machines: state.machines, machineListByServerId: state.machineListByServerId };
    });

    afterEach(async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(machineState);
        standardCleanup();
    });

    it('sends Notify me through the captured Account daemon without inventing a resource target', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        daemonResult = { attemptedChannels: 1, deliveredChannels: 1 };
        const input = { title: 'Review', message: 'Review did not converge', channels: ['builtin:expo_push'] };

        // Keep the automation ceiling even when the Account's live Voice host can approve requests.
        await expect(createDefaultActionExecutor().execute('notifications.notify_me', input, {
            surface: 'voice', serverId, authority: 'account_automation',
        })).resolves.toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
        expect(harness.requestsFor('/v1/actions/notifications.notify_me').map(request =>
            ExternalActionRequestEnvelopeV1Schema.parse(ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.input).envelope).input)).toEqual([input]);
    });

    it('resolves channels through real daemon admission for standalone and Notify me field discovery', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const options = [{ value: 'plugin/channel', label: 'Plugin channel', disabled: true }];
        const result = {
            actionId: null, fieldPath: null, optionsSourceId: 'notifications.channels.available', options,
        };
        daemonResult = result;

        await expect(createDefaultActionExecutor().execute('action.options.resolve', {
            optionsSourceId: 'notifications.channels.available',
        }, { surface: 'ui', serverId })).resolves.toEqual({ ok: true, result });
        expect(harness.requestsFor('/v1/actions/action.options.resolve').map(request =>
            ExternalActionRequestEnvelopeV1Schema.parse(ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.input).envelope).input))
            .toEqual([{ optionsSourceId: 'notifications.channels.available' }]);
        await expect(createDefaultActionExecutor().execute('action.options.resolve', {
            actionId: 'notifications.notify_me', fieldPath: 'channels',
        }, { surface: 'ui', serverId })).resolves.toEqual({ ok: true, result: {
            ...result, actionId: 'notifications.notify_me', fieldPath: 'channels',
        } });
    });

    it('does not borrow the focused Home daemon for a notification Account on another Home', async () => {
        const serverId = await addHome();
        const otherServerId = await harness.addHome({
            name: 'Other Home', serverUrl: 'https://other-notifications-home.example', accountId: 'account-b',
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        daemonResult = { attemptedChannels: 1, deliveredChannels: 1 };
        await expect(createDefaultActionExecutor().execute('notifications.notify_me', { message: 'Private' }, {
            surface: 'voice', serverId, authority: 'account_automation',
        })).resolves.toEqual({ ok: true, result: daemonResult });
        expect(otherServerId).not.toBe(serverId);
        expect(harness.requestsFor('/v1/actions/notifications.notify_me').map(request => request.serverId)).toEqual([serverId]);
        expect(harness.requests.filter(request => request.serverId === otherServerId && request.path.startsWith('/v1/actions/'))).toEqual([]);
    });

    it('withholds channel content when the captured Account changes while its daemon answers', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        beforeDaemonReply = async () => {
            await harness.switchAccount(serverId, 'account-b');
        };
        daemonResult = { optionsSourceId: 'notifications.channels.available', options: [{ value: 'private/channel', label: 'Private channel' }] };
        await expect(createDefaultActionExecutor().execute('action.options.resolve', {
            optionsSourceId: 'notifications.channels.available',
        }, { surface: 'ui', serverId })).resolves.toMatchObject({
            ok: false, errorCode: 'action_account_scope_changed',
        });
    });

    it('preserves the daemon delivery failure rather than reporting a sent notification', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const failure = { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        daemonResult = failure;
        await expect(createDefaultActionExecutor().execute('notifications.notify_me', { message: 'Hi' }, {
            surface: 'voice', serverId, authority: 'account_automation',
        })).resolves.toMatchObject(failure);
    });
});
