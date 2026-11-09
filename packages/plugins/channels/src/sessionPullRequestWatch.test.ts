import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PluginError, type JsonValue, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import { NormalizedPluginAccountCollectionContractV1Schema, preparePluginAccountCollectionContractV1 } from '../../../protocol/src/plugins/data/collectionsV1.js';
import { SessionMessageSendResultV1ProtocolSchema } from '@happier-dev/plugin-sdk/sessions';
import { SessionPullRequestWatchListResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { CHANNELS_PLUGIN } from './manifest.js';
import { GITHUB_PLUGIN } from '../../scm-github/src/manifest.js';
import { GITHUB_CHANNEL_PULL_REQUESTS } from '../../scm-github/src/githubChannelContribution.js';
import { channelsProviderDescriptorFixture } from './testkit/operationOnlyTargetedContributionsFixture.js';
import { activate as activateAccount } from './accountRuntime.js';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_INDEX_ID, SessionPullRequestConfiguredFixCustodySchema } from './collections.js';
import { withChannelStateSessionIdentity } from './collectionMigrations.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { sessionPullRequestBindingFixture } from './testkit/sessionPullRequestBindingFixture.js';
import { assembleSessionPullRequestWatchMetadata, observeSessionPullRequestWatchAction,
    type SessionPullRequestWatchContext } from './sessionPullRequestWatch.js';
import { readConversationBindingUpdateRow } from './accountLocalBindingPolicy.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import type { SettingsChange } from '@happier-dev/plugin-sdk/settings';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { prepareConversationIngressObligationForBindingDeletion, prepareConversationIngressObligationForConnectionDeletion } from './ingress.js';
import { runTriageConfiguredHandoffV1 } from '../../triage/src/sessions/configuredActionRun.js';
import { testkitEntryRef, testkitLocator } from '../../triage/src/corpus/testkit/observations.test-support.js';
import { testkitConfiguredInstance, TESTKIT_OBSERVED_REVISION, testkitTriageActionId } from '../../triage/src/sessions/testkit/entrySessionTestkit.test-support.js';
import { TRIAGE_VERIFY_EXISTING_REVIEW_WORKSPACE_ACTION_LOCAL_ID_V1 } from '../../triage/src/actions/entrySessionProtocol.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1 } from '@happier-dev/triage-protocol/v1';

