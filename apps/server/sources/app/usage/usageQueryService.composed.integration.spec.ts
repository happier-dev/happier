import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, buildConnectedServiceCredentialRecord,
    normalizeUsageQuery, resolveUsagePageAggregation,
    UsageAnalyticsQueryRequestSchema, UsageEventIngestRequestSchema, usageQueryToAnalyticsRequest } from '@happier-dev/protocol';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildPublicProfileSnapshot } from '@happier-dev/protocol/account/publicProfileSnapshot';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { buildClaudeAssistantUsageObservation } from '../../../../../packages/plugins/claude/src/agent/usage/buildAssistantObservation';
import { buildClaudeSdkResultUsageObservation } from '../../../../../packages/plugins/claude/src/agent/usage/buildSdkResultObservation';
import { buildUsageEventIngestRequest } from '../../../../cli/src/usage/buildUsageEventIngestRequest';
import { queryUsageAnalytics } from './usageQueryService';
import { captureUsageAnalyticsBatch, projectUsageAnalyticsBatch } from './query/readUsageAnalyticsBatch';
import { recordUsageEvent } from './usageWriteService';
import { readUsageAccountingMetadata } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { deriveNativeUsageAccountingIdentity } from '../../../../cli/src/usage/collector/nativeUsageAccountingIdentity';
import { withCodexNativeAttachFixture } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { createNativeAgentSessionOperations } from '../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { withAgentDaemonMaterializedBootstrap } from '../../../../cli/src/daemon/connectedServices/materialize/agentDaemonBootstrap.testkit';
import { createSdkExecFixture, createEventsFixture, createPluginContextFixture,
    createSessionHooksFixture, createTerminalHostFixture,
} from '../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { createClaudeAgentSdkTurnOperations } from '../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { resolveClaudeJsonlSessionFile } from '../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/files';
import { readOrCreateDeviceLocalSecretStorage } from '../../../../cli/src/daemon/deviceLocalSecretStorage';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR, resolveExplicitSpawnScopedEnvironmentFromProcessEnv } from '../../../../cli/src/daemon/spawn/spawnExplicitEnvKeysMarker';
import { reconcileAgentSessionScopedEnvironment } from '../../../../cli/src/session/runtime/control/sessionControlEnvironment';

