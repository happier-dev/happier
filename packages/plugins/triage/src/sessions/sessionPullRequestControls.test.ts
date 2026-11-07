import { describe, expect, it } from 'vitest';
import { SessionPullRequestWatchReadResultV1Schema } from '@happier-dev/channels-protocol/v1';
import type { SessionAcceptedWorkspaceV1 } from '@happier-dev/plugin-sdk/sessions';
import { ProtocolActionApprovalRequestCreatedResultSchema } from '@happier-dev/plugin-sdk/protocol';
import { getActionSpec } from '@happier-dev/plugin-sdk/actions';
// The cross-plugin host boundary admits against the actual L08 owner schema.
import { LocalActRunFormInputV1Schema } from '../../../scm-github/src/actions/local/contracts.js';

import { acceptTriagePullRequestWatchOfferV1, openTriagePullRequestLocalFormV1, projectTriagePullRequestWatchOfferV1,
    readTriageSessionPullRequestWatchDefaultsV1 } from './sessionPullRequestControls.js';

const session = { serverId: 'home-1', sessionId: 'session-1' };
const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
const acceptedWorkspace: SessionAcceptedWorkspaceV1 = { repository,
    checkout: { serverId: session.serverId, workspaceId: 'workspace-1', machineId: 'machine-1', rootPath: '/work/widgets' } };
const policy = { mode: 'notify', archiveAfterMerge: false } as const;
function binding(mode = 'off', state = 'open') {
    const read = SessionPullRequestWatchReadResultV1Schema.parse({ kind: 'ready', sessionId: session.sessionId, bindings: [{
        bindingId: 'binding-1', revision: 7,
        link: { provider: 'github', repository: repository.repository, number: 7, url: 'https://github.com/acme/widgets/pull/7', state },
        watch: { policy: { ...policy, mode }, reason: null, fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null }, latestUpdate: null,
    }] });
    if (read.kind !== 'ready') throw new Error('Expected ready');
    return read.bindings[0]!;
}

