import { describe, expect, it } from 'vitest';

import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import {
    TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1,
    TRIAGE_DEFAULT_ACTIONS_V1,
} from '../settings/actions.js';
import {
    TriageAdministerActionInputV1Schema,
    TriageAdministerActionResultV1Schema,
    TriageReadActionsResultV1Schema,
    TriageReadActionsActionInputV1Schema,
} from './actionsCatalogProtocol.js';
import { administerTriageAction, readTriageActionsForSurface, createTriageReadActionsActionHandler } from './actionsCatalog.js';
import type { TriageDataActionContext } from './dataContext.js';

/**
 * The two catalog Actions, exercised through their own published schemas.
 *
 * Account KV is the one genuine host boundary replaced; the parser,
 * the bounds, the closed vocabularies and the CAS decision underneath are the
 * real `settings/actions.ts`. Every value here crosses its own wire schema
 * rather than being asserted as a bare object, so a result the transport would
 * reject cannot be recorded as one that answered.
 */

/** The host's admitted-contribution service is a genuine boundary; no plugin contributes agent actions here. */
const NO_AGENT_ACTIONS = { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [] }), dispose: () => {} }) };

describe('the configured-action Actions', () => {
    it('offers the Workflows owner record only for Workflow Runs through the shared catalog', async () => {
        const testkit = createTestkitAccountKv();
        const context = { signal: new AbortController().signal,
            services: { storage: { account: { kv: testkit.kv } }, targetedContributions: NO_AGENT_ACTIONS } } as unknown as TriageDataActionContext;
        const read = await createTriageReadActionsActionHandler()(TriageReadActionsActionInputV1Schema.parse({
            v: 1, projection: 'sessionHandoff', task: 'investigate', subject: 'workflowRun' }), context);
        expect(read).toMatchObject({ kind: 'choices', actions: expect.arrayContaining([
            expect.objectContaining({ forSubject: true, selection: expect.objectContaining({ configuredActionId: 'workflows.investigate-run' }) }),
        ]) });
        const other = await createTriageReadActionsActionHandler()(TriageReadActionsActionInputV1Schema.parse({
            v: 1, projection: 'sessionHandoff', task: 'investigate', subject: 'deploymentEnvironment' }), context);
        if (!('kind' in other) || other.kind !== 'choices') throw new Error('Expected handoff choices');
        expect(other.actions.some(action => action.selection.configuredActionId === 'workflows.investigate-run')).toBe(false);
        expect(testkit.setCallCount()).toBe(0);
    });
    it('chooses the configured investigation default and preserves its disabled choice through the same catalog read', async () => {
        const testkit = createTestkitAccountKv();
        // Account storage is the genuine host boundary; catalog policy and CAS remain real.
        const context = { signal: new AbortController().signal,
            services: { storage: { account: { kv: testkit.kv } }, targetedContributions: NO_AGENT_ACTIONS } } as unknown as TriageDataActionContext;
        const input = TriageReadActionsActionInputV1Schema.parse({ v: 1, projection: 'sessionHandoff', task: 'investigate' });
        const read = () => createTriageReadActionsActionHandler()(input, context);
        expect(await read()).toMatchObject({ kind: 'choices', defaultActionId: 'investigate',
            actions: expect.arrayContaining([expect.objectContaining({ selection: expect.objectContaining({ configuredActionId: 'investigate' }) })]) });
        await administerTriageAction({ v: 1, kind: 'delete', actionId: 'investigate', expectedRevision: 'absent' },
            { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' });
        expect(await read()).toMatchObject({ kind: 'choices', defaultActionId: null });
        expect(testkit.setCallCount()).toBe(1);
    });
    it('offers a non-entry handoff only actions that apply to native subjects', async () => {
        const testkit = createTestkitAccountKv();
        const deps = { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'deploy-only' };
        // A subject-owned record targets one native subject; the shared failure menus must not offer it elsewhere.
        expect(await administerTriageAction(TriageAdministerActionInputV1Schema.parse({ v: 1, kind: 'create',
            expectedRevision: 'absent', label: 'Set it up', enabled: true, appliesTo: ['deploymentEnvironment'],
            profileId: null, workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' } }), deps)).toMatchObject({ status: 'applied' });
        const context = { signal: new AbortController().signal,
            services: { storage: { account: { kv: testkit.kv } }, targetedContributions: NO_AGENT_ACTIONS } } as unknown as TriageDataActionContext;
        const input = TriageReadActionsActionInputV1Schema.parse({ v: 1, projection: 'sessionHandoff', task: 'investigate' });
        const read = await createTriageReadActionsActionHandler()(input, context);
        if (!('kind' in read) || read.kind !== 'choices') throw new Error('Expected handoff choices');
        expect(read.actions.map(action => action.selection.configuredActionId)).toEqual(['ask', 'fix', 'investigate']);
        expect(read.defaultActionId).toBe('investigate');
    });
    it('reads a native subject\'s own records with the launch mode and start availability the catalog owner decides', async () => {
        const testkit = createTestkitAccountKv();
        const deps = { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'set-up' };
        expect(await administerTriageAction(TriageAdministerActionInputV1Schema.parse({ v: 1, kind: 'create',
            expectedRevision: 'absent', label: 'Set it up', enabled: true, appliesTo: ['deploymentEnvironment'],
            profileId: null, workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' } }), deps)).toMatchObject({ status: 'applied' });
        const context = { signal: new AbortController().signal,
            services: { storage: { account: { kv: testkit.kv } }, targetedContributions: NO_AGENT_ACTIONS } } as unknown as TriageDataActionContext;
        const read = await createTriageReadActionsActionHandler()(TriageReadActionsActionInputV1Schema.parse({
            v: 1, projection: 'sessionHandoff', task: 'investigate', subject: 'deploymentEnvironment' }), context);
        if (!('kind' in read) || read.kind !== 'choices') throw new Error('Expected handoff choices');
        const selection = (configuredActionId: string) => ({ configuredActionId,
            sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured' });
        const byId = new Map(read.actions.map(action => [action.selection.configuredActionId, action]));
        expect(byId.get('ask')).toEqual({ label: 'Ask', selection: selection('ask'), launchMode: 'review', startable: false,
            titleKey: 'plugins.triage.surface.session.ask' });
        expect(byId.get('fix')).toEqual({ label: 'Fix', selection: selection('fix'), launchMode: 'review', startable: true,
            titleKey: 'plugins.triage.surface.session.fix' });
        expect(byId.get('investigate')).toEqual({ label: 'Investigate', selection: selection('investigate'),
            launchMode: 'start', startable: true, titleKey: 'plugins.triage.surface.session.investigate' });
        // Only the Environment's own records are marked for the page; the failure menus never offer them.
        expect(byId.get('set-up')).toEqual({ label: 'Set it up', selection: selection('set-up'), launchMode: 'review',
            startable: false, forSubject: true });
        const environmentOwn = [...TRIAGE_DEFAULT_ACTIONS_V1.filter(action => action.appliesTo.includes('deploymentEnvironment'))
            .map(action => action.actionId), 'set-up'];
        expect(read.actions.filter(action => action.forSubject === true).map(action => action.selection.configuredActionId))
            .toEqual(environmentOwn);
        expect(read.actions.map(action => action.selection.configuredActionId))
            .toEqual(['ask', 'fix', 'investigate', ...environmentOwn]);
    });
    it('resets stored opt-outs to absent through the administer contract and preserves a newer catalog', async () => {
        const testkit = createTestkitAccountKv();
        const deps = { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' };
        const read = () => readTriageActionsForSurface({ v: 1 }, deps).then(value => TriageReadActionsResultV1Schema.parse(value));
        const off = await administerTriageAction(TriageAdministerActionInputV1Schema.parse({
            v: 1, kind: 'delete', actionId: 'fix', expectedRevision: (await read()).revision,
        }), deps);
        expect(off.status).toBe('applied');
        const resetInput = { v: 1, kind: 'reset', expectedRevision: (await read()).revision };
        expect(TriageAdministerActionInputV1Schema.safeParse(resetInput).success).toBe(true);
        const reset = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse(resetInput), deps));
        expect(reset).toMatchObject({ status: 'applied', actions: TRIAGE_DEFAULT_ACTIONS_V1 });
        expect(testkit.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toBeUndefined();
        expect(await read()).toMatchObject({ availability: 'absent', actions: TRIAGE_DEFAULT_ACTIONS_V1, revision: reset.revision });
        testkit.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [] });
        expect(await administerTriageAction(TriageAdministerActionInputV1Schema.parse({
            v: 1, kind: 'reset', expectedRevision: reset.revision,
        }), deps)).toEqual({ v: 1, status: 'conflict' });
        expect(testkit.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toEqual({ v: 1, actions: [] });
        testkit.armConcurrentWrite(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [], other: 'newer writer' });
        expect(await administerTriageAction(TriageAdministerActionInputV1Schema.parse({
            v: 1, kind: 'reset', expectedRevision: (await read()).revision,
        }), deps)).toEqual({ v: 1, status: 'conflict' });
        expect(testkit.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toEqual({ v: 1, actions: [], other: 'newer writer' });
    });
    it('upgrades stored defaults and keeps built-in opt-outs across catalog Actions', async () => {
        const testkit = createTestkitAccountKv();
        testkit.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, {
            v: 1, actions: TRIAGE_DEFAULT_ACTIONS_V1.slice(0, 3).map(action => ({ ...action, appliesTo: [...action.appliesTo] })),
        });
        const deps = { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'custom' };
        const read = () => readTriageActionsForSurface({ v: 1 }, deps).then(value => TriageReadActionsResultV1Schema.parse(value));
        expect((await read()).actions).toEqual(TRIAGE_DEFAULT_ACTIONS_V1);
        const deleted = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({ v: 1, kind: 'delete', actionId: 'explain-pr', expectedRevision: (await read()).revision }), deps));
        expect(deleted.status).toBe('applied');
        expect(deleted.actions?.find(action => action.actionId === 'explain-pr')?.enabled).toBe(false);
        expect((await read()).actions).toEqual(deleted.actions);

        const created = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({ v: 1, kind: 'create', expectedRevision: (await read()).revision,
                label: 'My action', enabled: true, appliesTo: ['issue'], profileId: null, workspaceMode: 'reference_only',
                target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' } }), deps));
        expect(created.status).toBe('applied');
        const removed = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({ v: 1, kind: 'delete', actionId: 'custom', expectedRevision: (await read()).revision }), deps));
        expect(removed.status).toBe('applied');
        expect((await read()).actions).toEqual(deleted.actions);
    });

    it('keeps shipped fallback instructions read-only on the catalog mutation wire', () => {
        const customFallback = {
            v: 1,
            kind: 'create',
            expectedRevision: 'absent',
            label: 'Repair',
            enabled: true,
            appliesTo: ['issue'],
            profileId: null,
            workspaceMode: 'repository',
            target: {
                kind: 'agent',
                promptInvocationId: null,
                seededFallbackInstruction: 'Custom prompt text must live in Prompt Library.',
                delivery: 'send',
            },
        };

        expect(TriageAdministerActionInputV1Schema.safeParse(customFallback).success).toBe(false);
        expect(TriageAdministerActionInputV1Schema.safeParse({
            ...customFallback,
            kind: 'update',
            actionId: 'fix',
        }).success).toBe(false);
    });

    it('answers an absent catalog as the shipped seed rather than as an empty set', async () => {
        const testkit = createTestkitAccountKv();

        const result = TriageReadActionsResultV1Schema.parse(
            await readTriageActionsForSurface({ v: 1 }, { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) }),
        );

        // `absent` and `parsed` are different answers and the surface needs
        // both: absent is showing the seed and the first write stores it.
        expect(result.availability).toBe('absent');
        expect(result.actions.map((action) => action.label))
            .toEqual(TRIAGE_DEFAULT_ACTIONS_V1.map(action => action.label));
        // The runnable Review arm is explicit on the wire, so nothing
        // downstream infers it from a label.
        expect(result.actions[2]?.target)
            .toEqual({
                kind: 'agent',
                promptInvocationId: null,
                seededFallbackInstruction: 'Review this change.',
                delivery: 'compose',
            });
    });

    it('creates against the seed, so a first action does not delete the shipped actions', async () => {
        const testkit = createTestkitAccountKv();

        const input = TriageAdministerActionInputV1Schema.parse({
            v: 1,
            kind: 'create',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            label: 'Explain',
            enabled: true,
            appliesTo: ['errorIssue'],
            profileId: 'profile-7',
            workspaceMode: 'reference_only',
            target: {
                kind: 'agent',
                promptInvocationId: '/explain',
                promptArgsText: '--depth thorough',
                delivery: 'send',
            },
        });
        const applied = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(input, {
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'minted-1',
        }));

        expect(applied.status).toBe('applied');
        expect(applied.actions?.map((action) => action.label))
            .toEqual([...TRIAGE_DEFAULT_ACTIONS_V1.map(action => action.label), 'Explain']);

        // The seed became stored bytes on that first write, which is also the
        // moment the person first expressed an opinion about it.
        const read = TriageReadActionsResultV1Schema.parse(
            await readTriageActionsForSurface({ v: 1 }, { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) }),
        );
        expect(read.availability).toBe('parsed');
        expect(read.revision).toEqual(testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1));
        expect(read.actions.at(-1)).toEqual({
            actionId: 'minted-1',
            label: 'Explain',
            enabled: true,
            appliesTo: ['errorIssue'],
            profileId: 'profile-7',
            workspaceMode: 'reference_only',
            target: {
                kind: 'agent',
                promptInvocationId: '/explain',
                promptArgsText: '--depth thorough',
                delivery: 'send',
            },
        });
    });

    it('reorders as an exact permutation and refuses anything else', async () => {
        const testkit = createTestkitAccountKv();
        const deps = { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' };
        const reorderedIds = ['review', 'ask', 'fix', ...TRIAGE_DEFAULT_ACTIONS_V1.slice(3).map(action => action.actionId)];

        const reordered = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'reorder',
                expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                actionIds: reorderedIds,
            }),
            deps,
        ));
        expect(reordered.actions?.map((action) => action.actionId))
            .toEqual(reorderedIds);

        // A shorter list would delete an action under the guise of reordering.
        const dropped = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'reorder',
                expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                actionIds: ['review', 'ask'],
            }),
            deps,
        ));
        expect(dropped).toEqual({ v: 1, status: 'rejected', reason: 'reorder' });
    });

    it('declines to overwrite a catalog this build cannot read', async () => {
        const testkit = createTestkitAccountKv();
        testkit.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 9 });

        const read = TriageReadActionsResultV1Schema.parse(
            await readTriageActionsForSurface({ v: 1 }, { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) }),
        );
        // Not `absent`: reporting it as "you have configured nothing" is exactly
        // what would invite the next ordinary write to destroy it.
        expect(read.availability).toBe('unavailable');

        const refused = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'delete',
                expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                actionId: TRIAGE_DEFAULT_ACTIONS_V1[0]!.actionId,
            }),
            { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' },
        ));
        expect(refused).toEqual({ v: 1, status: 'unreadable' });
        expect(testkit.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toEqual({ v: 9 });
    });

    it('reports the host revision conflict as itself rather than as a failure', async () => {
        const testkit = createTestkitAccountKv();
        // Another device writes between this owner's read and its write.
        testkit.armConcurrentWrite(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [] });

        const result = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'delete',
                expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                actionId: 'ask',
            }),
            { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' },
        ));

        expect(result).toEqual({ v: 1, status: 'conflict' });
    });
});
