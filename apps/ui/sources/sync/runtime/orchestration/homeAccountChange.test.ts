import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { describe, expect, it, vi } from 'vitest';
import { publishHomeAccountChangeForRouting, publishHomeAccountChange, subscribeHomeAccountChange, getHomeAccountChangeDemandedServerIds, publishHomeAccountChangeWake } from './homeAccountChange';

describe('Home Account change subscriptions', () => {
    it('retains the exact accounting relevance fact independently of private evidence', () => {
        const observer = vi.fn();
        const dispose = subscribeHomeAccountChange(observer);
        try {
            publishHomeAccountChange('accounting-home', ['session-a'], { changeKinds: ['session'],
                usageQueryAffects: true, usageAccountingAffects: false });
            expect(observer).toHaveBeenLastCalledWith(expect.objectContaining({
                usageQueryAffects: true, usageAccountingAffects: false,
            }));
            publishHomeAccountChange('accounting-home', ['session-a'], { changeKinds: ['session'] });
            expect(observer.mock.calls.at(-1)?.[0]).not.toHaveProperty('usageAccountingAffects');
        } finally { dispose(); }
    });
    it('publishes the planned accounting relevance of secondary private and notification catalog wakes', () => {
        for (const kind of ['discussion', 'share', 'machineRecipientAccess'] as const) {
            const event = publishHomeAccountChangeWake('accounting-home', {
                t: 'account-change', changeKinds: [kind], entityIds: ['private-fact'],
            }, 'socket');
            expect.soft(event.usageAccountingAffects, kind).toBe(false);
        }
        const notification = publishHomeAccountChangeWake('accounting-home', {
            t: 'account-change', changeKinds: ['account'], entityIds: [NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1],
        }, 'socket');
        expect.soft(notification.usageQueryAffects, 'Notification channel configuration changes no Usage inputs').toBe(false);
        expect.soft(notification.usageAccountingAffects).toBe(false);
        const unknown = publishHomeAccountChangeWake('accounting-home', {
            t: 'account-change', changeKinds: ['account'], entityIds: ['unknown-account-fact'],
        }, 'socket');
        expect(unknown.usageQueryAffects).not.toBe(false);
        expect(unknown.usageAccountingAffects).not.toBe(false);
    });
    it('wakes an exact Usage source subscriber only for its Home/Machine and recovery while preserving generic observers', () => {
        const sourceObserver = vi.fn();
        const genericObserver = vi.fn();
        const beforeDemand = getHomeAccountChangeDemandedServerIds();
        const releaseSource = subscribeHomeAccountChange(sourceObserver, {
            serverIds: ['source-topic-home'], usageSourcesMachineIds: ['source-machine'],
        });
        const releaseGeneric = subscribeHomeAccountChange(genericObserver, { serverIds: ['source-topic-home'] });
        try {
            expect(getHomeAccountChangeDemandedServerIds()).toContain('source-topic-home');
            for (let index = 0; index < 20; index++) {
                publishHomeAccountChange('source-topic-home', [`session-${index}`], { changeKinds: ['session'] });
            }
            publishHomeAccountChange('source-topic-home', [], { usageSourcesMachineIds: ['another-machine'] });
            publishHomeAccountChange('another-home', [], { usageSourcesMachineIds: ['source-machine'] });
            publishHomeAccountChange('another-home', undefined, { source: 'connected' });
            expect.soft(sourceObserver, 'Unrelated Home facts must not wake the Source consumer').not.toHaveBeenCalled();
            // serverIds previously owned connection demand only. Generic observers
            // keep their existing cross-Home observation contract.
            expect(genericObserver).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'source-topic-home', changeKinds: ['session'] }));
            expect(genericObserver).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'another-home', source: 'connected' }));

            publishHomeAccountChange('source-topic-home', [], { usageSourcesMachineIds: ['source-machine'] });
            expect(sourceObserver).toHaveBeenCalledTimes(1);
            expect(sourceObserver).toHaveBeenLastCalledWith(expect.objectContaining({
                serverId: 'source-topic-home', usageSourcesMachineIds: ['source-machine'],
            }));
            for (const source of ['connected', 'snapshot'] as const) {
                publishHomeAccountChange('source-topic-home', undefined, { source });
                expect(sourceObserver).toHaveBeenLastCalledWith(expect.objectContaining({ serverId: 'source-topic-home', source }));
            }
            expect(sourceObserver).toHaveBeenCalledTimes(3);
            releaseSource();
            publishHomeAccountChange('source-topic-home', [], { usageSourcesMachineIds: ['source-machine'] });
            expect(sourceObserver).toHaveBeenCalledTimes(3);
        } finally { releaseSource(); releaseGeneric(); }
        expect(getHomeAccountChangeDemandedServerIds()).toEqual(beforeDemand);
    });
    it('routes Session-only wakes without waking unrelated Home catalogs', () => {
        const event = publishHomeAccountChangeForRouting('session-home', ['session-a'], {
            source: 'socket', changeKinds: ['session'], sessionSystemRecords: [] });
        expect(event).toMatchObject({ accountSettingsAffects: false, profileCatalogAffects: false,
            workflowTriggersAffect: false, workflowDefinitionsAffect: false });
        // Kind-only routing cannot exclude Session accounting without a detailed hint.
        expect(event.usageQueryAffects).toBe(true);
        expect(publishHomeAccountChangeForRouting('session-home', undefined, { source: 'socket' }))
            .toMatchObject({ accountSettingsAffects: true, workflowTriggersAffect: true });
        expect(publishHomeAccountChangeForRouting('session-home', ['unknown-plugin'], {
            source: 'socket', changeKinds: ['pluginDomain'] }).workflowTriggersAffect).toBe(true);
    });
});