describe('Session PR control operands', () => {
    it.each([5, null])('reads the actual Account Watch policy and limit %s from one public effective Settings snapshot', async fixAttemptLimit => {
        const requests: unknown[] = [];
        const selected = { mode: 'autoFix', archiveAfterMerge: true } as const;
        const result = await readTriageSessionPullRequestWatchDefaultsV1({ async executeAction(action, input) {
            requests.push({ action, input });
            return getActionSpec('plugins.settings.list').outputSchema.parse({ ok: true, kind: 'plugins.settings.list',
                data: { scope: { kind: 'account' }, target: { kind: 'account' }, revision: 'settings-7', fields: [
                    { localId: 'pr-watch-default-mode', secret: false, value: selected.mode },
                    { localId: 'pr-watch-fix-attempt-limit', secret: false, value: fixAttemptLimit },
                    { localId: 'pr-watch-archive-after-merge', secret: false, value: selected.archiveAfterMerge },
                ] } }) as never;
        } });
        expect(result).toEqual({ kind: 'ready', policy: selected, fixAttemptLimit });
        expect(requests).toEqual([{ action: 'plugins.settings.list', input: {
            pluginId: 'happier.channels', scope: { kind: 'account' }, target: { kind: 'account' },
        } }]);
        if (!('kind' in result) || result.kind !== 'ready') throw new Error('Expected actual Account defaults');
        expect(projectTriagePullRequestWatchOfferV1(session, binding(), result.policy)?.policy).toEqual(selected);
    });

    it('does not fabricate Notify defaults on unavailable Settings and preserves a canonical approval result', async () => {
        for (const result of [{ ok: false, kind: 'plugins.settings.list', errorCode: 'plugin_settings_unavailable', error: 'unavailable' },
            { ok: true, kind: 'plugins.settings.list', data: { scope: { kind: 'account' }, target: { kind: 'account' },
                revision: 'settings-8', fields: [] } }]) {
            await expect(readTriageSessionPullRequestWatchDefaultsV1({ executeAction: async () => result as never }))
                .resolves.toEqual({ kind: 'unavailable' });
        }
        const approval = ProtocolActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created',
            artifactId: 'settings-approval', actionId: 'plugins.settings.list' });
        await expect(readTriageSessionPullRequestWatchDefaultsV1({ executeAction: async () => approval as never }))
            .resolves.toEqual(approval);
    });

    it('offers the Account mode after open/link without configuring or escalating an existing choice', () => {
        expect(projectTriagePullRequestWatchOfferV1(session, binding(), policy)).toEqual({
            kind: 'offer', session, bindingId: 'binding-1', expectedRevision: 7, policy,
        });
        expect(projectTriagePullRequestWatchOfferV1(session, binding(), { ...policy, mode: 'off' })).toBeNull();
        expect(projectTriagePullRequestWatchOfferV1(session, binding('address'), { ...policy, mode: 'autoFix' })).toBeNull();
        expect(projectTriagePullRequestWatchOfferV1(session, binding('off', 'merged'), policy)).toBeNull();
        expect(projectTriagePullRequestWatchOfferV1(session, binding('off', 'closed'), policy)).toBeNull();
        for (const mode of ['notify', 'analyse', 'address', 'autoFix'] as const) {
            expect(projectTriagePullRequestWatchOfferV1(session, binding(), { ...policy, mode })?.policy.mode).toBe(mode);
        }
    });

    it('configures only after an explicit choice, retaining the exact Session and binding revision', async () => {
        const offer = projectTriagePullRequestWatchOfferV1(session, binding(), { ...policy, mode: 'autoFix' });
        if (offer === null) throw new Error('Expected an explicit offer');
        const effects: unknown[] = [];
        await expect(acceptTriagePullRequestWatchOfferV1({
            async readSession() { return session; }, async executeAction(action, input) {
            effects.push({ action, input });
            return { kind: 'updated', bindingId: 'binding-1', revision: 8 } as never;
        } }, offer)).resolves.toEqual({ kind: 'updated', bindingId: 'binding-1', revision: 8 });
        expect(effects).toEqual([{ action: { pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' },
            input: { kind: 'configure', sessionId: session.sessionId, bindingId: 'binding-1', expectedRevision: 7,
                policy: { ...policy, mode: 'autoFix' } } }]);
        await expect(acceptTriagePullRequestWatchOfferV1({
            async readSession() { return { ...session, serverId: 'other-home' }; },
            async executeAction() { throw new Error('Foreign Home cannot configure'); } }, offer))
            .resolves.toEqual({ kind: 'unavailable', reason: 'sessionUnavailable' });
    });

    it('keeps the host approval pending without reporting a watch change or retrying configuration', async () => {
        const offer = projectTriagePullRequestWatchOfferV1(session, binding(), { ...policy, mode: 'autoFix' });
        if (offer === null) throw new Error('Expected an explicit offer');
        const approval = ProtocolActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created',
            artifactId: 'approval-1', actionId: 'happier.channels/actions/session-pull-request-watch-v1' });
        let configurationRequests = 0;
        await expect(acceptTriagePullRequestWatchOfferV1({
            async readSession() { return session; }, async executeAction() {
            configurationRequests += 1;
            return approval as never;
        } }, offer)).resolves.toEqual(approval);
        expect(configurationRequests).toBe(1);
    });

    it('does not replace a manually removed Companion when accepting a retained post-link Watch offer', async () => {
        const linked = { kind: 'attached', bindingId: 'binding-1' } as const;
        const projected = projectTriagePullRequestWatchOfferV1(session, binding(), policy);
        if (!projected) throw new Error('Expected link-flow offer');
        // A retained offer from before this canonical cleanup may still carry the obsolete local member.
        const offer = { ...projected, linkEvent: linked };
        const actions: unknown[] = [];
        const result = await acceptTriagePullRequestWatchOfferV1({
            readSession: async () => session,
            async executeAction(action) {
                actions.push(action);
                if (typeof action === 'object') return { kind: 'updated', bindingId: 'binding-1', revision: 8 } as never;
                // The person removed the Companion after linking, before accepting this retained offer.
                if (action === 'widgets.catalog.list') return getActionSpec(action).outputSchema.parse({
                    surface: { serverId: session.serverId, accountId: 'viewer-1', owner: { kind: 'companion', sessionId: session.sessionId } },
                    entries: [], presentation: { sizes: ['medium'], defaultSize: 'medium' },
                }) as never;
                throw new Error('Unavailable widget must never be placed');
            },
        }, offer);
        expect(result).toMatchObject({ kind: 'updated' });
        expect(actions).toEqual([{ pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' }]);
    });

    it('opens only the existing local form with the accepted source checkout and proven cause, with no run or retry', async () => {
        const effects: unknown[] = [];
        const host = {
            async readSession(id: string) { effects.push({ readSession: id }); return { ...session, acceptedWorkspace }; },
            async executeAction(action: unknown, input: unknown) {
                effects.push({ action, input: LocalActRunFormInputV1Schema.parse(input) });
                return { kind: 'opened', mountId: 'mount-1' };
            },
        };
        const cause = { repository, workflowPath: '.github/workflows/test.yml', sourceHeadSha: 'a'.repeat(40) };
        await expect(openTriagePullRequestLocalFormV1(host, { session, binding: binding(), cause }))
            .resolves.toEqual({ kind: 'opened', mountId: 'mount-1' });
        expect(effects).toEqual([
            { readSession: session.sessionId },
            { action: { pluginId: 'happier.scm.forge.github', localId: 'github/actions/local-form' },
                input: { operation: { kind: 'open', seed: { target: { kind: 'session', sessionId: session.sessionId }, workspace: acceptedWorkspace.checkout,
                    workflowPath: cause.workflowPath, sourceHeadSha: cause.sourceHeadSha } } } },
        ]);
    });

    it('does not infer a checkout from Session display metadata or borrow a different repository cause', async () => {
        let writes = 0;
        const action = async () => { writes += 1; return { kind: 'opened', mountId: 'wrong' }; };
        for (const state of [null, { ...session }, { ...session, sessionId: 'another' },
            { ...session, serverId: 'other-home', acceptedWorkspace },
            { ...session, acceptedWorkspace: { ...acceptedWorkspace, repository: { ...repository, repository: 'acme/other' } } }]) {
            await expect(openTriagePullRequestLocalFormV1({ readSession: async () => state, executeAction: action },
                { session, binding: binding() })).resolves.toMatchObject({ kind: 'unavailable' });
        }
        await expect(openTriagePullRequestLocalFormV1({ readSession: async () => ({ ...session, acceptedWorkspace }), executeAction: action },
            { session, binding: binding(), cause: { repository: { ...repository, repository: 'acme/other' }, workflowPath: 'unrelated.yml' } }))
            .resolves.toEqual({ kind: 'unavailable', reason: 'repositoryMismatch' });
        expect(writes).toBe(0);
    });
});