// Cross-package composition belongs in the existing composed integration lane,
// separate from the server-only compiler project and aggregation fixtures.
describe('native usage producer → ingest → query', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-composed-', initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.simpleCache.deleteMany({ where: { key: 'usage:model-price-catalog:v1' } }),
            () => db.usageEvent.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it.each([
        { scenario: 'Muse child counters', agentId: 'muse', scope: 'session_cumulative', inputIncludesCache: true, outputIncludesReasoning: true,
            tokens: { input: 39_314, output: 19, reasoning: 7, cacheRead: 0, cacheWrite: 0, total: null }, measured: 39_333 },
        { scenario: 'Muse child counters with cache', agentId: 'muse', scope: 'session_cumulative', inputIncludesCache: true, outputIncludesReasoning: true,
            tokens: { input: 39_314, output: 19, reasoning: 7, cacheRead: 10, cacheWrite: 2, total: null }, measured: 39_333 },
        { scenario: 'undeclared Muse child counters', agentId: 'muse', scope: 'session_cumulative',
            inputIncludesCache: undefined, outputIncludesReasoning: undefined,
            tokens: { input: 39_314, output: 19, reasoning: 7, cacheRead: 0, cacheWrite: 0, total: null }, measured: 39_340 },
        { scenario: 'Claude disjoint counters', agentId: 'claude', scope: 'turn_delta', inputIncludesCache: false, outputIncludesReasoning: false,
            tokens: { input: 100, output: 19, reasoning: null, cacheRead: 10, cacheWrite: 2, total: null }, measured: 131 },
    ] as const)('projects declared token overlaps for $agentId across the accounting reads ($scenario)', async test => {
        const account = await db.account.create({ data: { publicKey: `parts-overlap-${test.agentId}` } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: 'parts-overlap', encryptionMode: 'plain', metadata: '{}',
        } });
        const source = `${test.agentId}-runtime-parts`;
        const observedAt = Date.UTC(2026, 10, 22, 0, 1);
        const input = buildUsageEventIngestRequest({ sessionId: session.id, observedAt, externalKey: source,
            observation: { provider: test.agentId, source, key: source, scope: test.scope, modelId: null,
                tokens: test.tokens, cost: null, contextUsedTokens: null, contextWindowTokens: null },
            metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true,
                inputIncludesCache: test.inputIncludesCache, outputIncludesReasoning: test.outputIncludesReasoning } },
        });
        if (!input) throw new Error('Usage fixture did not build an ingest request');
        const recorded = await recordUsageEvent(account.id, input);
        expect(recorded).toMatchObject({ ok: true });
        const query = UsageAnalyticsQueryRequestSchema.parse({ includeActivity: true, includeSeries: false,
            granularity: 'day', timeZoneOffsetMinutes: 0, dateRange: { startMs: observedAt - 60_000, endMs: observedAt + 60_000 } });
        const scalar = await queryUsageAnalytics(account.id, query);
        expect(scalar.totals.tokens).toEqual({ ...test.tokens, measured: { total: test.measured, fromParts: true } });
        const batch = await captureUsageAnalyticsBatch(account.id, [query]);
        const rich = (await projectUsageAnalyticsBatch(batch, [query], true, false)).results[0];
        expect(rich).toMatchObject({ value: { totals: scalar.totals, coverage: scalar.coverage } });
        const withOverlap = test.inputIncludesCache === true || test.outputIncludesReasoning === true;
        expect(rich && "value" in rich && rich.value.contributions?.map(row => row.tokens)).toEqual([withOverlap
            ? { ...test.tokens, measured: { total: test.measured, fromParts: true } } : test.tokens]);
        const demand = { contributionQueries: [], sessionQueries: [query] };
        // Warm responses have crossed the JSON cache boundary.
        const expected = JSON.parse(JSON.stringify({ totals: scalar.totals, coverage: scalar.coverage }));
        for (const phase of ['cold', 'warm']) {
            const compact = await captureUsageAnalyticsBatch(account.id, [query], undefined, demand);
            expect(compact.activitySummary, phase).toBeDefined();
            const projected = await projectUsageAnalyticsBatch(compact, [query], false, true, undefined, demand);
            expect(JSON.parse(JSON.stringify(projected.results[0])), phase).toMatchObject({ value: expected });
        }
    });

    it.each([
        { planType: 'plus', delivery: 'concurrent', binding: 'bound' },
        { planType: 'team', delivery: 'concurrent', binding: 'bound' },
        { planType: 'future-plan', delivery: 'concurrent', binding: 'bound' },
        { planType: 'plus', delivery: 'reversed-same-clock', binding: 'bound' },
        { planType: 'plus', delivery: 'concurrent', binding: 'missing-session-ref' },
        { planType: 'plus', delivery: 'concurrent', binding: 'unbound' },
        { planType: 'plus', delivery: 'concurrent', binding: 'mismatched-native-account' },
        { planType: 'plus', delivery: 'concurrent', binding: 'caller-controls' },
        { planType: 'plus', delivery: 'concurrent', binding: 'daemon-without-bootstrap' },
    ])('reconciles exact Codex $planType responses through host admission and public preparation ($delivery, $binding)', async ({ planType, delivery, binding }) => {
        const account = await db.account.create({ data: { publicKey: `pk-codex-exact-${planType}` } });
        const session = await db.session.create({ data: { id: 'actual-happier-session', accountId: account.id,
            tag: `codex-exact-${planType}`, encryptionMode: 'plain', metadata: '{}' } });
        const record = buildConnectedServiceCredentialRecord({ now: 10, serviceId: 'openai-codex', profileId: 'account-A',
            kind: 'oauth', expiresAt: null, oauth: { accessToken: 'synthetic-startup-A', refreshToken: 'synthetic-refresh',
                idToken: null, scope: null, tokenType: null, providerAccountId: 'provider-account-A', providerEmail: null } });
        await withAgentDaemonMaterializedBootstrap({ agentId: 'codex', record, sessionId: session.id, bound: binding !== 'unbound', run: async startup => {
        const connectedAccounts = binding === 'missing-session-ref' || binding === 'daemon-without-bootstrap'
            ? [] : startup.bootstrap.launch?.sessionConnectedAccounts ?? [];
        // The real daemon marks sanitized materializer output as explicit child
        // keys. Its ordinary CLI reader then reconciles that scope before host
        // construction; feeding materializer.env directly skipped this loss.
        const scoped = resolveExplicitSpawnScopedEnvironmentFromProcessEnv({ ...startup.environment,
            HAPPIER_HOME_DIR: 'caller-system-control-must-not-cross',
            [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: JSON.stringify([...Object.keys(startup.environment), 'HAPPIER_HOME_DIR']),
        });
        const launchEnvironment = reconcileAgentSessionScopedEnvironment({ environment: scoped?.env ?? {},
            trustedDaemonTransport: binding !== 'caller-controls' && binding !== 'daemon-without-bootstrap',
        });
        expect(launchEnvironment.CODEX_HOME).toBe(startup.environment.CODEX_HOME);
        expect(launchEnvironment).not.toHaveProperty('HAPPIER_HOME_DIR');
        if (binding === 'caller-controls' || binding === 'daemon-without-bootstrap') {
            expect(launchEnvironment).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON');
            expect(launchEnvironment).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT');
            expect(launchEnvironment).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON');
        }
        await withCodexNativeAttachFixture(async fixture => {
            const native = await fixture.openConfiguredSession();
            const writes: Array<ReturnType<typeof recordUsageEvent>> = [];
            const delayed: Array<NonNullable<ReturnType<typeof buildUsageEventIngestRequest>>> = [];
            let published = 0;
            let restoreSourceClock: (() => void) | undefined;
            const operations = createNativeAgentSessionOperations(native, session.id, undefined, undefined, {
                provider: 'codex',
                publish(input) {
                    const request = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({ ...input, sessionId: session.id }));
                    if (delivery === 'reversed-same-clock') delayed.push(request);
                    else writes.push(recordUsageEvent(account.id, request));
                    published++;
                },
            }, undefined, undefined, {
                // The host invocation services are the external process boundary;
                // native JSON-RPC, host event admission, accounting and DB stay real.
                context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
                cwd: fixture.directory, connectedAccounts, capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
            });
            const unsubscribe = operations.subscribeRuntimeEvents(() => undefined);
            try {
                await operations.sendTurnPrompt('two actual native response notifications', { turnId: 'host-turn', localId: 'input-1' });
                if (delivery === 'reversed-same-clock') {
                    // The provider clock and HTTP delivery are external boundaries.
                    // Hold one real source instant, then deliver the snapshot and
                    // duplicate ahead of the original response to expose the race.
                    const sourceClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
                    restoreSourceClock = () => sourceClock.mockRestore();
                }
                const usage = { totalTokens: 3, inputTokens: 2, outputTokens: 1 };
                for (const responseId of ['response-1', 'response-1', 'response-2']) {
                    fixture.emitNotification('rawResponse/completed', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
                        responseId, usage, usageMetadata: null, untrustedText: 'must-never-reach-usage' });
                }
                fixture.emitNotification('thread/tokenUsage/updated', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
                    tokenUsage: { total: { totalTokens: 1006, inputTokens: 1004, outputTokens: 2 }, last: usage, modelContextWindow: 200_000 } });
                await expect.poll(() => published).toBe(4);
                restoreSourceClock?.();
                restoreSourceClock = undefined;
                if (delivery === 'reversed-same-clock') {
                    expect(new Set(delayed.map(request => request.observedAt)).size).toBe(1);
                    expect(await recordUsageEvent(account.id, delayed[3]!)).toMatchObject({ ok: true });
                    for (const result of await Promise.all([delayed[1]!, delayed[2]!].map(request => recordUsageEvent(account.id, request)))) {
                        expect(result).toMatchObject({ ok: true });
                    }
                    expect(await recordUsageEvent(account.id, delayed[0]!)).toMatchObject({ ok: true });
                }
                for (const result of await Promise.all(writes)) expect(result).toMatchObject({ ok: true });
                const privateResult = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({ filters: { sessionIds: [session.id] } }));
                const storedRows = await db.usageEvent.findMany({ where: { accountId: account.id }, select: {
                    id: true, source: true, scope: true, externalKey: true, observedAt: true, createdAt: true, totalTokens: true,
                } });
                expect(privateResult.totals.tokens.total, JSON.stringify({ storedRows, contributions: privateResult.contributions?.map(row => ({
                    id: row.id, source: row.source, turnId: row.turnId, tokens: row.tokens.total, observedAt: row.observedAtMs,
                })) })).toBe(1006);
                expect(privateResult.contributions?.filter(row => row.turnId === 'host-turn')).toHaveLength(2);
                expect(privateResult.contributions?.filter(row => row.source === 'codex-app-server-response-usage')
                    .every(row => row.providerAttribution === (binding === 'bound' ? 'known' : 'unknown')
                        && row.providerSource === (binding === 'bound' ? 'native' : 'unknown'))).toBe(true);
                expect(new Set(privateResult.contributions?.map(row => row.source))).toEqual(new Set([
                    'codex-app-server-response-usage', 'codex-app-server-token-usage',
                ]));
                const exactOnly = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({
                    filters: { sessionIds: [session.id], sources: ['codex-app-server-response-usage'] },
                }));
                expect(exactOnly.totals.tokens.total).toBe(6);
                expect(JSON.stringify(privateResult)).not.toContain('must-never-reach-usage');
                // This journey compares populations over every written source
                // instant; wall-clock progress is not its selection contract.
                const sourceTimes = storedRows.map(row => row.observedAt.getTime());
                const endMs = Math.max(...sourceTimes) + 1;
                const query = normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs: Math.min(...sourceTimes), endMs },
                    session: [session.id], includeActivity: true });
                const publicResult = await queryUsageAnalytics(account.id, usageQueryToAnalyticsRequest(query, endMs));
                // Unknown native ownership and cumulative residuals count. Only
                // the exact requests with witnessed workspace scope are removed.
                const expectedPublicTokens = planType === 'team' && binding === 'bound' ? 1000 : 1006;
                expect(publicResult.totals.tokens.total, JSON.stringify({ endMs, storedRows,
                    contributions: publicResult.contributions })).toBe(expectedPublicTokens);
                if (binding === 'bound' && planType !== 'team') {
                    expect(publicResult.contributions).toHaveLength(3);
                    expect(publicResult.contributions?.filter(row => row.turnId === 'host-turn')
                        .every(row => row.providerAttribution === 'known')).toBe(true);
                    expect(publicResult.coverage?.sources.some(source => source.source === 'codex-app-server-response-usage'
                        && source.path === 'runtime' && source.status === 'partial' && typeof source.asOfMs === 'number')).toBe(true);
                    const queryResult = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available',
                        value: publicResult }] }, bundledUsageModelPriceCatalog).results[0]!;
                    expect(buildPublicProfileSnapshot({ queryResult, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, nowMs: endMs }))
                        .toMatchObject({ kind: 'ready', snapshot: { facts: { tokens: expectedPublicTokens } } });
                }
            } finally {
                restoreSourceClock?.();
                unsubscribe();
                await operations.resetOrDisposeRuntime();
            }
        }, { sessionConnectedAccounts: connectedAccounts,
            processEnv: launchEnvironment,
            accountRead: () => ({ account: { type: 'chatgpt', email: null, planType }, workspaceRouting: {
                chatgptAccountId: binding === 'mismatched-native-account' ? 'contradictory-provider-account' : 'provider-account-A',
            } }),
            runtimeAuthHost: { nativeHome: startup.nativeHome },
        });
        } });
    });

    it.each(['pro', 'max', 'team', 'enterprise', undefined, 'future-plan'])('excludes only witnessed workspace Claude subscription deltas (%s)', async subscriptionType => {
        const account = await db.account.create({ data: { publicKey: `pk-claude-scope-${subscriptionType}` } });
        const session = await db.session.create({ data: { accountId: account.id,
            tag: `claude-scope-${subscriptionType}`, encryptionMode: 'plain', metadata: '{}' } });
        const record = buildConnectedServiceCredentialRecord({ now: 10, serviceId: 'claude-subscription', profileId: 'claude-account',
            kind: 'oauth', expiresAt: null, oauth: { accessToken: 'synthetic-claude-access', refreshToken: 'synthetic-refresh',
                idToken: null, scope: 'user:inference user:sessions:claude_code', tokenType: null,
                providerAccountId: 'native-claude-account', providerEmail: null,
                raw: { claudeAiOauth: { ...(subscriptionType ? { subscriptionType } : {}) } } } });
        await withAgentDaemonMaterializedBootstrap({ agentId: 'claude', record, sessionId: session.id, bound: true, run: async startup => {
            expect(startup.bootstrap.launch?.sessionConnectedAccounts).toMatchObject([{
                usageAccountScope: subscriptionType === 'pro' || subscriptionType === 'max' ? 'personal'
                    : subscriptionType === 'team' || subscriptionType === 'enterprise' ? 'workspace' : 'unknown',
            }]);
            const exec = createSdkExecFixture();
            const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
                { exec: exec.service, sessionHooks: createSessionHooksFixture().service });
            const provider = createClaudeAgentSdkTurnOperations({ ctx, directory: startup.nativeHome.root,
                launchEnv: startup.environment, permissionMode: 'default', happierSessionId: session.id, initialModelId: 'claude-haiku-4-5' });
            const context = { session: { services: { activeInput: { bind: () => ({ dispose() {} }) },
                models: { bind: () => ({ dispose() {} }) } } } } as unknown as AgentSessionRuntimeContext;
            const native = createClaudeNativeSessionRuntimeFromOperations(provider,
                { kind: 'create', sessionId: session.id, cwd: startup.nativeHome.root }, context);
            const writes: Array<ReturnType<typeof recordUsageEvent>> = [];
            const operations = createNativeAgentSessionOperations(native, session.id, undefined, undefined, {
                provider: 'claude', publish(input) {
                    const request = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({ ...input, sessionId: session.id }));
                    if (request.scope === 'turn_delta') expect(request).toMatchObject({
                        turnId: 'claude-host-turn', attribution: { source: { kind: 'native',
                            ...(subscriptionType === 'pro' || subscriptionType === 'max' ? { accountScope: 'personal' } : {}),
                        } },
                    });
                    writes.push(recordUsageEvent(account.id, request));
                },
            }, undefined, undefined, { context, cwd: startup.nativeHome.root,
                connectedAccounts: startup.bootstrap.launch?.sessionConnectedAccounts ?? [],
                capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false } });
            const unsubscribe = operations.subscribeRuntimeEvents(() => undefined);
            try {
                await operations.sendTurnPrompt('reply ready', { localId: 'claude-input', turnId: 'claude-host-turn' });
                await exec.emit({ type: 'assistant', uuid: 'claude-record', session_id: 'native-claude-session',
                    message: { id: 'claude-inference', role: 'assistant', model: 'claude-haiku-4-5', content: [],
                        usage: { input_tokens: 10, output_tokens: 2 } } });
                await exec.emit({ type: 'result', subtype: 'success', session_id: 'native-claude-session', total_cost_usd: 0.01,
                    modelUsage: { 'claude-haiku-4-5': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
                await expect.poll(() => writes.length).toBe(2);
                for (const result of await Promise.all(writes)) expect(result).toMatchObject({ ok: true });
                const privateResult = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({ filters: { sessionIds: [session.id] } }));
                expect(privateResult.totals.tokens.total).toBe(12);
                const publicResult = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({
                    filters: { sessionIds: [session.id] }, population: 'public_eligible_personal' }));
                const eligible = subscriptionType !== 'team' && subscriptionType !== 'enterprise';
                expect(publicResult.totals.tokens.total).toBe(eligible ? 12 : 0);
                if (eligible) expect(publicResult.contributions).toEqual(expect.arrayContaining([expect.objectContaining({
                    turnId: 'claude-host-turn', providerAttribution: 'known', providerSource: 'native' })]));
            } finally { unsubscribe(); await operations.resetOrDisposeRuntime('runtime_recovery'); }
        } });
    });

    it.each([
        ['assistant', 'unbound-runtime-first'],
        ['result', 'unbound-runtime-first'],
        ['assistant', 'native-capture-first'],
        ['assistant', 'former-bound-key'],
        ['assistant', 'old-producer-without-declaration'],
    ] as const)('reconciles Claude SDK %s replay for %s', async (type, scenario) => {
        const account = await db.account.create({ data: { publicKey: `pk-claude-usage-replay-${type}-${scenario}` } });
        const machine = await db.machine.create({ data: { id: `claude-usage-replay-${type}-${scenario}`,
            accountId: account.id, metadata: 'ciphertext' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'claude-replay-source', encryptionMode: 'plain', metadata: '{}' } });
        const directory = await mkdtemp(join(tmpdir(), 'happier-claude-usage-replay-'));
        const nativeSessionId = 'claude-provider-session';
        const modelId = 'claude-haiku-4-5';
        const replayed = type === 'assistant' ? {
            type, uuid: 'claude-record', session_id: nativeSessionId,
            message: { id: 'claude-inference', role: 'assistant', model: modelId, content: [], usage: {
                input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            } },
        } : {
            type, subtype: 'success', uuid: 'claude-record', session_id: nativeSessionId,
            total_cost_usd: 0.01, modelUsage: { [modelId]: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        };
        const subject = { kind: 'native', machineId: machine.id, agent: { pluginId: 'happier.agent.claude', localId: 'claude' } };
        const query = () => queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({}));
        try {
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const witness = { storage, authority: { serverId: 'home', accountId: account.id, machineId: machine.id },
                agent: subject.agent, sourceKey: 'configured-root' };
            const exposeSource = async () => {
                const projects = join(directory, 'projects', 'project');
                await mkdir(projects, { recursive: true });
                await writeFile(join(projects, `${nativeSessionId}.jsonl`), `${JSON.stringify(replayed)}
`);
            };
            async function publishFromSdk(resume: boolean, oldProducer = false) {
                const exec = createSdkExecFixture();
                const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
                    { exec: exec.service, sessionHooks: createSessionHooksFixture().service });
                const provider = createClaudeAgentSdkTurnOperations({ ctx, directory, permissionMode: 'default',
                    launchEnv: { CLAUDE_CONFIG_DIR: directory }, happierSessionId: session.id, initialModelId: modelId,
                    ...(resume ? { initialProviderSessionId: nativeSessionId } : {}) });
                const context = { signal: new AbortController().signal, session: { services: { activeInput: { bind: () => ({ dispose() {} }) },
                    models: { bind: () => ({ dispose() {} }) } } } } as unknown as AgentSessionRuntimeContext;
                const native = createClaudeNativeSessionRuntimeFromOperations(provider,
                    { kind: 'create', sessionId: session.id, cwd: directory }, context);
                const writes: Array<{ request: ReturnType<typeof UsageEventIngestRequestSchema.parse>; result: ReturnType<typeof recordUsageEvent> }> = [];
                const operations = createNativeAgentSessionOperations(native, session.id, undefined, undefined, {
                    provider: 'claude',
                    async resolveAccountingWitness(remoteSessionId) {
                        const localFile = await resolveClaudeJsonlSessionFile({ remoteSessionId, env: {},
                            source: { kind: 'claudeConfig', configDir: directory } });
                        if (!localFile) return undefined;
                        return { ...witness, nativeSessionId: remoteSessionId };
                    },
                    publish(input) {
                        const request = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({
                            ...input, sessionId: session.id, machineId: machine.id,
                        }));
                        if (oldProducer && request.metadata) {
                            // The previous host sent the source-keyed inference on a bound replay.
                            const { replayObservationId: _declaration, ...metadata } = request.metadata;
                            const accounting = readUsageAccountingMetadata(metadata)!;
                            request.externalKey = (metadata.accountingSubject && accounting.inferenceId)
                                ? accounting.inferenceId : request.externalKey;
                            request.metadata = { ...metadata, usageAccounting: { ...accounting,
                                nativeSessionId: nativeSessionId } };
                        }
                        writes.push({ request, result: recordUsageEvent(account.id, request) });
                    },
                }, undefined, undefined, { context, cwd: directory, connectedAccounts: [],
                    capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                    cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } });
                const unsubscribe = operations.subscribeRuntimeEvents(() => undefined);
                try {
                    await operations.sendTurnPrompt('reply ready', { localId: resume ? 'resumed-input' : 'first-input',
                        turnId: resume ? 'second-turn' : 'first-turn' });
                    await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledOnce());
                    await exec.emit(resume ? { ...replayed, isReplay: true } : replayed);
                    await expect.poll(() => writes.length).toBe(1);
                    const result = await writes[0]!.result;
                    if (!result.ok) throw new Error('Usage observation was refused');
                    return { ...writes[0]!.request, eventId: result.event.id };
                } finally { unsubscribe(); await operations.resetOrDisposeRuntime('runtime_recovery'); }
            }

            const storedRows = () => db.usageEvent.findMany({ where: { accountId: account.id },
                select: { id: true, metadata: true, totalTokens: true, observedAt: true, turnId: true } });
            if (scenario === 'native-capture-first') {
                const native = deriveNativeUsageAccountingIdentity({ ...witness, nativeSessionId, inferenceId: 'claude-inference' });
                const first = await recordUsageEvent(account.id, UsageEventIngestRequestSchema.parse({
                    subject: { ...subject, sourceRootKey: native.sourceRootKey, nativeSessionKey: native.nativeSessionKey },
                    source: 'claude-assistant-usage', agentId: 'claude', observedAt: 100,
                    externalKey: native.externalKey, scope: 'turn_delta', isCumulative: false, modelId,
                    tokens: { input: 10, output: 2, reasoning: null, cacheRead: 0, cacheWrite: 0, total: 12 },
                    cost: { reportedUsd: null, estimatedUsd: null, currency: 'USD' },
                    accounting: { inferenceKey: native.externalKey, status: 'available' },
                }));
                expect(first.ok).toBe(true);
                expect((await query()).totals.tokens.total).toBe(12);
                await exposeSource();
                const replay = await publishFromSdk(true);
                expect(replay.metadata?.accountingSubject).toMatchObject(subject);
                const result = await query();
                expect(result.totals.tokens.total).toBe(12);
                expect(result.contributions).toHaveLength(1);
                return;
            }
            if (scenario === 'former-bound-key') {
                await exposeSource();
                const first = await publishFromSdk(true, true);
                expect((await query()).totals.tokens.total).toBe(12);
                const replay = await publishFromSdk(true);
                expect(replay.externalKey).not.toBe(first.externalKey);
                expect(replay.eventId).toBe(first.eventId);
                expect(await storedRows()).toMatchObject([{ id: first.eventId, totalTokens: 12, metadata: { accountingSubject: subject } }]);
                return;
            }

            const oldProducer = scenario === 'old-producer-without-declaration';
            const first = await publishFromSdk(false, oldProducer);
            expect(first.metadata).not.toHaveProperty('accountingSubject');
            expect((await query()).totals.tokens.total).toBe(12);
            const [original] = await storedRows();
            await exposeSource();
            const second = await publishFromSdk(true, oldProducer);
            expect(second.metadata?.accountingSubject).toMatchObject(subject);
            const result = await query();
            if (oldProducer) {
                // Old producers still send two different keys for these two observations.
                expect(result.totals.tokens.total).toBe(24);
                expect(await storedRows()).toHaveLength(2);
                return;
            }

            expect(result.totals.tokens.total).toBe(12);
            expect(second.externalKey).toBe(first.externalKey);
            expect(second.eventId).toBe(first.eventId);
            expect(await storedRows()).toEqual([{ ...original, metadata: expect.objectContaining({
                accountingSubject: expect.objectContaining(subject),
            }) }]);
            expect((await storedRows())[0]?.metadata).not.toHaveProperty('replayObservationId');
            if (type === 'result') return;

            const other = await db.session.create({ data: { accountId: account.id, tag: 'other',
                encryptionMode: 'plain', metadata: '{}' } });
            const { eventId: _originalId, ...firstRequest } = first;
            const isolated = await recordUsageEvent(account.id, { ...firstRequest, sessionId: other.id });
            expect(isolated.ok).toBe(true);
            const otherBefore = await db.usageEvent.findFirstOrThrow({ where: { sessionId: other.id } });
            await publishFromSdk(true);
            expect(await db.usageEvent.findFirstOrThrow({ where: { sessionId: other.id } })).toEqual(otherBefore);
        } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it.each([20, 100])('does not inflate a whole-call final (%i earlier tokens)', async earlierTokens => {
        const account = await db.account.create({
            data: { publicKey: `pk-usage-query-claude-producer-${earlierTokens}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `usage-query-claude-producer-${earlierTokens}`,
                encryptionMode: 'e2ee', metadata: 'ciphertext' },
            select: { id: true },
        });
        const querySession = (overrides: Readonly<Record<string, unknown>> = {}) => queryUsageAnalytics(
            account.id,
            UsageAnalyticsQueryRequestSchema.parse({ filters: { sessionIds: [session.id] },
                granularity: 'day', includeSeries: true, ...overrides }),
        );
        const modelId = 'claude-haiku-4-5';
        const assistant = buildClaudeAssistantUsageObservation({ modelId, turnId: 'turn',
            usage: { input_tokens: earlierTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
        const final = buildClaudeSdkResultUsageObservation({ modelId, result: { type: 'result', subtype: 'success', total_cost_usd: 0.12,
            modelUsage: { [modelId]: { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } } });
        expect(assistant).not.toBeNull();
        expect(final).not.toBeNull();
        for (const [index, observation] of [assistant!, final!].entries()) {
            const request = buildUsageEventIngestRequest({ sessionId: session.id,
                observedAt: Date.UTC(2026, 6, index + 1), observation, externalKey: `event-${index}` });
            expect(request).not.toBeNull();
            expect(await recordUsageEvent(account.id, request!)).toMatchObject({ ok: true });
        }
        const result = await querySession({ breakdowns: ['model', 'source', 'session'] });
        expect(result.totals.tokens.total).toBe(100);
        expect(result.costPresentation?.effectiveUsd).toBeCloseTo(0.12, 10);
        expect(result.contributions).toContainEqual(expect.objectContaining({
            cost: expect.objectContaining({ reportedUsd: 0.12 }),
            tokens: expect.objectContaining({ total: null }),
        }));
        const finalDay = await querySession({ dateRange: { startMs: Date.UTC(2026, 6, 2), endMs: Date.UTC(2026, 6, 3) } });
        expect(finalDay.costPresentation).toBeUndefined();
        expect(finalDay.costFacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'reported', amountUsd: 0.12 })]));
        if (earlierTokens === 100) {
            const priced = await querySession({ costMode: 'api_equivalent' });
            expect(priced.totals.cost.apiEquivalentUsd ?? null).toBeNull();
        }
    });
});