describe('portable Account PR Watch Action', () => {
    async function configuredFixFixture(options: { head?: string; expectedHead?: string; closed?: boolean; exhausted?: boolean;
        send?: 'rejected' | 'unknownThenAccepted' | 'typedError' | 'fanoutFailure' | 'fanoutUnknownThenFailure'; endpointMetadata?: boolean } = {}) {
        const declaration = GITHUB_PLUGIN.manifest.contributes.targetedPluginContributions?.find(entry => typeof entry.target === 'object' && entry.target !== null && 'pluginId' in entry.target && entry.target.pluginId === CHANNELS_PLUGIN.manifest.id);
        if (!declaration) throw new Error('Missing real GitHub Channels contribution');
        const state = new MemoryCollection<Record<string, JsonValue>>();
        const value = sessionPullRequestBindingFixture('pr-1', 'session-a', 12, options.closed ? 'closed' : 'open');
        const target = { ...value.payload.target, pullRequestWatch: {
            policy: { mode: 'address', archiveAfterMerge: false },
            progress: { roundsStarted: options.exhausted ? 3 : 0, continuationRounds: 0 },
        } } as const;
        if (value.payload.endpoint.kind !== 'githubPullRequest') throw new Error('Expected the PR endpoint');
        const { pullRequest: _duplicate, ...legacyEndpoint } = value.payload.endpoint;
        await state.put(withChannelStateSessionIdentity({ ...value, payload: { ...value.payload,
            endpoint: options.endpointMetadata === false ? legacyEndpoint : value.payload.endpoint, enabled: true, target } }, target), { expectedRevision: 'absent' });
        await state.put(createCurrentConversationConnectionFixture({ connectionId: 'connection-1', authority: {
            providerPluginId: GITHUB_PLUGIN.manifest.id, providerContributionSelection: { contributionId: declaration.id },
            providerSetupInput: {}, credentialRef: null, transportOrigin: { serverIdentityId: 'srv_example', machineId: 'machine-example' },
            providerConnectionKey: 'example:connection-1', providerConfig: {}, integrationPrincipal: { id: 'bot' },
            routingIdentityKey: 'r'.repeat(43), authorityEpoch: 1,
        } }), { expectedRevision: 'absent' });
        let witness: string | undefined;
        let completed = false;
        let sendAttempts = 0;
        const execute = vi.fn(async (id: string, _input?: JsonValue) => {
            if (id === 'session.targets.resolve') return { coverage: 'complete', addresses: [{ sessionId: 'session-a', serverId: 'srv_example' }], error: null };
            if (id === 'session.status.get') return { session: { id: 'session-a' }, acceptedWorkspace: {
                checkout: { serverId: 'srv_example', workspaceId: 'workspace-1', machineId: 'machine-example', rootPath: '/repo' },
            } };
            if (id === 'scm.pullRequest.get') return { success: true, pullRequest: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub' }, number: 12, title: 'Widgets',
                url: 'https://github.com/acme/widgets/pull/12', baseBranch: 'main', headBranch: 'feature',
                headRepositoryNameWithOwner: 'acme/widgets', headSha: options.head ?? 'head-1', state: 'open',
            } };
            if (id === 'session.message.send') {
                sendAttempts += 1;
                if (options.send === 'unknownThenAccepted' && sendAttempts === 1) throw new Error('Lost host acknowledgement');
                if (options.send === 'typedError') throw new PluginError({ code: 'machine_admission_transport_unavailable',
                    message: 'The Session transport is unavailable.', retryable: true });
                if (options.send === 'rejected') return { status: 'rejected', code: 'session_input_cancelled' };
                if (options.send === 'fanoutUnknownThenFailure' && sendAttempts === 1) return { kind: 'fanout', results: [{
                    target: { serverId: 'srv_example', sessionId: 'session-a' },
                    result: { ok: true, result: { status: 'outcomeUnknown', localId: 'configured-input', code: 'lost_ack' } },
                }] };
                if (options.send === 'fanoutFailure' || options.send === 'fanoutUnknownThenFailure') return { kind: 'fanout', results: [{
                    target: { serverId: 'srv_example', sessionId: 'session-a' }, result: {
                        ok: false, errorCode: 'unavailable', error: 'Unavailable', effectAttempted: false,
                        failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: null, httpStatus: null },
                    },
                }] };
                return { status: 'accepted', localId: 'configured-input' };
            }
            if (id === 'session.input.result.get') return { ok: true, sessionId: 'session-a', localId: 'configured-input',
                acceptedTurnId: 'turn-1', ...(witness ? { turnStartWitnessId: witness } : {}),
                result: completed ? { kind: 'final_text', text: 'Done' } : { kind: 'pending' } };
            throw new Error(`Unexpected host Action ${id}`);
        });
        const targetedContributions = channelsProviderDescriptorFixture(GITHUB_PLUGIN.manifest);
        const services = {
            targetedContributions,
            storage: { account: { collection: () => state } } as unknown as PluginServices['storage'],
            actions: { execute } as unknown as PluginServices['actions'],
            settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' as const }, revision: '1', values: {} }),
                get: async () => null, describe: () => [], watch: () => ({ dispose() {} }),
                set: async () => { throw new Error('Read only'); }, reset: async () => { throw new Error('Read only'); } }) },
        };
        const kit = await createPluginTestkit({ manifest: CHANNELS_PLUGIN.manifest,
            module: { activate: CHANNELS_PLUGIN.activate, activateAccount }, services });
        const request = { kind: 'deliverConfiguredFix', sessionId: 'session-a', bindingId: 'pr-1', expectedRevision: 1,
            pullRequest: { repository: 'acme/widgets', number: 12 }, expectedHeadSha: options.expectedHead ?? 'head-1',
            delivery: { idempotencyKey: 'configured-fix-1', text: 'Fix this pull request.',
                attachments: [{ attachmentLocalId: 'entry', value: { key: 'entry-12', value: { entryId: '12' },
                    presentation: { label: 'Pull request 12' } } }],
                forgeEvidence: { v: 1, items: [{ source: { kind: 'hostedCi', label: 'CI' }, author: { kind: 'process' }, text: 'A check failed.' }] } },
        } as const;
        return { state, execute, request, kit,
            invoke: (input: JsonValue = request, surface: 'ui' | 'agent' = 'ui') => kit.invokeAction('session-pull-request-watch-v1', input, { surface }),
            start: (id = 'turn-1') => { witness = id; }, complete: () => { completed = true; },
            progress: async () => {
                const row = await state.get('pr-1');
                if (!row) throw new Error('Missing binding');
                const { binding } = readConversationBindingUpdateRow({ row, bindingId: row.rowId });
                return binding.target.kind === 'session' ? binding.target.pullRequestWatch?.progress : undefined;
            } };
    }
    it('retains the exact stored channel-state v19 writer digest', () => {
        // Authenticated public Data contracts captured on 2026-10-30; current
        // declarations can advance without rewriting this retained writer.
        const retained: unknown = JSON.parse(readFileSync(new URL('./testkit/fixtures/channelContractsV19V5.json', import.meta.url), 'utf8'));
        if (retained === null || typeof retained !== 'object' || !('contracts' in retained) || !Array.isArray(retained.contracts)) {
            throw new Error('Missing retained public Collection contracts');
        }
        const writer = retained.contracts.map(value => NormalizedPluginAccountCollectionContractV1Schema.parse(value))
            .find(value => value.collectionId === CHANNEL_STATE_COLLECTION.id);
        if (!writer) throw new Error('Missing retained channel-state writer');
        const { pluginId, collectionId: id, contractDigest, ...declaration } = writer;
        const { normalized: contract } = preparePluginAccountCollectionContractV1({ pluginId,
            contribution: { ...declaration, id } });
        expect(contract.schemaVersion).toBe(19);
        expect(contract.contractDigest).toBe(contractDigest);
    });
    it('loads a stored v19 configured Fix fanout failure carrying cause', async () => {
        const f = await configuredFixFixture();
        try {
            const value = { id: 'f'.repeat(43), 'record-kind': 'ingress-obligation', v: 1,
                'connection-id': 'connection-1', 'binding-id': 'pr-1', 'session-id': 'session-a',
                terminal: true, attention: false, 'created-at': 1, 'updated-at': 1,
                payload: { kind: 'configuredFix', request: f.request, result: { kind: 'fanout', results: [{
                    target: { serverId: 'srv_example', sessionId: 'session-a' }, result: { ok: false,
                        errorCode: 'unavailable', error: 'Unavailable', effectAttempted: false,
                        cause: { phase: 'dispatch', errorClass: 'Error', errorCode: null, httpStatus: null },
                    },
                }] } } };
            expect(SessionMessageSendResultV1ProtocolSchema.safeParse(value.payload.result).success).toBe(false);
            const leaf = value.payload.result.results[0]!;
            const { cause, ...failure } = leaf.result;
            expect(SessionMessageSendResultV1ProtocolSchema.safeParse({ kind: 'fanout', results: [{
                ...leaf, result: { ...failure, failureCause: cause },
            }] }).success).toBe(true);
            expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), value)).toBe(true);
            expect(SessionPullRequestConfiguredFixCustodySchema.parse(value.payload)).toEqual(value.payload);
        } finally { await f.kit.dispose(); }
    });
    it.each(['fanoutFailure', 'fanoutUnknownThenFailure'] as const)('stores configured Fix fanout failure cause and replays its live failureCause without resending (%s)', async send => {
        const f = await configuredFixFixture({ send });
        try {
            if (send === 'fanoutUnknownThenFailure') {
                await expect(f.invoke()).resolves.toMatchObject({ kind: 'configuredFixResult', result: { kind: 'fanout',
                    results: [{ result: { ok: true, result: { status: 'outcomeUnknown' } } }],
                } });
                const pending = [...f.state.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation');
                expect(pending?.value.terminal).toBe(false);
                expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), pending?.value)).toBe(true);
            }
            const first = await f.invoke();
            expect(first).toMatchObject({ kind: 'configuredFixResult', result: { kind: 'fanout', results: [{
                result: { ok: false, failureCause: { phase: 'dispatch' } },
            }] } });
            const row = [...f.state.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation');
            expect(row?.value.terminal).toBe(true);
            expect(row?.value.payload).toMatchObject({ result: { kind: 'fanout', results: [{
                result: { ok: false, cause: { phase: 'dispatch' } },
            }] } });
            expect(JSON.stringify(row?.value.payload)).not.toContain('failureCause');
            expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), row?.value)).toBe(true);
            expect(SessionPullRequestConfiguredFixCustodySchema.parse(row?.value.payload)).toEqual(row?.value.payload);
            await expect(f.invoke()).resolves.toEqual(first);
            expect(f.execute.mock.calls.filter(([id]) => id === 'session.message.send')).toHaveLength(send === 'fanoutUnknownThenFailure' ? 2 : 1);
        } finally { await f.kit.dispose(); }
    });
    it('composes configured Triage Fix with registered Channels custody, attachments and the one host-start counter', async () => {
        const f = await configuredFixFixture({ head: TESTKIT_OBSERVED_REVISION.headSha, expectedHead: TESTKIT_OBSERVED_REVISION.headSha });
        const entryRef = testkitEntryRef({ collisionScope: 'acme/widgets', entryId: '12' });
        const locator = testkitLocator({ webUrl: 'https://github.com/acme/widgets/pull/12' });
        const sourceInstanceId = testkitConfiguredInstance().instance.sourceInstanceId;
        const session = { serverId: 'srv_example', sessionId: 'session-a' };
        const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
        const checkout = { serverId: session.serverId, workspaceId: 'workspace-1', machineId: 'machine-example', rootPath: '/repo' };
        const effects: string[] = [];
        const delegated: JsonValue[] = [];
        const host = {
            readSession: async () => ({ ...session, acceptedWorkspace: { checkout, repository } }),
            executeAction: async (id: string | { pluginId: string; localId: string }, value: JsonValue, options?: { sessionAddress?: unknown }) => {
                const actionId = testkitTriageActionId(id);
                if (actionId === 'actions/read-v1') return { v: 1, availability: 'parsed', revision: '1', actions: [{
                    actionId: 'fix', label: 'Fix', enabled: true, appliesTo: ['pullRequest'], profileId: null, workspaceMode: 'pull_request',
                    target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Fix this PR.', delivery: 'send' },
                }] };
                if (typeof id !== 'string' && id.pluginId === 'happier.channels') {
                    expect(id).toEqual({ pluginId: 'happier.channels', localId: 'session-pull-request-watch-v1' });
                    expect(options?.sessionAddress).toEqual(session);
                    if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'deliverConfiguredFix') delegated.push(value);
                    return f.invoke(value);
                }
                effects.push(actionId);
                if (actionId === TRIAGE_VERIFY_EXISTING_REVIEW_WORKSPACE_ACTION_LOCAL_ID_V1) return { kind: 'verified', checkout };
                if (actionId === 'sessions/link-entry-v1') return { v: 1, status: 'linked' };
                throw new Error(`Unexpected Triage host effect ${id}`);
            },
        } as unknown as Parameters<typeof runTriageConfiguredHandoffV1>[0]; // Only source/Session RPC transports; both plugin owners stay real.
        const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: 1 } as const;
        try {
            const result = await runTriageConfiguredHandoffV1(host, { task: 'fix', configuredActionId: 'fix',
                context: { kind: 'entry', entry: { entryRef, sourceInstanceId } }, evidence: [{ kind: 'entry', entry: { entryRef, sourceInstanceId } }],
                sessionChoice: { kind: 'existing', session: session.sessionId }, agentChoice: { kind: 'configured' }, delivery: 'send',
            }, { session, signal: new AbortController().signal, mintCreationKey: () => 'triage-configured-press', entries: [{
                key: 'pr-12', entryRef, display: { locator, scopeLabel: 'acme/widgets' }, presentation: { label: 'PR 12' }, repository,
                sourceInstance: { source: entryRef.source, sourceInstanceId }, workflowSubject: 'pullRequest',
                reviewWorkspace: { operation: { point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol },
                    contributor: { pluginId: entryRef.source.pluginId, contributionId: entryRef.source.localId, occurrenceId: 'source-1',
                        sourceCustody: { kind: 'development', registeredRootId: 'source-root' } }, role: 'prepareReviewWorkspace',
                    action: { pluginId: entryRef.source.pluginId, localId: 'prepare' } },
                    preparation: { instance: testkitConfiguredInstance(), entryRef, lastKnownLocator: locator,
                        observed: { ...TESTKIT_OBSERVED_REVISION, observedAtMs: 1 } } },
            }] });
            expect(result).toMatchObject({ handoff: { kind: 'sendResult', session, result: { status: 'accepted', localId: 'configured-input' } } });
            expect(effects).not.toContain('session.message.send');
            const sends = f.execute.mock.calls.filter(([id]) => id === 'session.message.send');
            expect(sends).toHaveLength(1);
            expect(sends[0]?.[1]).toMatchObject({ attachments: [{ attachmentLocalId: 'entry', value: {
                value: { entryRef, sourceInstance: { sourceInstanceId } } } }] });
            expect(await f.progress()).toMatchObject({ roundsStarted: 0, activeRound: { started: false } });
            f.start();
            await f.invoke(delegated[0]);
            await f.invoke(delegated[0]);
            expect(await f.progress()).toMatchObject({ roundsStarted: 1, activeRound: { started: true } });
            expect(f.execute.mock.calls.filter(([id]) => id === 'session.message.send')).toHaveLength(1);
        } finally { await f.kit.dispose(); }
    });
    it('delivers configured Fix through the registered Account Action and charges only its exact host start witness once', async () => {
        const f = await configuredFixFixture();
        const query = vi.spyOn(f.state, 'query');
        try {
            await expect(f.invoke()).resolves.toMatchObject({ kind: 'configuredFixResult', result: { status: 'accepted', localId: 'configured-input' } });
            expect(f.execute.mock.calls.find(([id]) => id === 'session.message.send')?.[1])
                .toMatchObject({ message: expect.stringContaining('A check failed.'), forgeEvidence: f.request.delivery.forgeEvidence,
                    attachments: f.request.delivery.attachments });
            expect(await f.progress()).toMatchObject({ roundsStarted: 0, activeRound: { localId: 'configured-input', started: false } });
            const schema = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
            for (const row of f.state.rows.values()) {
                expect(isValidPluginJsonSchemaValue(schema, row.value)).toBe(true);
                if (row.value['record-kind'] === 'ingress-obligation') {
                    for (const prepare of [prepareConversationIngressObligationForBindingDeletion, prepareConversationIngressObligationForConnectionDeletion]) {
                        expect(prepare({ ...row, now: 20 })).toMatchObject({ kind: 'terminal', connectionId: 'connection-1', bindingId: 'pr-1' });
                    }
                }
            }
            f.start('another-turn');
            await f.invoke();
            expect(await f.progress()).toMatchObject({ roundsStarted: 0 });
            f.start();
            await expect(f.invoke(f.request, 'agent')).resolves.toMatchObject({ kind: 'configuredFixResult', result: { status: 'accepted' } });
            expect(await f.progress()).toMatchObject({ roundsStarted: 1, activeRound: { started: true } });
            await f.invoke();
            expect(await f.progress()).toMatchObject({ roundsStarted: 1 });
            expect(f.execute.mock.calls.filter(([id]) => id === 'session.message.send')).toHaveLength(1);
            expect(f.execute.mock.calls.filter(([id]) => id === 'scm.pullRequest.get')).toHaveLength(1);
            expect(query).not.toHaveBeenCalled();
            await expect(f.invoke({ ...f.request, expectedRevision: (await f.state.get('pr-1'))!.revision,
                delivery: { ...f.request.delivery, idempotencyKey: 'configured-fix-2' } })).resolves.toEqual({ kind: 'configuredFixHeld', reason: 'outstanding' });
            f.complete();
            await f.invoke();
            expect((await f.progress())?.activeRound).toBeUndefined();
            await f.invoke();
            expect(await f.progress()).toMatchObject({ roundsStarted: 1 });
            expect(f.execute.mock.calls.filter(([id]) => id === 'session.message.send')).toHaveLength(1);
        } finally { await f.kit.dispose(); }
    });
    it.each([
        { options: { head: 'new-head' }, code: 'channels_pr_watch_stale_head' },
        { options: { closed: true }, code: 'channels_pr_watch_not_fixing' },
    ])('refuses configured Fix with $code before sending', async ({ options, code }) => {
        const f = await configuredFixFixture(options);
        try {
            await expect(f.invoke()).rejects.toMatchObject({ code });
            expect(f.execute.mock.calls.filter(([id]) => id === 'session.message.send')).toHaveLength(0);
            expect(await f.progress()).toMatchObject({ roundsStarted: 0 });
        } finally { await f.kit.dispose(); }
    });
    it('refuses a missing binding and preserves the shared exhausted allowance', async () => {
        const f = await configuredFixFixture({ exhausted: true });
        try {
            await expect(f.invoke({ ...f.request, bindingId: 'missing' })).rejects.toMatchObject({ code: 'channels_pr_watch_binding_unavailable' });
            await expect(f.invoke()).resolves.toEqual({ kind: 'configuredFixHeld', reason: 'exhausted' });
            expect(f.execute.mock.calls.filter(([id]) => id === 'session.message.send')).toHaveLength(0);
            expect(await f.progress()).toEqual({ roundsStarted: 3, continuationRounds: 0 });
        } finally { await f.kit.dispose(); }
    });
    it('reserves one configured Fix for concurrent presses and rejects changed replay content', async () => {
        const f = await configuredFixFixture();
        try {
            const outcomes = await Promise.allSettled([f.invoke(), f.invoke()]);
            expect(outcomes.some(result => result.status === 'fulfilled')).toBe(true);
            expect(f.execute.mock.calls.filter(([id]) => id === 'session.message.send')).toHaveLength(1);
            await expect(f.invoke({ ...f.request, delivery: { ...f.request.delivery, text: 'Different task' } }))
                .rejects.toMatchObject({ code: 'channels_pr_watch_delivery_conflict' });
            expect(await f.progress()).toMatchObject({ roundsStarted: 0 });
        } finally { await f.kit.dispose(); }
    });
    it('retains uncertain delivery for the same host idempotency key and releases a known rejection without charging', async () => {
        const f = await configuredFixFixture({ send: 'unknownThenAccepted' });
        const rejected = await configuredFixFixture({ send: 'rejected' });
        try {
            await expect(f.invoke()).resolves.toEqual({ kind: 'configuredFixUncertain' });
            expect(await f.progress()).toMatchObject({ roundsStarted: 0, activeRound: { started: false } });
            const pending = [...f.state.rows.values()].find(row => row.value['record-kind'] === 'ingress-obligation');
            if (!pending) throw new Error('Missing configured input custody');
            expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), pending.value)).toBe(true);
            expect(prepareConversationIngressObligationForBindingDeletion({ ...pending, now: 20 }))
                .toMatchObject({ kind: 'terminal', bindingId: 'pr-1' });
            await expect(f.invoke()).resolves.toMatchObject({ kind: 'configuredFixResult', result: { status: 'accepted' } });
            const sends = f.execute.mock.calls.filter(([id]) => id === 'session.message.send');
            expect(sends).toHaveLength(2);
            expect(sends[0]?.[1]).toEqual(sends[1]?.[1]);
            await expect(rejected.invoke()).resolves.toMatchObject({ kind: 'configuredFixResult', result: { status: 'rejected' } });
            expect(await rejected.progress()).toMatchObject({ roundsStarted: 0 });
            expect((await rejected.progress())?.activeRound).toBeUndefined();
        } finally { await f.kit.dispose(); await rejected.kit.dispose(); }
    });
    it('metadata reads used before compose neither reserve nor charge a fixing round', async () => {
        const f = await configuredFixFixture();
        try {
            await f.invoke({ kind: 'get', sessionId: 'session-a' });
            expect(await f.progress()).toEqual({ roundsStarted: 0, continuationRounds: 0 });
            expect(f.execute.mock.calls.filter(([id]) => id === 'session.message.send')).toHaveLength(0);
        } finally { await f.kit.dispose(); }
    });
    it('uses the canonical PR link and native head without requiring duplicate endpoint metadata', async () => {
        const f = await configuredFixFixture({ endpointMetadata: false });
        try {
            await expect(f.invoke()).resolves.toMatchObject({ kind: 'configuredFixResult', result: { status: 'accepted' } });
        } finally { await f.kit.dispose(); }
    });
    it('preserves the host typed failure and retained input custody without charging a round', async () => {
        const f = await configuredFixFixture({ send: 'typedError' });
        try {
            await expect(f.invoke()).rejects.toMatchObject({ code: 'machine_admission_transport_unavailable', retryable: true });
            expect(await f.progress()).toMatchObject({ roundsStarted: 0, activeRound: { started: false } });
        } finally { await f.kit.dispose(); }
    });
    it.each([2, 3, 5, null])('continues an exhausted fixing sequence once through the current binding CAS and effective limit %s', async limit => {
        const state = new MemoryCollection<Record<string, JsonValue>>();
        const value = sessionPullRequestBindingFixture('pr-1', 'session-a', 12);
        const progress = { roundsStarted: 3, continuationRounds: 0, cause: { kind: 'feedback' }, sourceHeadSha: 'head-3',
            activeRound: { obligationId: 'accepted-original', localId: 'input-original', started: true } } as const;
        const target = { ...value.payload.target, pullRequestWatch: {
            policy: { mode: 'address', archiveAfterMerge: false }, progress,
        } } as const;
        await state.put(withChannelStateSessionIdentity({ ...value, payload: { ...value.payload, enabled: true, target } }, target), { expectedRevision: 'absent' });
        await state.put(createCurrentConversationConnectionFixture({ connectionId: 'connection-1', authority: {
            providerPluginId: 'happier.channel.example', providerContributionSelection: { contributionId: 'example' },
            providerSetupInput: {}, credentialRef: null, transportOrigin: { serverIdentityId: 'srv_example', machineId: 'machine-example' },
            providerConnectionKey: 'example:connection-1', providerConfig: {}, integrationPrincipal: { id: 'bot' },
            routingIdentityKey: 'r'.repeat(43), authorityEpoch: 1,
        } }), { expectedRevision: 'absent' });
        const services = {
            storage: { account: { collection: () => state } } as unknown as PluginServices['storage'],
            actions: { execute: vi.fn(async () => ({ coverage: 'complete', addresses: [{ sessionId: 'session-a', serverId: 'srv_example' }], error: null })) } as unknown as PluginServices['actions'],
            settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' as const }, revision: 'settings-1',
                values: { 'pr-watch-fix-attempt-limit': limit } }), get: async () => null, describe: () => [], watch: () => ({ dispose() {} }),
                set: async () => { throw new Error('Read only'); }, reset: async () => { throw new Error('Read only'); } }) },
        };
        const kit = await createPluginTestkit({ manifest: CHANNELS_PLUGIN.manifest,
            module: { activate: CHANNELS_PLUGIN.activate, activateAccount }, services });
        const invoke = (request: JsonValue) => kit.invokeAction('session-pull-request-watch-v1', request, { surface: 'ui' });
        try {
        const request = { kind: 'retryFix', sessionId: 'session-a', bindingId: 'pr-1', expectedRevision: 1 } as const;
        const outcomes = await Promise.allSettled([invoke(request), invoke(request)]);
        const row = await state.get('pr-1');
        if (!row) throw new Error('Missing retained binding');
        const { binding } = readConversationBindingUpdateRow({ row, bindingId: 'pr-1' });
        if (binding.target.kind !== 'session') throw new Error('Expected Session binding');
        if (limit === null || limit > 3) {
            expect(outcomes.every(outcome => outcome.status === 'rejected')).toBe(true);
            for (const outcome of outcomes) {
                if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: 'channels_pr_watch_not_exhausted' });
            }
            expect(row.revision).toBe(1);
            expect(binding.target.pullRequestWatch?.progress).toEqual(progress);
        } else {
            expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
            expect(binding.target.pullRequestWatch?.progress).toEqual({ ...progress, continuationRounds: limit });
            expect(binding.authorityEpoch).toBe(1);
            await expect(invoke({ ...request, expectedRevision: row.revision }))
                .rejects.toMatchObject({ code: 'channels_pr_watch_not_exhausted' });
            // Stop remains ordinary configuration, without cancelling or granting the accepted round.
            await invoke({ kind: 'configure', sessionId: 'session-a', bindingId: 'pr-1',
                expectedRevision: row.revision, policy: { ...target.pullRequestWatch.policy, mode: 'off' } });
            const stopped = await state.get('pr-1');
            if (!stopped) throw new Error('Missing stopped binding');
            await expect(invoke({ ...request, expectedRevision: stopped.revision }))
                .rejects.toMatchObject({ code: 'channels_pr_watch_not_fixing' });
        }
        } finally { await kit.dispose(); }
    });
    it('invalidates once for selected binding/latest changes and only the effective limit setting', async () => {
        const state = new MemoryCollection();
        const value = sessionPullRequestBindingFixture('pr-1', 'session-a', 12);
        await state.put(withChannelStateSessionIdentity(value, value.payload.target), { expectedRevision: 'absent' });
        const settingsListeners = new Set<(change: SettingsChange) => void>();
        const controller = new AbortController();
        const invalidate = vi.fn();
        const watch = vi.spyOn(state, 'watch');
        const observation = await observeSessionPullRequestWatchAction({ kind: 'get', sessionId: 'session-a' }, invalidate, {
            invokedAtMs: 1, signal: controller.signal, services: {
                targetedContributions: channelsProviderDescriptorFixture(GITHUB_PLUGIN.manifest),
                storage: { account: { collection: () => state } } as unknown as PluginServices['storage'],
                actions: { execute: vi.fn() } as unknown as PluginServices['actions'],
                settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' as const }, revision: '1', values: {} }),
                    get: async () => null, describe: () => [], watch: listener => {
                        settingsListeners.add(listener); return { dispose: () => { settingsListeners.delete(listener); } };
                    } }) },
            },
        });
        await vi.waitFor(() => expect(watch).toHaveBeenCalledWith({ index: 'by-connection-binding-v2',
            prefix: ['connection-1', null, 'connection'], order: 'asc' }, expect.any(Function)));
        invalidate.mockClear();
        const foreign = sessionPullRequestBindingFixture('foreign-pr', 'foreign-session', 13);
        await state.put(withChannelStateSessionIdentity(foreign, foreign.payload.target), { expectedRevision: 'absent' });
        expect(invalidate).not.toHaveBeenCalled();
        await state.put(withChannelStateSessionIdentity({ ...value, payload: { ...value.payload, enabled: true } }, value.payload.target), { expectedRevision: 1 });
        expect(invalidate).toHaveBeenCalledOnce();
        invalidate.mockClear();
        await state.put({ id: 'latest', 'record-kind': 'ingress-obligation', 'session-id': 'session-a', 'binding-id': 'pr-1' }, { expectedRevision: 'absent' });
        expect(invalidate).toHaveBeenCalledOnce();
        invalidate.mockClear();
        for (const listener of settingsListeners) listener({ scope: { kind: 'account' }, revision: '2', changedIds: ['other'], values: {} });
        expect(invalidate).not.toHaveBeenCalled();
        for (const listener of settingsListeners) listener({ scope: { kind: 'account' }, revision: '3', changedIds: ['pr-watch-fix-attempt-limit'], values: {} });
        expect(invalidate).toHaveBeenCalledOnce();
        controller.abort();
        expect(settingsListeners.size).toBe(0);
        observation.dispose();
    });
    it('projects retained connection credential loss independently from native PR status', () => {
        const value = sessionPullRequestBindingFixture('pr-1', 'session-a', 12);
        for (const stopWhenMerged of [true, false]) {
            const policy = { mode: 'notify', archiveAfterMerge: true } as const;
            const retained = { ...value, payload: { ...value.payload, enabled: true, target: { ...value.payload.target,
                pullRequestWatch: { policy: { ...policy, stopWhenMerged } } } } };
            const metadata = assembleSessionPullRequestWatchMetadata({ sessionId: 'session-a', provider: GITHUB_CHANNEL_PULL_REQUESTS,
                rows: [{ rowId: value.id, revision: 1, value: retained }],
                defaults: { defaultMode: 'notify', fixAttemptLimit: 3, archiveAfterMerge: false },
                connectionReasons: new Map([['connection-1', 'credentials']]),
            });
            expect(metadata.bindings[0]?.watch.reason).toBe('credentials');
            expect(metadata.bindings[0]?.watch.policy).toEqual(policy);
        }
    });
    it('pages complete distinct Session groups without reading unrelated chat bodies or repeating full groups', async () => {
        const state = new MemoryCollection();
        // An earlier physical page of tombstones must not become the Session's
        // representative and suppress its later live, disabled/off bindings.
        for (let index = 0; index < PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1; index += 1) {
            const value = sessionPullRequestBindingFixture(`deleted-${String(index).padStart(6, '0')}`, 'session-a', index + 1);
            await state.put(withChannelStateSessionIdentity({ ...value,
                payload: { ...value.payload, deletionState: 'finalizingDelete' } }, value.payload.target), { expectedRevision: 'absent' });
        }
        for (let index = 0; index <= PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1; index += 1) {
            const value = sessionPullRequestBindingFixture(`pr-${String(index).padStart(6, '0')}`, 'session-a', index + 1);
            await state.put(withChannelStateSessionIdentity(value, value.payload.target), { expectedRevision: 'absent' });
        }
        const last = sessionPullRequestBindingFixture('last-pr', 'session-b', 10_000);
        await state.put(withChannelStateSessionIdentity(last, last.payload.target), { expectedRevision: 'absent' });
        for (let index = 0; index < 1_000; index += 1) {
            const value = sessionPullRequestBindingFixture(`chat-${index}`, 'session-a', index + 1);
            if (value.payload.target.kind !== 'session') throw new Error('Expected a Session target');
            const { pullRequestLink: _link, ...target } = value.payload.target;
            await state.put(withChannelStateSessionIdentity({ ...value, payload: { ...value.payload, target } }, target), { expectedRevision: 'absent' });
        }
        const query = vi.spyOn(state, 'query');
        const execute = vi.fn(async (id: string, input: unknown) => {
            if (id !== 'session.targets.resolve' || input === null || typeof input !== 'object' || !('target' in input)) {
                throw new Error('Watch metadata only resolves exact Session addresses');
            }
            return { coverage: 'complete', addresses: [{ sessionId: input.target, serverId: 'srv_plugin_testkit' }], error: null };
        });
        const kit = await createPluginTestkit({ manifest: CHANNELS_PLUGIN.manifest, module: CHANNELS_PLUGIN,
            services: {
                targetedContributions: channelsProviderDescriptorFixture(GITHUB_PLUGIN.manifest),
                storage: { account: { collection: (definition: { id: string }) => {
                    if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Collection');
                    return state;
                } } } as unknown as PluginServices['storage'],
                settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' as const }, revision: '1', values: {} }),
                    get: async () => null, describe: () => [], watch: () => ({ dispose() {} }),
                    set: async () => { throw new Error('Read only'); }, reset: async () => { throw new Error('Read only'); } }) },
                actions: { execute } as unknown as PluginServices['actions'],
            },
        });
        try {
            const sessions = [];
            let cursor: string | null = null;
            do {
                const request: Record<string, JsonValue> = { kind: 'list' };
                if (cursor) request.cursor = cursor;
                const result: ReturnType<typeof SessionPullRequestWatchListResultV1Schema.parse> = SessionPullRequestWatchListResultV1Schema.parse(await kit.invokeAction('session-pull-request-watch-v1',
                    request, { surface: 'ui' }));
                if (result.kind !== 'ready') throw new Error('Expected portable Account metadata');
                sessions.push(...result.sessions);
                cursor = result.nextCursor;
            } while (cursor !== null);
            expect(sessions.map(session => session.session.sessionId)).toEqual(['session-a', 'session-b']);
            expect(sessions.map(session => session.bindings.length)).toEqual([PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 + 1, 1]);
            const pages = await Promise.all(query.mock.results.map(result => result.value));
            expect(pages.flatMap(page => page.rows).some(row => row.rowId.startsWith('chat-'))).toBe(false);
            const bindingReads = query.mock.calls.filter(([input]) => input.index === CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1
                && input.prefix?.[2] !== undefined && input.limit === PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1);
            // The complete live PR group spans two pages and is loaded once;
            // tombstones and unrelated chat bodies never enter that reader.
            expect(bindingReads.filter(([input]) => input.prefix?.[2] === 'session-a')).toHaveLength(2);
            expect(bindingReads.every(([input]) => input.prefix?.[2] === 'session-a' || input.prefix?.[2] === 'session-b')).toBe(true);
            expect(query.mock.calls.some(([input]) => input.index === CHANNEL_STATE_INDEX_ID.byKind)).toBe(false);
        } finally { await kit.dispose(); }
    });
});
