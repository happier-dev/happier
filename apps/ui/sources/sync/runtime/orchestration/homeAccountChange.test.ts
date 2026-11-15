import { describe, expect, it, vi } from 'vitest';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { BOT_TEMPLATE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import * as changePlanner from './changesPlanner';
import { log } from '@/log';
import { ACCOUNT_IDENTITIES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { buildSessionDraftAccountChangeEntityIdV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import {
    getHomeAccountChangeDemandedServerIds,
    isHomeAdministrationAccountChange,
    publishHomeAccountChange,
    publishHomeAccountChangeForRouting,
    publishHomeAccountChangeWake,
    subscribeHomeAccountChange,
} from './homeAccountChange';

describe('Home Account change subscriptions', () => {
    it('scopes early and consumed Artifact changes while retaining coarse recovery and legacy wakes', () => {
        const observer = vi.fn();
        const template = deriveArtifactStoredKindV1({ kind: BOT_TEMPLATE_ARTIFACT_KIND_V1 });
        const document = deriveArtifactStoredKindV1({ title: 'A normal Doc has no header kind' });
        const dispose = subscribeHomeAccountChange(observer, { artifactKinds: [BOT_TEMPLATE_ARTIFACT_KIND_V1],
            includeCatchUpPending: true, reconnect: 'refresh' });
        try {
            for (const source of ['socket', 'catch-up-pending'] as const) {
                publishHomeAccountChangeWake('artifact-home', { t: 'account-change', changeKinds: ['artifact'],
                    entityIds: ['unknown-document'], artifactKinds: [document] }, source);
            }
            const documentPlan = changePlanner.planSyncActionsFromChanges([
                { kind: 'artifact', entityId: 'unknown-document', cursor: 1, changedAt: 0, hint: { artifactKinds: [document] } },
                { kind: 'session', entityId: 'session', cursor: 2, changedAt: 0 },
            ]);
            publishHomeAccountChange('artifact-home', ['unknown-document', 'session'], { changeKinds: ['artifact', 'session'],
                artifactKinds: changePlanner.plannedArtifactKinds(documentPlan), feedPageConsumed: true });
            expect(observer).not.toHaveBeenCalled();
            publishHomeAccountChangeWake('artifact-home', { t: 'account-change', changeKinds: ['artifact'],
                entityIds: ['new-share'], artifactKinds: [template] }, 'socket');
            expect(observer).toHaveBeenCalledTimes(1);
            // Mixed known kinds must wake both the old and new kind after a type transition.
            publishHomeAccountChange('artifact-home', ['transition'], { changeKinds: ['artifact'],
                artifactKinds: [document, template], feedPageConsumed: true });
            expect(observer).toHaveBeenCalledTimes(2);
            const partialPlan = changePlanner.planSyncActionsFromChanges([
                { kind: 'artifact', entityId: 'document', cursor: 3, changedAt: 0, hint: { artifactKinds: [document] } },
                { kind: 'artifact', entityId: 'legacy', cursor: 4, changedAt: 0 },
            ]);
            publishHomeAccountChange('artifact-home', ['document', 'legacy'], { changeKinds: ['artifact'],
                artifactKinds: changePlanner.plannedArtifactKinds(partialPlan), feedPageConsumed: true });
            expect(observer).toHaveBeenCalledTimes(3);
            for (const artifactKinds of [undefined, [], ['invalid']]) {
                publishHomeAccountChangeWake('artifact-home', { t: 'account-change', changeKinds: ['artifact'],
                    entityIds: ['legacy'], artifactKinds }, 'socket');
            }
            publishHomeAccountChange('artifact-home', undefined, { source: 'snapshot' });
            publishHomeAccountChange('artifact-home', undefined, { source: 'connected', changesCatchUp: true });
            expect(observer).toHaveBeenCalledTimes(8);
        } finally { dispose(); }
    });
    it('routes a primary reconnect wake by each observer\'s reconnect class, and a secondary Home reconnect to all', () => {
        // A current app: one covered reader, one reader of data outside the changes feed, one reader whose
        // last read is current. A primary reconnect's changes catch-up delivers what changed while away.
        const reads = { covered: 0, refresh: 0, recover: 0 };
        let recoverReadCurrent = true;
        const releases = [
            subscribeHomeAccountChange(() => { reads.covered += 1; }),
            subscribeHomeAccountChange(() => { reads.refresh += 1; }, { reconnect: 'refresh' }),
            subscribeHomeAccountChange(() => { reads.recover += 1; }, { reconnect: { readNotCurrent: () => !recoverReadCurrent } }),
        ];
        try {
            publishHomeAccountChange('primary-home', undefined, { source: 'connected', changesCatchUp: true });
            expect(reads).toEqual({ covered: 0, refresh: 1, recover: 0 });
            // A reader whose last read failed during the outage still recovers on the reconnect.
            recoverReadCurrent = false;
            publishHomeAccountChange('primary-home', undefined, { source: 'connected', changesCatchUp: true });
            expect(reads).toEqual({ covered: 0, refresh: 2, recover: 1 });
            // The catch-up's own page still wakes covered readers.
            publishHomeAccountChange('primary-home', ['self'], { changeKinds: ['account'], feedPageConsumed: true });
            expect(reads.covered).toBe(1);
            // A secondary Home has no changes catch-up: every reader re-reads.
            recoverReadCurrent = true;
            publishHomeAccountChange('secondary-home', undefined, { source: 'connected' });
            expect(reads).toEqual({ covered: 2, refresh: 4, recover: 3 });
        } finally { for (const release of releases) release(); }
    });
    it('reports an observer failure without suppressing its siblings', () => {
        const logged = vi.spyOn(log, 'log');
        const sibling = vi.fn();
        const unsubscribeFailing = subscribeHomeAccountChange(() => { throw new Error('observer failed'); }, { serverIds: ['observer-home'] });
        const unsubscribeSibling = subscribeHomeAccountChange(sibling, { serverIds: ['observer-home'] });
        try {
            publishHomeAccountChange('observer-home', ['session-a'], { source: 'socket', changeKinds: ['session'], sessionSystemRecords: [] });
            expect({ siblingCalls: sibling.mock.calls.length,
                failures: logged.mock.calls.filter(([line]) => line.includes('observer failed')).length })
                .toEqual({ siblingCalls: 1, failures: 1 });
        } finally { unsubscribeFailing(); unsubscribeSibling(); logged.mockRestore(); }
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
    it.each(['socket', 'catch-up-pending'] as const)('routes a draft row wake on %s without a coarse Settings/Profile refresh', source => {
        // Every composer keystroke writes a draft row; its content-free wake names only the row id.
        const draft = buildSessionDraftAccountChangeEntityIdV2({ kind: 'newSession', draftId: '5d1f5c3e-2b7a-4c55-9a39-1a6f0f6f2d11' });
        const event = publishHomeAccountChangeWake('draft-home', { t: 'account-change', changeKinds: ['account'], entityIds: [draft] }, source);
        expect(event).toMatchObject({ changeKinds: ['account'], entityIds: [draft], accountSettingsAffects: false,
            publicProfileAffects: false, profileCatalogAffects: false });
        // An unknown Account row keeps the conservative coarse recovery.
        expect(publishHomeAccountChangeWake('draft-home', { t: 'account-change', changeKinds: ['account'], entityIds: ['unknown-row'] }, source))
            .toMatchObject({ accountSettingsAffects: true });
    });
    it('retains exact saved Workflow candidates with the definition owner identity vocabulary', () => {
        const observer = vi.fn();
        const dispose = subscribeHomeAccountChange(observer);
        try {
            const ids = ['11111111-1111-4111-8111-111111111111', 'retained-saved-definition'];
            publishHomeAccountChange('workflow-home', ids, { changeKinds: ['artifact'], feedPageConsumed: true });
            expect(observer).toHaveBeenLastCalledWith(expect.objectContaining({ changedWorkflowDefinitionIds: ids }));
        } finally { dispose(); }
    });
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
        const scopedObserver = vi.fn();
        const releaseScoped = subscribeHomeAccountChange(scopedObserver, { serverIds: ['source-topic-home'] });
        const releaseGeneric = subscribeHomeAccountChange(genericObserver);
        try {
            expect(getHomeAccountChangeDemandedServerIds()).toContain('source-topic-home');
            for (let index = 0; index < 20; index++) {
                publishHomeAccountChange('source-topic-home', [`session-${index}`], { changeKinds: ['session'] });
            }
            publishHomeAccountChange('source-topic-home', [], { usageSourcesMachineIds: ['another-machine'] });
            publishHomeAccountChange('another-home', [], { usageSourcesMachineIds: ['source-machine'] });
            publishHomeAccountChange('another-home', undefined, { source: 'connected' });
            expect.soft(sourceObserver, 'Unrelated Home facts must not wake the Source consumer').not.toHaveBeenCalled();
            // DFIX-C D6: explicit Home demand also scopes delivery; unscoped
            // observers retain their cross-Home observation contract.
            expect(scopedObserver).toHaveBeenCalledTimes(21);
            expect(scopedObserver.mock.calls.every(([event]) => event.serverId === 'source-topic-home')).toBe(true);
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
        } finally { releaseSource(); releaseScoped(); releaseGeneric(); }
        expect(getHomeAccountChangeDemandedServerIds()).toEqual(beforeDemand);
    });

    it('treats a linked-identity change as Home administration eligibility input', () => {
        const event = (entityIds: string[]) => ({ serverId: 'home-a', entityIds }) as Parameters<typeof isHomeAdministrationAccountChange>[0];
        expect(isHomeAdministrationAccountChange(event([ACCOUNT_IDENTITIES_ACCOUNT_CHANGE_ENTITY_ID_V1]))).toBe(true);
        expect(isHomeAdministrationAccountChange(event(['unrelated-row']))).toBe(false);
    });
});

it.each(['socket', 'catch-up-pending'] as const)('keeps compact record accounting quiet on %s while mixed accounting still wakes', async source => {
    const { buildSessionSystemRecordChangeV1 } = await import('@happier-dev/protocol/sessions/board/changeHint');
    const { USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS } = await import('@happier-dev/protocol/usage/usageWorkEvidence');
    const change = buildSessionSystemRecordChangeV1('compact-work-fact', {
        sessionId: 'session-one', address: USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS,
    });
    const wake = { t: 'account-change' as const, changeKinds: [change.kind], entityIds: [change.entityId],
        sessionSystemRecords: [change.hint.sessionRecords] };
    expect(publishHomeAccountChangeWake('compact-home', wake, source).usageAccountingAffects).toBe(false);
    expect(publishHomeAccountChangeWake('compact-home', { ...wake, entityIds: [...wake.entityIds, 'self'] }, source)
        .usageAccountingAffects).not.toBe(false);
    expect(publishHomeAccountChangeWake('compact-home', { ...wake, changeKinds: ['account', 'session'],
        entityIds: [...wake.entityIds, 'session-one'] }, source).usageAccountingAffects).not.toBe(false);
});
