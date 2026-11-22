import { priceUsagePricingPopulation } from '@happier-dev/protocol/usage/usagePricingPopulation';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, buildConnectedServiceCredentialRecord,
    normalizeUsageQuery, resolveUsagePageAggregation,
    UsageAnalyticsQueryRequestSchema, UsageEventIngestRequestSchema, usageQueryToAnalyticsRequest } from '@happier-dev/protocol';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildPublicProfileSnapshot } from '@happier-dev/protocol/account/publicProfileSnapshot';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { db } from '@/storage/db';
import { resolveExternalSessionIdentityTag } from '../../../../cli/src/api/session/external/linking/externalSessionTagLookupCandidates';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prismaClientConstruction';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { buildClaudeAssistantUsageObservation } from '../../../../../packages/plugins/claude/src/agent/usage/buildAssistantObservation';
import { buildClaudeSdkResultUsageObservation } from '../../../../../packages/plugins/claude/src/agent/usage/buildSdkResultObservation';
import { buildUsageEventIngestRequest } from '../../../../cli/src/usage/buildUsageEventIngestRequest';
import { captureUsageAnalytics, projectUsageAnalytics, queryUsageAnalytics } from './usageQueryService';
import { headBatchRow, headPopulation } from './query/__fixtures__/headUsagePopulation';
import { resolveCapturedUsageModelPriceCatalog } from './usageModelPriceCatalog';
import { captureUsageAnalyticsBatch, projectUsageAnalyticsBatch } from './query/readUsageAnalyticsBatch';
import { deleteNativeUsageHistory, recordUsageEvent } from './usageWriteService';
import { getUsageAnalyticsQueryRequestKey, readUsageAccountingMetadata } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { deriveNativeUsageAccountingIdentity, deriveNativeUsageOverlapIdentity } from '../../../../cli/src/usage/collector/nativeUsageAccountingIdentity';
import { createCodexExternalSessionsContribution } from '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution';
import { createNativeUsageCollector } from '../../../../cli/src/usage/collector/nativeUsageCollector';
import { createNativeUsageCaptureStore } from '../../../../cli/src/usage/collector/nativeUsageCaptureState';
import { ExecutionBudgetRegistry } from '../../../../cli/src/daemon/executionBudget/ExecutionBudgetRegistry';
import { buildCodexAppServerTokenCountObservationInput } from '../../../../../packages/plugins/codex/src/agent/usage/tokenCountMessage';
import { withCodexNativeAttachFixture } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { createNativeAgentSessionOperations, createNativeAgentSessionUsageObserver } from '../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { withAgentDaemonMaterializedBootstrap } from '../../../../cli/src/daemon/connectedServices/materialize/agentDaemonBootstrap.testkit';
import { createSdkExecFixture, createEventsFixture, createPluginContextFixture,
    createSessionHooksFixture, createTerminalHostFixture,
} from '../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { createClaudeAgentSdkTurnOperations } from '../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { resolveClaudeJsonlSessionFile } from '../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/files';
import { createOpenCodeServerRuntime } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/runtime';
import type { OpenCodeServerClient } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/openCodeServerClient';
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

    it.each(['equal', 'larger'] as const)(
        'keeps the native OpenCode day when a later attach re-presents a %s exact response', async replay => {
            await checkCausalUsageFixture([
                { day: 0, stream: 'open', path: 'native', scope: 'turn_delta', amount: 12, response: 'one',
                    measurements: { reportedCostUsd: null, estimatedCostUsd: 0.12, costSource: 'pricing_estimate' } },
                { day: 1, stream: 'open', path: 'runtime', scope: 'turn_delta', amount: replay === 'equal' ? 12 : 15, response: 'one',
                    measurements: { reportedCostUsd: null, estimatedCostUsd: 0.3, costSource: 'pricing_estimate' } },
            ], [12, replay === 'equal' ? 0 : 3], replay === 'equal' ? [] : [[1, 'ambiguous_overlap']], {
                seed: replay === 'equal' ? 12 : 15, reportedByDay: [0, 0], estimatedByDay: [0.12, replay === 'equal' ? 0 : 0.06],
            });
        });

    it('keeps a covered native reset and a below-pending runtime checkpoint on their own days', async () => {
        await checkCausalUsageFixture([
            { day: 0, stream: 'codex', path: 'native', scope: 'session_cumulative', amount: 100 },
            { day: 0, stream: 'codex', path: 'runtime', scope: 'turn_delta', amount: 200, response: 'one' },
            { day: 1, stream: 'codex', path: 'native', scope: 'session_cumulative', amount: 40 },
            { day: 1, stream: 'codex', path: 'runtime', scope: 'turn_delta', amount: 5, response: 'two' },
            { day: 2, stream: 'codex', path: 'runtime', scope: 'session_cumulative', amount: 80 },
        ], [200, 5, 0], [[1, 'counter_discontinuity'], [2, 'ambiguous_overlap']]);
    });

    it('admits a distinct Codex response before an equal replay of the earlier native response', async () => {
        await checkCausalUsageFixture([
            { day: 0, stream: 'codex', path: 'native', scope: 'turn_delta', amount: 12, response: 'first' },
            { day: 1, stream: 'codex', path: 'runtime', scope: 'turn_delta', amount: 10, response: 'second' },
            { day: 2, stream: 'codex', path: 'runtime', scope: 'turn_delta', amount: 12, response: 'first' },
        ], [12, 10, 0], []);
    });

    it('credits a native exact amount between a pre-attach checkpoint and an owned checkpoint', async () => {
        await checkCausalUsageFixture(ownershipBoundaryFacts(), [112, 13], []);
    });

    it('counts a native response that completes after the final runtime checkpoint on its own day', async () => {
        await checkCausalUsageFixture(emitUsageTimeline(terminalNativeTimeline, 0), [100, 13], []);
    });

    it.each(['runtime', 'native'] as const)(
        'credits a proven response when the next %s checkpoint measures it', async path => {
            await checkCausalUsageFixture([
                ...emitUsageTimeline(terminalNativeTimeline, 0),
                { day: 2, stream: 'codex', path, scope: 'session_cumulative', amount: 113,
                },
            ], [100, 13, 0], []);
        },
    );

    it('keeps a producer completion witnessed at the same time as its runtime receipt', async () => {
        await checkCausalUsageFixture([
            { day: 0, stream: 'codex', path: 'runtime', scope: 'session_cumulative', amount: 100 },
            { day: 1, offsetMs: 10, stream: 'codex', path: 'runtime', scope: 'turn_delta', amount: 13, response: 'one' },
            { day: 1, offsetMs: 10, stream: 'codex', path: 'native', scope: 'turn_delta', amount: 13, response: 'one' },
            { day: 2, stream: 'codex', path: 'native', scope: 'turn_delta', amount: 5, response: 'two' },
        ], [100, 13, 5], []);
    });

    it('treats a later Codex receipt without completion evidence as possibly covered until the next checkpoint', async () => {
        await checkCausalUsageFixture(emitUsageTimeline(receiptOnlyTimeline, 0), [100, 0, 13], []);
    });

    it('applies the native completion witness to a later larger presentation of the same response', async () => {
        await checkCausalUsageFixture([
            { day: 0, stream: 'codex', path: 'native', scope: 'session_cumulative', amount: 100 },
            { day: 1, stream: 'codex', path: 'native', scope: 'turn_delta', amount: 13, response: 'one' },
            { day: 2, stream: 'codex', path: 'runtime', scope: 'turn_delta', amount: 15, response: 'one' },
        ], [100, 13, 2], [[2, 'ambiguous_overlap']]);
    });

    it('matches HEAD for the reversed same-source pair that the Codex producer does not emit', async () => {
        await checkCausalUsageFixture([
            { day: 0, stream: 'codex', path: 'runtime', scope: 'session_cumulative', amount: 100 },
            { day: 1, stream: 'codex', path: 'runtime', scope: 'turn_delta', amount: 13, response: 'one' },
            { day: 2, stream: 'codex', path: 'runtime', scope: 'session_cumulative', amount: 100 },
        ], [100, 13, 0], []);
    });

    const runtimePricingCases = new Map<number, { modelId: string; turnCost: number; resume: boolean }>([
        [110_123, { modelId: 'gpt-5.4', turnCost: 0.0001575, resume: true }],
        [123_110, { modelId: 'gpt-5.4-mini', turnCost: 0.00004725, resume: true }],
        [13_026, { modelId: 'gpt-5.4-mini', turnCost: 0.00004725, resume: false }],
    ] as const);

    function runtimeOnlyTimeline(modelId: string, resume: boolean): readonly TimelineInference[] {
        return [
            resume ? { day: 0, amount: 110, runtime: 'resume-checkpoint', modelId: null,
                runtimeMeasurements: codexRuntimeMeasurements('gpt-5.4', 100, 10, 20, true) }
                : { day: 0, amount: 13, runtime: 'exact-then-checkpoint', historyIncomplete: true, modelId: 'gpt-5.4',
                    exactMeasurements: codexRuntimeMeasurements('gpt-5.4', 3, 10, 0, false),
                    runtimeMeasurements: codexRuntimeMeasurements('gpt-5.4', 3, 10, 0, true) },
            { day: 1, amount: 13, runtime: 'exact-then-checkpoint', historyIncomplete: true, modelId,
                exactMeasurements: codexRuntimeMeasurements(modelId, 3, 10, 0, false),
                runtimeMeasurements: codexRuntimeMeasurements(modelId, resume ? 103 : 6, 20,
                    resume ? 20 : 0, true) },
        ];
    }

    it.each([...runtimePricingCases])('prices the next runtime-only Codex turn (%s)', async (seed, priceCase) => {
        const timeline = runtimeOnlyTimeline(priceCase.modelId, priceCase.resume);
        await checkCausalUsageFixture(emitUsageTimeline(timeline, 0), timeline.map(row => row.amount),
            priceCase.resume ? [[0, 'missing_baseline']] : [], {
                seed, reportedByDay: [0, 0], pricedTurn: { day: 1, ...priceCase },
            });
    });

    function mixedCaptureResumeTimeline(): readonly TimelineInference[] {
        return [
            { day: 0, amount: 100, native: 'exact-then-checkpoint', modelId: 'gpt-5.4-mini',
                exactMeasurements: codexRuntimeMeasurements('gpt-5.4-mini', 95, 5, 20, false),
                nativeMeasurements: codexRuntimeMeasurements('gpt-5.4-mini', 95, 5, 20, true) },
            { day: 0, amount: 10, native: 'exact-then-checkpoint', modelId: 'gpt-5.4',
                exactMeasurements: codexRuntimeMeasurements('gpt-5.4', 5, 5, 0, false),
                nativeMeasurements: codexRuntimeMeasurements('gpt-5.4', 100, 10, 20, true) },
            { day: 0, amount: 0, runtime: 'resume-checkpoint', modelId: null,
                runtimeMeasurements: codexRuntimeMeasurements('gpt-5.4-mini', 100, 10, 20, true) },
            { day: 1, amount: 13, runtime: 'exact-then-checkpoint', historyIncomplete: true, modelId: 'gpt-5.4-mini',
                exactMeasurements: codexRuntimeMeasurements('gpt-5.4-mini', 3, 10, 0, false),
                runtimeMeasurements: codexRuntimeMeasurements('gpt-5.4-mini', 103, 20, 20, true) },
        ];
    }

    it('keeps the estimates of mixed-model capture and the next runtime turn', async () => {
        await checkCausalUsageFixture(emitUsageTimeline(mixedCaptureResumeTimeline(), 0), [110, 13], [], {
            seed: 110_013, reportedByDay: [0, 0], estimatedByDay: [0.00016775, 0.00004725],
            pricedTurn: { day: 1, modelId: 'gpt-5.4-mini', turnCost: 0.00004725 },
        });
    });

    const checkpointPricingCases = new Map<number, 'native' | 'runtime'>([
        [110_120, 'native'], [120_110, 'runtime'],
    ]);

    function checkpointPricingTimeline(path: 'native' | 'runtime'): readonly TimelineInference[] {
        const modelId = 'gpt-5.4';
        let inputTotal = 0, outputTotal = 0, cacheTotal = 0;
        return [[100, 10, 20], [2, 8, 0], [18, 2, 11]].map(([input, output, cache], day) => {
            inputTotal += input!;
            outputTotal += output!;
            cacheTotal += cache!;
            const own = codexRuntimeMeasurements(modelId, input!, output!, cache!, false);
            const counter = codexRuntimeMeasurements(modelId, inputTotal, outputTotal, cacheTotal, true);
            return { day, amount: input! + output!, modelId, exactMeasurements: own,
                ...(path === 'native' ? { native: 'checkpoint' as const, nativeMeasurements: counter }
                    : { runtime: 'checkpoint' as const, runtimeMeasurements: counter }) };
        });
    }

    it.each([...checkpointPricingCases])('prices the changing token mix in %s (%s) checkpoints', async (seed, path) => {
        const timeline = checkpointPricingTimeline(path);
        await checkCausalUsageFixture(emitUsageTimeline(timeline, 0), [110, 10, 20], [], {
            seed, reportedByDay: [0, 0, 0], estimatedByDay: [0.000355, 0.000125, inferenceEstimate(timeline[2]!)],
            savingsByDay: timeline.map(row => row.exactMeasurements?.breakdown?.cacheSavingsUsd ?? 0),
        });
    });

    function codexRuntimeMeasurements(modelId: string, input: number, output: number, cache: number, checkpoint: boolean):
        FixtureMeasurements {
        const tokens = { inputTokens: input, outputTokens: output, cachedInputTokens: cache,
            cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: input + output };
        const observation = buildCodexAppServerTokenCountObservationInput({
            modelId, notificationParams: { tokenUsage: checkpoint ? { total: tokens } : { last: tokens } },
        })?.runtimeObservation;
        if (!observation?.cost || observation.cost.estimatedUsd == null) throw new Error('Codex usage fixture needs its producer estimate');
        return { modelId, inputTokens: input, outputTokens: output, cacheReadTokens: cache, cacheWriteTokens: 0,
            reasoningTokens: 0, reportedCostUsd: null, estimatedCostUsd: observation.cost.estimatedUsd,
            costSource: 'pricing_estimate', breakdown: observation.cost.breakdown };
    }

    it('counts native exact history already covered by the first resumed absolute checkpoint once', async () => {
        await checkCausalUsageFixture([
            { day: 0, stream: 'codex', path: 'native', scope: 'turn_delta', amount: 12, response: 'before-attach' },
            { day: 1, stream: 'codex', path: 'runtime', scope: 'session_cumulative', amount: 25 },
        ], [12, 13], []);
    });

    it.each(['turn_delta', 'session_cumulative'] as const)(
        'settles runtime %s against its own later checkpoint', async scope => {
            await checkCausalUsageFixture([
                { day: 0, stream: 'codex', path: 'runtime', scope, amount: 20 },
                { day: 1, stream: 'codex', path: 'runtime', scope: 'session_cumulative', amount: 25 },
            ], [20, 5], []);
        });

    it('preserves HEAD for a same-source exact receipt before the incomplete and catching-up checkpoints', async () => {
        await checkCausalUsageFixture([
            { day: 0, stream: 'codex', path: 'runtime', scope: 'session_cumulative', amount: 100 },
            { day: 0, stream: 'codex', path: 'runtime', scope: 'turn_delta', amount: 12, response: 'first' },
            { day: 1, stream: 'codex', path: 'runtime', scope: 'session_cumulative', amount: 105 },
            { day: 2, stream: 'codex', path: 'runtime', scope: 'session_cumulative', amount: 125 },
        ], [112, 0, 20], []);
    });

    function ownershipBoundaryFacts(): FixtureUsageFact[] {
        return emitUsageTimeline([
            { day: 0, amount: 100, native: 'checkpoint' },
            { day: 0, amount: 12, native: 'exact' },
            { day: 1, amount: 13, native: 'checkpoint', runtime: 'exact' },
        ], 1);
    }

    type TimelineInference = Readonly<{
        day: number;
        amount: number;
        native?: 'exact' | 'checkpoint' | 'exact-then-checkpoint';
        runtime?: 'exact' | 'checkpoint' | 'exact-then-checkpoint' | 'resume-checkpoint' | 'occupancy';
        historyIncomplete?: boolean;
        runtimeReset?: 'witnessed' | 'unwitnessed';
        reportedCheckpoint?: number;
        modelId?: string | null;
        exactMeasurements?: FixtureMeasurements;
        nativeMeasurements?: FixtureMeasurements;
        runtimeMeasurements?: FixtureMeasurements;
        reset?: 'witnessed' | 'unwitnessed';
        replay?: { day: number; increase: number };
    }>;

    const terminalNativeTimeline = [
        { day: 0, amount: 100, runtime: 'checkpoint' },
        { day: 1, amount: 13, native: 'exact' },
    ] as const satisfies readonly TimelineInference[];

    const receiptOnlyTimeline = [
        { day: 0, amount: 100, native: 'checkpoint' },
        { day: 1, amount: 13, runtime: 'exact' },
        { day: 2, amount: 0, runtime: 'checkpoint' },
    ] as const satisfies readonly TimelineInference[];

    const firstCheckpointCases = new Map<number, { exactPath: 'native' | 'runtime'; checkpoint: number }>([
        [101_090, { exactPath: 'native', checkpoint: 90 }],
        [101_100, { exactPath: 'native', checkpoint: 100 }],
        [101_113, { exactPath: 'native', checkpoint: 113 }],
        [102_090, { exactPath: 'runtime', checkpoint: 90 }],
        [102_100, { exactPath: 'runtime', checkpoint: 100 }],
        [102_113, { exactPath: 'runtime', checkpoint: 113 }],
    ]);

    const miniPrice = {
        modelId: 'gpt-5.4-mini', inputTokens: 90, outputTokens: 20, cacheReadTokens: 6,
        reportedCostUsd: null, estimatedCostUsd: 0.0001065, costSource: 'pricing_estimate',
        breakdown: { input: 0.0001065 },
    } as const satisfies FixtureMeasurements;
    const fullPrice = {
        ...miniPrice, modelId: 'gpt-5.4', estimatedCostUsd: 0.000355, breakdown: { input: 0.000355 },
    } as const satisfies FixtureMeasurements;
    const measuredExact = {
        inputTokens: 90, outputTokens: 20, reportedCostUsd: 0.5, costSource: 'provider_reported',
    } as const satisfies FixtureMeasurements;
    const independentMeasurements = new Map<number, {
        exact: FixtureMeasurements; checkpoint: FixtureMeasurements;
        reportedByDay: readonly number[]; measuredExcess?: 'cache' | 'reported-cost' | 'reported-breakdown';
    }>([
        [110_355, { exact: miniPrice, checkpoint: fullPrice, reportedByDay: [0, 0] }],
        [355_110, { exact: fullPrice, checkpoint: miniPrice, reportedByDay: [0, 0] }],
        [110_003, { exact: measuredExact,
            checkpoint: { ...measuredExact, outputTokens: null, cacheReadTokens: 3 },
            reportedByDay: [0.5, 0], measuredExcess: 'cache' }],
        [110_025, { exact: measuredExact,
            checkpoint: { ...measuredExact, inputTokens: null, reportedCostUsd: 0.75 },
            reportedByDay: [0.5, 0.25], measuredExcess: 'reported-cost' }],
        [110_010, { exact: { ...measuredExact, breakdown: { input: 0.1 } },
            checkpoint: { ...measuredExact, breakdown: { input: 0.2 } },
            reportedByDay: [0.5, 0], measuredExcess: 'reported-breakdown' }],
    ]);

    // A checkpoint sees the provider's actual cumulative usage, regardless of
    // whether the collector or host has separately presented those inferences.
    function emitUsageTimeline(timeline: readonly TimelineInference[], attachDay: number | null): FixtureUsageFact[] {
        const facts: FixtureUsageFact[] = [];
        const replays: FixtureUsageFact[] = [];
        let nativeTotal = 0;
        let runtimeTotal = 0;
        let epoch = 0;
        let runtimeEpoch = 0;
        for (const [index, inference] of timeline.entries()) {
            const { day, amount, native, runtime, reset, runtimeReset, reportedCheckpoint, replay,
                nativeMeasurements, runtimeMeasurements, exactMeasurements, modelId, historyIncomplete } = inference;
            const model = modelId === undefined ? {} : { modelId };
            const common = { day, stream: 'codex' as const };
            const response = `response-${index}`;
            if (reset) {
                nativeTotal = 0;
                epoch++;
            }
            nativeTotal += amount;
            // Timestamp the exact completion before counters that include it.
            if (native === 'exact' || native === 'exact-then-checkpoint') facts.push({
                ...common, path: 'native', scope: 'turn_delta', amount, response, measurements: { ...model, ...(native === 'exact' ? nativeMeasurements : exactMeasurements) },
            });
            if (runtimeReset) {
                runtimeTotal = 0;
                runtimeEpoch++;
            }
            runtimeTotal += amount;
            if (attachDay !== null && day >= attachDay) {
                if (runtime === 'exact-then-checkpoint') facts.push({
                    ...common, path: 'runtime', scope: 'turn_delta', amount, response,
                    measurements: { ...model, ...exactMeasurements },
                });
                if (runtime === 'checkpoint' || runtime === 'exact-then-checkpoint' || runtime === 'resume-checkpoint') facts.push({
                    ...common, path: 'runtime', scope: 'session_cumulative', amount: reportedCheckpoint ?? runtimeTotal,
                    measurements: { ...model, ...runtimeMeasurements },
                    ...(runtime === 'resume-checkpoint' || historyIncomplete ? { historyIncomplete: true }
                        : runtimeReset === 'unwitnessed' ? {} : { epoch: `runtime-${runtimeEpoch}` }),
                });
                if (runtime === 'occupancy') facts.push({
                    ...common, path: 'runtime', scope: 'session_cumulative', amount: 0, occupancy: true,
                    epoch: `runtime-${runtimeEpoch}`,
                });
                if (runtime === 'exact') facts.push({
                    ...common, path: 'runtime', scope: 'turn_delta', amount, response,
                    measurements: { ...model, ...exactMeasurements },
                });
                if (replay) replays.push({ ...common, day: replay.day, path: 'runtime', scope: 'turn_delta',
                    amount: amount + replay.increase, response, measurements: { ...model, ...exactMeasurements } });
            }
            if (native === 'checkpoint' || native === 'exact-then-checkpoint') facts.push({ ...common, path: 'native', scope: 'session_cumulative',
                amount: nativeTotal, measurements: { ...model, ...nativeMeasurements }, ...(reset === 'unwitnessed' ? {} : { epoch: `native-${epoch}` }) });
        }
        return [...facts, ...replays].sort((left, right) => left.day - right.day);
    }

    function inferenceEstimate(inference: TimelineInference): number {
        return inference.exactMeasurements?.estimatedCostUsd
            ?? (inference.native === 'exact' ? inference.nativeMeasurements?.estimatedCostUsd : undefined)
            ?? (inference.amount && inference.runtime === 'resume-checkpoint' ? inference.runtimeMeasurements?.estimatedCostUsd : undefined)
            ?? 0;
    }

    type ModelTotals = ReadonlyMap<string, number>;

    function addModelTokens(models: Map<string, number>, modelId: string | null, amount: number) {
        if (!amount) return;
        const key = modelId ?? 'unknown';
        models.set(key, (models.get(key) ?? 0) + amount);
    }

    function modelTotals(rows: Iterable<readonly [modelId: string | null, total: number | null]>) {
        const result = new Map<string, number>();
        for (const [modelId, total] of rows) addModelTokens(result, modelId, total ?? 0);
        return result;
    }

    it('checks causal scalar, batch and compact buckets against fixed-seed inference timelines', async () => {
        for (const seed of [112125, 10013, 13_113, 25_012, 37_012, 3_712, 100_110, 100_100, 100_113,
            ...firstCheckpointCases.keys(), ...independentMeasurements.keys(), ...runtimePricingCases.keys(),
            ...checkpointPricingCases.keys(), 110_013,
            7, 42, 125, 212, 421, 443, 919, 2027]) {
            let state = seed;
            const pick = (choices: number) => {
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                return (state >>> 16) % choices;
            };
            const amount = () => 10 + pick(20);
            const a = amount(), b = amount(), c = amount(), d = amount();
            const days = 4 + pick(3);
            const chosenAttach = pick(days + 1);
            let total = 0;
            const generated: TimelineInference[] = Array.from({ length: days }, (_, day) => {
                const input = amount();
                total += input;
                const modelId = (seed + day) % 2 === 0 ? 'gpt-5.4' : 'gpt-5.4-mini';
                const checkpointModel = modelId === 'gpt-5.4' ? 'gpt-5.4-mini' : 'gpt-5.4';
                const exact = codexRuntimeMeasurements(modelId, input, 0, 0, false);
                return {
                    day, amount: input, native: 'exact', modelId,
                    exactMeasurements: exact, nativeMeasurements: exact,
                    runtimeMeasurements: codexRuntimeMeasurements(checkpointModel, total, 0, 0, true),
                    ...(day >= chosenAttach ? {
                        runtime: (['exact', 'checkpoint', 'exact-then-checkpoint'] as const)[pick(3)]!,
                    } : {}),
                };
            });
            const priceCase = runtimePricingCases.get(seed);
            const checkpointPath = checkpointPricingCases.get(seed);
            const firstCheckpoint = firstCheckpointCases.get(seed);
            const independent = independentMeasurements.get(seed);
            const recipe: { attach: number | null; timeline: readonly TimelineInference[]; diagnostics: readonly FixtureDiagnostic[];
                orderUnprovenUntil?: number; acceptedResumeShortfall?: number } =
                checkpointPath ? { attach: 0, timeline: checkpointPricingTimeline(checkpointPath), diagnostics: [] }
                : seed === 110_013 ? { attach: 0, timeline: mixedCaptureResumeTimeline(), diagnostics: [] }
                : seed === 112125 ? { attach: 1, timeline: [
                    { day: 0, amount: 100, native: 'checkpoint' },
                    { day: 0, amount: 12, native: 'exact' },
                    { day: 1, amount: 13, native: 'checkpoint', runtime: 'exact' },
                ], diagnostics: [] }
                : seed === 10013 ? { attach: 0, timeline: terminalNativeTimeline, diagnostics: [] }
                : seed === 13_113 ? { attach: 0, timeline: receiptOnlyTimeline, diagnostics: [], orderUnprovenUntil: 2 }
                : seed === 25_012 ? { attach: 1, timeline: [
                    { day: 0, amount: 12, native: 'exact' },
                    { day: 1, amount: 13, runtime: 'checkpoint' },
                ], diagnostics: [] }
                : seed === 37_012 ? { attach: 1, timeline: [
                    { day: 0, amount: 12, native: 'exact' },
                    { day: 1, amount: 25, runtime: 'checkpoint', runtimeReset: 'unwitnessed' },
                ], diagnostics: [], orderUnprovenUntil: Infinity, acceptedResumeShortfall: 12 }
                : seed === 3_712 ? { attach: 0, timeline: [
                    { day: 0, amount: 12, native: 'exact', runtime: 'checkpoint' },
                    { day: 1, amount: 25, runtime: 'checkpoint', runtimeReset: 'witnessed' },
                ], diagnostics: [] }
                : seed === 100_110 ? { attach: 0, timeline: [
                    { day: 0, amount: 100, runtime: 'checkpoint' },
                    { day: 1, amount: 0, runtime: 'occupancy' },
                    { day: 2, amount: 10, runtime: 'checkpoint' },
                ], diagnostics: [] }
                : seed === 100_100 || seed === 100_113 ? { attach: 1, timeline: [
                    { day: 0, amount: 100, native: 'checkpoint' },
                    { day: 1, amount: seed === 100_100 ? 0 : 13, runtime: 'resume-checkpoint', modelId: null },
                ], diagnostics: [] }
                : firstCheckpoint ? {
                    attach: firstCheckpoint.exactPath === 'native' ? 1 : 0,
                    timeline: [
                        { day: 0, amount: 100, [firstCheckpoint.exactPath]: 'exact' },
                        { day: 1, amount: Math.max(0, firstCheckpoint.checkpoint - 100), runtime: 'resume-checkpoint',
                            reportedCheckpoint: firstCheckpoint.checkpoint, modelId: null },
                    ],
                    diagnostics: firstCheckpoint.checkpoint > 100 ? [[1, 'missing_baseline']]
                        : firstCheckpoint.checkpoint < 100 && firstCheckpoint.exactPath === 'runtime' ? [[1, 'ambiguous_overlap']] : [],
                }
                : independent ? { attach: 1, timeline: [
                    { day: 0, amount: 110, native: 'exact', modelId: independent.exact.modelId, nativeMeasurements: independent.exact },
                    { day: 1, amount: 0, runtime: 'resume-checkpoint', runtimeMeasurements: independent.checkpoint },
                ], diagnostics: independent.measuredExcess ? [[1, 'missing_baseline']] : [] }
                : priceCase ? { attach: 0, timeline: runtimeOnlyTimeline(priceCase.modelId, priceCase.resume),
                    diagnostics: priceCase.resume ? [[0, 'missing_baseline']] : [] }
                : seed === 7 ? { attach: null, timeline: [
                    { day: 0, amount: a + b, native: 'checkpoint' },
                    { day: 1, amount: c, native: 'exact' },
                    { day: 2, amount: d, native: 'checkpoint' },
                ], diagnostics: [] }
                : seed === 42 ? { attach: 0, timeline: [
                    { day: 0, amount: a, native: 'checkpoint', runtime: 'exact' },
                    { day: 1, amount: b, runtime: 'exact' },
                    { day: 2, amount: c, runtime: 'checkpoint' },
                    { day: 3, amount: d, runtime: 'checkpoint' },
                ], diagnostics: [], orderUnprovenUntil: 2 }
                : seed === 125 ? { attach: 1, timeline: [
                    { day: 0, amount: a + b, native: 'checkpoint' },
                    { day: 1, amount: c, native: 'checkpoint', reset: 'witnessed', runtime: 'exact' },
                    { day: 2, amount: d, native: 'checkpoint', runtime: 'checkpoint' },
                ], diagnostics: [] }
                : seed === 212 ? { attach: 0, timeline: [
                    { day: 0, amount: a, native: 'exact', runtime: 'exact', replay: { day: 3, increase: 0 } },
                    { day: 1, amount: b, native: 'exact', runtime: 'exact', replay: { day: 4, increase: 3 } },
                    { day: 2, amount: c, native: 'exact', runtime: 'checkpoint' },
                ], diagnostics: [[4, 'ambiguous_overlap']] }
                : seed === 421 ? { attach: 1, timeline: [
                    { day: 0, amount: 100, native: 'checkpoint' },
                    { day: 1, amount: c, native: 'checkpoint', reset: 'unwitnessed', runtime: 'exact' },
                    { day: 2, amount: d, native: 'checkpoint' },
                ], diagnostics: [[1, 'counter_discontinuity']] }
                : { attach: chosenAttach === days ? null : chosenAttach, timeline: generated, diagnostics: [] };
            const truth = new Map<number, number>();
            const models = new Map<number, Map<string, number>>();
            const estimated = new Map<number, number>();
            const addTruth = (day: number, amount: number, modelId: string | null) => {
                truth.set(day, (truth.get(day) ?? 0) + amount);
                const byModel = models.get(day) ?? new Map<string, number>();
                addModelTokens(byModel, modelId, amount);
                models.set(day, byModel);
            };
            for (const inference of recipe.timeline) {
                const { day, amount, modelId, replay } = inference;
                const model = modelId === undefined ? 'recorded-model' : modelId;
                addTruth(day, amount, model);
                estimated.set(day, (estimated.get(day) ?? 0) + inferenceEstimate(inference));
                if (replay) addTruth(replay.day, replay.increase, model);
            }
            const expected = Array.from({ length: Math.max(...truth.keys()) + 1 }, (_, day) => truth.get(day) ?? 0);
            await checkCausalUsageFixture(emitUsageTimeline(recipe.timeline, recipe.attach), expected, recipe.diagnostics,
                { seed, orderUnprovenUntil: recipe.orderUnprovenUntil, models,
                    acceptedResumeShortfall: recipe.acceptedResumeShortfall,
                    reportedByDay: priceCase || checkpointPath || seed === 110_013 || recipe.timeline === generated
                        ? expected.map(() => 0) : independent?.reportedByDay,
                    savingsByDay: checkpointPath ? recipe.timeline.map(row => row.exactMeasurements?.breakdown?.cacheSavingsUsd ?? 0) : undefined,
                    estimatedByDay: expected.map((_, day) => estimated.get(day) ?? 0),
                    pricedTurn: priceCase ? { day: 1, ...priceCase } : undefined });
        }
    });

    type FixtureMeasurements = Readonly<{
        modelId?: string | null;
        inputTokens?: number | null;
        outputTokens?: number | null;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number;
        reportedCostUsd?: number | null;
        estimatedCostUsd?: number;
        costSource?: 'provider_reported' | 'pricing_estimate';
        breakdown?: Readonly<Record<string, number>>;
    }>;
    type FixtureUsageFact = Readonly<{
        day: number;
        offsetMs?: number;
        stream: 'codex' | 'open';
        path: 'runtime' | 'native';
        scope: 'turn_delta' | 'session_cumulative';
        amount: number;
        response?: string;
        epoch?: string;
        occupancy?: boolean;
        historyIncomplete?: boolean;
        measurements?: FixtureMeasurements;
    }>;
    function fixtureMeasurements(fact: FixtureUsageFact) {
        const { breakdown, ...amounts } = fact.measurements ?? {};
        return {
            modelId: 'recorded-model', inputTokens: fact.amount, totalTokens: fact.amount,
            reportedCostUsd: fact.occupancy ? null : fact.amount,
            costSource: fact.occupancy ? 'none' : 'provider_reported',
            ...amounts, costBreakdown: breakdown ? JSON.stringify(breakdown) : null,
        };
    }
    type FixtureDiagnostic = readonly [day: number, reason: 'ambiguous_overlap' | 'counter_discontinuity' | 'missing_baseline'];
    async function checkCausalUsageFixture(facts: readonly FixtureUsageFact[], expected: readonly number[],
        diagnostics: readonly FixtureDiagnostic[],
        oracle?: { seed: number; orderUnprovenUntil?: number; acceptedResumeShortfall?: number; reportedByDay?: readonly number[];
            models?: ReadonlyMap<number, ModelTotals>; estimatedByDay?: readonly number[]; savingsByDay?: readonly number[];
            pricedTurn?: { day: number; modelId: string; turnCost: number } }) {
        const account = await db.account.create({ data: { publicKey: `causal-usage-${oracle?.seed ?? facts.length}` } });
        const dayMs = 86_400_000;
        const at = (day: number) => Date.UTC(2026, 6, 1) + day * dayMs;
        const request = (start: number, end: number, compact = false) => UsageAnalyticsQueryRequestSchema.parse({
            dateRange: { startMs: at(start), endMs: at(end) }, granularity: 'day', timeZoneOffsetMinutes: 0,
            includeSeries: !compact, includeActivity: compact,
            ...(!compact && (oracle?.models || oracle?.pricedTurn) ? { breakdowns: ['model'] } : {}),
            ...(!compact && oracle?.pricedTurn ? { costMode: 'api_equivalent' } : {}),
        });
        const compactPrefix = async (end: number) => {
            const query = request(0, end, true);
            const demand = { contributionQueries: [], sessionQueries: [query] };
            const captured = await captureUsageAnalyticsBatch(account.id, [query], undefined, demand);
            const response = await projectUsageAnalyticsBatch(captured, [query], false, true, undefined, demand);
            const result = response.results[0]!;
            if ('error' in result) throw new Error('Compact Usage projection failed');
            expect(captured.activitySummary).toBeDefined();
            return { value: result.value, days: new Map(captured.activitySummary!.days) };
        };
        // The fixture vocabulary gives the source of each stream independently of the
        // fold's routing predicate. HEAD can revise earlier single-source diagnostics.
        const singleSourceThrough = (day: number) => {
            const firstByStream = new Map<string, FixtureUsageFact['path']>();
            return facts.every(fact => {
                if (fact.day > day) return true;
                const first = firstByStream.get(fact.stream);
                if (first) return first === fact.path;
                firstByStream.set(fact.stream, fact.path);
                return true;
            });
        };
        const compact = [];
        const scalar = [];
        const singleSource = singleSourceThrough(expected.length - 1);
        for (let end = 1; end <= expected.length; end++) {
            const rows = facts.filter(fact => fact.day === end - 1);
            if (rows.length) await db.usageEvent.createMany({ data: rows.map((fact, index) => ({
                accountId: account.id, agentId: fact.stream === 'open' ? 'opencode' : 'codex',
                machineId: 'fixture-machine', source: fact.path,
                observedAt: new Date(at(fact.day) + (fact.offsetMs ?? 10 * (index + 1))),
                createdAt: new Date(at(fact.day) + 10 * (index + 1)),
                scope: fact.scope, isCumulative: fact.scope === 'session_cumulative',
                ...fixtureMeasurements(fact),
                ...(fact.occupancy ? {
                    outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
                    contextUsedTokens: 25, contextWindowTokens: 1000,
                } : {}),
                metadata: { usageAccounting: { path: fact.path, nativeSessionKey: (fact.stream === 'codex' ? 'a' : 'b').repeat(64),
                    status: 'available', inputIncludesCache: false, outputIncludesReasoning: false,
                    ...(!fact.historyIncomplete ? { historyComplete: true } : {}),
                    ...(fact.response ? { inferenceId: fact.response } : {}),
                    ...(fact.epoch ? { counterEpoch: fact.epoch } : {}),
                } },
            })) });
            scalar.push(await queryUsageAnalytics(account.id, request(0, end)));
            compact.push(await compactPrefix(end));
            if (singleSourceThrough(end - 1)) {
                const scalarQuery = request(0, end);
                const compactQuery = request(0, end, true);
                const snapshot = await captureUsageAnalytics(account.id, scalarQuery);
                const prices = resolveCapturedUsageModelPriceCatalog(snapshot.priceCatalog);
                const reference = headPopulation(snapshot.rows, scalarQuery);
                const label = `HEAD prefix ${end} (seed ${oracle?.seed ?? 'named'})`;
                expect(JSON.stringify(projectUsageAnalytics(snapshot, scalarQuery, prices)), label)
                    .toBe(JSON.stringify(projectUsageAnalytics(snapshot, scalarQuery, prices, reference)));
                for (const [query, compactRead] of [[scalarQuery, false], [compactQuery, true]] as const) {
                    const captured = { snapshots: new Map([[getUsageAnalyticsQueryRequestKey(query), snapshot]]),
                        priceCatalog: snapshot.priceCatalog };
                    const actual = await projectUsageAnalyticsBatch(captured, [query], !compactRead, compactRead);
                    expect(JSON.stringify(actual.results[0]), label)
                        .toBe(JSON.stringify(await headBatchRow(snapshot, prices, query, compactRead)));
                }
            }
        }
        const queries = [...expected.map((_, day) => request(0, day + 1)), ...expected.map((_, day) => request(day, day + 1))];
        const captured = await captureUsageAnalyticsBatch(account.id, queries);
        const batch = await projectUsageAnalyticsBatch(captured, queries, true);
        const series = (response: (typeof scalar)[number], day: number) => {
            const bucket = response.series?.find(row => row.bucketStartMs === at(day));
            return [bucket?.tokens.total ?? 0, bucket?.cost.reportedUsd ?? 0];
        };
        let admitted = 0;
        let truth = 0;
        const keyed = new Map<string, number>();
        for (const [day, amount] of expected.entries()) {
            const rangeRead = await queryUsageAnalytics(account.id, queries[expected.length + day]!);
            const actual = rangeRead.totals.tokens.total ?? 0;
            const reported = oracle?.reportedByDay?.[day] ?? actual;
            const orderUnprovenUntil = oracle?.orderUnprovenUntil;
            if (singleSource) {
                const query = request(day, day + 1);
                const snapshot = await captureUsageAnalytics(account.id, query);
                const baseline = projectUsageAnalytics(snapshot, query, resolveCapturedUsageModelPriceCatalog(snapshot.priceCatalog),
                    headPopulation(snapshot.rows, query));
                expect(JSON.stringify(projectUsageAnalytics(snapshot, query))).toBe(JSON.stringify(baseline));
                expect(actual).toBe(baseline.totals.tokens.total ?? 0);
                if (!oracle) expect(actual).toBe(amount);
            } else {
                if (orderUnprovenUntil === undefined) expect(actual, `seed ${oracle?.seed}, day ${day}`).toBe(amount);
                expect(actual).toBeGreaterThanOrEqual(0);
                admitted += actual;
                truth += amount;
                expect(admitted, `seed ${oracle?.seed}, truth ceiling through day ${day}`).toBeLessThanOrEqual(truth);
                if (orderUnprovenUntil !== undefined && day >= orderUnprovenUntil) expect(admitted).toBe(truth);
                expect(scalar[day]!.totals.tokens.total ?? 0).toBe(admitted);
                for (const fact of facts) {
                    if (fact.day !== day) continue;
                    if (fact.response) {
                        const key = `${fact.stream}:${fact.response}`;
                        keyed.set(key, Math.max(keyed.get(key) ?? 0, fact.amount));
                    }
                    if (fact.scope === 'session_cumulative') expect(admitted).toBeGreaterThanOrEqual(fact.amount);
                }
                expect(admitted).toBeGreaterThanOrEqual([...keyed.values()].reduce((sum, value) => sum + value, 0));
            }
            expect(batch.results[day]).toMatchObject({ value: { totals: scalar[day]!.totals, coverage: scalar[day]!.coverage } });
            expect(batch.results[expected.length + day]).toMatchObject({ value: { totals: rangeRead.totals, coverage: rangeRead.coverage } });
            const attributed = modelTotals(rangeRead.breakdowns?.model?.map(row => [row.key, row.tokens.total]) ?? []);
            const expectedModels = oracle?.models?.get(day);
            if (!singleSource && expectedModels && (orderUnprovenUntil === undefined || day === 0)) {
                expect(attributed, `seed ${oracle?.seed}, model tokens on day ${day}`).toEqual(expectedModels);
            }
            if (expectedModels) {
                const ranged = batch.results[expected.length + day]!;
                if ('error' in ranged) throw new Error('Batch Usage model projection failed');
                expect(modelTotals(ranged.value.breakdowns?.model?.map(row => [row.key, row.tokens.total]) ?? [])).toEqual(attributed);
            }
            const estimate = oracle?.estimatedByDay?.[day];
            const savings = oracle?.savingsByDay?.[day];
            if (!singleSource && savings !== undefined) expect(rangeRead.totals.cost.breakdown?.cacheSavingsUsd ?? 0).toBeCloseTo(savings, 12);
            if (!singleSource && estimate !== undefined) {
                expect(rangeRead.totals.cost.estimatedUsd ?? 0, `seed ${oracle?.seed}, estimate on day ${day}`).toBeCloseTo(estimate, 12);
            }
            if (estimate !== undefined) {
                expect(rangeRead.totals.cost.estimatedUsd ?? 0, `seed ${oracle?.seed}, estimate on day ${day}`).toBeCloseTo(estimate, 12);
            }
            const priced = oracle?.pricedTurn;
            if (priced?.day === day) {
                expect(rangeRead.totals.cost.apiEquivalentUsd ?? 0).toBeCloseTo(priced.turnCost, 12);
                expect(rangeRead.totals.cost.estimatedUsd ?? 0).toBeCloseTo(priced.turnCost, 12);
                expect(rangeRead.breakdowns?.model?.find(row => row.key === priced.modelId)?.tokens.total).toBe(amount);
                const part = compact[day]!.days.get(at(day));
                const projection = part && priceUsagePricingPopulation(
                    part.facts.pricing, bundledUsageModelPriceCatalog, {}, 'api_equivalent');
                expect(projection?.cost.apiEquivalentUsd ?? 0).toBeCloseTo(priced.turnCost, 12);
            }
            for (let end = day; end < expected.length; end++) {
                if (!singleSource) {
                    expect(series(scalar[end]!, day)).toEqual([actual, reported]);
                    const batchResult = batch.results[end]!;
                    if ('error' in batchResult) throw new Error('Batch Usage projection failed');
                    expect(series(batchResult.value, day)).toEqual([actual, reported]);
                    const part = compact[end]!.days.get(at(day));
                    expect(part?.facts.totals.tokens.total ?? 0).toBe(actual);
                    if (expectedModels) expect(modelTotals(part?.facts.pricing.groups.map(group =>
                        [group.modelId, group.tokens.total]) ?? [])).toEqual(attributed);
                    const dated = part ? priceUsagePricingPopulation(part.facts.pricing, bundledUsageModelPriceCatalog, {}, 'reported') : undefined;
                    expect(dated?.cost.reportedUsd ?? 0).toBe(reported);
                    if (estimate !== undefined) {
                        expect(dated?.cost.estimatedUsd ?? 0).toBeCloseTo(estimate, 12);
                        expect(scalar[end]!.series?.find(row => row.bucketStartMs === at(day))?.cost.estimatedUsd ?? 0)
                            .toBeCloseTo(estimate, 12);
                        expect(batchResult.value.series?.find(row => row.bucketStartMs === at(day))?.cost.estimatedUsd ?? 0)
                            .toBeCloseTo(estimate, 12);
                    }
                    if (savings !== undefined) {
                        expect(dated?.cost.breakdown?.cacheSavingsUsd ?? 0).toBeCloseTo(savings, 12);
                        expect(scalar[end]!.series?.find(row => row.bucketStartMs === at(day))?.cost.breakdown?.cacheSavingsUsd ?? 0)
                            .toBeCloseTo(savings, 12);
                        expect(batchResult.value.series?.find(row => row.bucketStartMs === at(day))?.cost.breakdown?.cacheSavingsUsd ?? 0)
                            .toBeCloseTo(savings, 12);
                    }
                    expect(compact[end]!.days.get(at(day))?.coverage).toEqual(compact[day]!.days.get(at(day))?.coverage);
                } else if (end > day) {
                    const bucketAmount = (prefix: (typeof scalar)[number]) => {
                        const bucket = prefix.series?.find(item => item.bucketStartMs === at(day));
                        const cost = bucket?.cost;
                        return { tokens: bucket?.tokens, reportedUsd: cost?.reportedUsd, estimatedUsd: cost?.estimatedUsd,
                            invoiceUsd: cost?.invoiceUsd, effectiveUsd: cost?.effectiveUsd, breakdown: cost?.breakdown };
                    };
                    const before = bucketAmount(scalar[day]!);
                    const after = bucketAmount(scalar[end]!);
                    if (JSON.stringify(before) !== JSON.stringify(after)) {
                        console.info('Retained HEAD bucket amount change', { fixture: expect.getState().currentTestName,
                            seed: oracle?.seed, day, prefix: end + 1, before, after });
                    }
                }
                expect(compact[end]!.value.totals).toMatchObject({
                    eventCount: scalar[end]!.totals.eventCount, tokens: scalar[end]!.totals.tokens,
                    cost: { reportedUsd: scalar[end]!.totals.cost.reportedUsd },
                });
                const { ranked: _scalarRanked, ...scalarCoverage } = scalar[end]!.coverage ?? {};
                const { ranked: _compactRanked, ...compactCoverage } = compact[end]!.value.coverage ?? {};
                expect(compactCoverage).toEqual(scalarCoverage);
            }
            if (!singleSource) {
                const reasons = diagnostics.flatMap(([established, reason]) => established === day ? [reason] : []);
                const causalReasons = (values: readonly string[] | undefined) =>
                    [...values ?? []].filter(reason =>
                        reason === 'ambiguous_overlap' || reason === 'counter_discontinuity' || reason === 'missing_baseline').sort();
                expect(causalReasons(rangeRead.coverage?.reasons), `seed ${oracle?.seed}, diagnostic day ${day}`).toEqual([...new Set(reasons)].sort());
                expect(causalReasons(compact[day]!.days.get(at(day))?.coverage.coverageReasons)).toEqual([...new Set(reasons)].sort());
            }
        }
        if (!singleSource) expect(truth - admitted, `seed ${oracle?.seed}, final shortfall`).toBe(oracle?.acceptedResumeShortfall ?? 0);
    }

    it.each(['same thread', 'missing thread identity', 'unwitnessed counter reset'] as const)(
      'conserves dated Codex thread usage across scalar, compact and batch reads (%s)', async scenario => {
        const mixed = scenario === 'missing thread identity';
        const reset = scenario === 'unwitnessed counter reset';
        const account = await db.account.create({ data: { publicKey: 'dated-codex-usage' } });
        const dayOne = Date.UTC(2026, 6, 1);
        const dayTwo = Date.UTC(2026, 6, 2);
        const end = Date.UTC(2026, 6, 3);
        const fact = (path: 'runtime' | 'native', at: number, multiplier: number) => ({
            accountId: account.id,
            agentId: 'codex',
            source: path,
            observedAt: new Date(at),
            scope: path === 'runtime' ? 'turn_delta' : 'session_cumulative',
            isCumulative: path === 'native',
            inputTokens: 60 * multiplier,
            outputTokens: 40 * multiplier,
            reasoningTokens: 4 * multiplier,
            cacheReadTokens: 12 * multiplier,
            cacheWriteTokens: 2 * multiplier,
            totalTokens: 100 * multiplier,
            reportedCostUsd: 2 * multiplier,
            costSource: 'provider_reported',
            metadata: { usageAccounting: { path, nativeSessionKey: 'a'.repeat(64), status: 'available', historyComplete: true,
            } },
        });
        const request = (startMs: number, endMs: number, includeActivity = false) =>
            UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs, endMs }, includeSeries: !includeActivity,
                includeActivity, granularity: 'day', timeZoneOffsetMinutes: 0 });
        const full = request(dayOne, end);
        const historical = [request(dayOne, dayTwo), request(dayTwo, end)];
        const compact = [request(dayOne, dayTwo, true), request(dayTwo, end, true)];
        if (mixed) {
            await db.usageEvent.create({ data: { ...fact('runtime', dayOne + 200, 0.5),
                inputTokens: 48, outputTokens: 32, reasoningTokens: 3, cacheReadTokens: 9, cacheWriteTokens: 1,
                totalTokens: 80, reportedCostUsd: 1.6,
                metadata: { usageAccounting: { path: 'runtime', status: 'unknown', historyComplete: true } },
            } });
            const runtimeOnly = await queryUsageAnalytics(account.id, { ...historical[0]!, filters: { sources: ['runtime'] } });
            expect(runtimeOnly.totals.tokens.total).toBe(80);
            expect(runtimeOnly.coverage.status).toBe('unknown');
            expect(runtimeOnly.coverage.reasons).toEqual(expect.arrayContaining(['unknown_source', 'incomplete_history']));
        }
        await db.usageEvent.create({ data: fact('native', dayOne + 100, 1) });
        const compactRead = async (query: ReturnType<typeof request>) => {
            const demand = { contributionQueries: [], sessionQueries: [query] };
            const captured = await captureUsageAnalyticsBatch(account.id, [query], undefined, demand);
            const projected = await projectUsageAnalyticsBatch(captured, [query], false, true, undefined, demand);
            return { projected, days: captured.activitySummary?.days };
        };
        if (reset) await db.usageEvent.create({ data: fact('runtime', dayOne + 200, 0.1) });
        const firstDay = await queryUsageAnalytics(account.id, historical[0]!);
        const firstDayOperand = reset ? (await compactRead(compact[0]!)).days?.get(dayOne)?.coverage : undefined;
        await db.usageEvent.createMany({ data: reset ? [fact('native', dayTwo + 200, 0.4)] : mixed ? [{ ...fact('runtime', dayTwo + 100, 0.5),
            inputTokens: 6, outputTokens: 4, reasoningTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0,
            totalTokens: 10, reportedCostUsd: 0.2 }]
            : [fact('runtime', dayTwo + 100, 0.5), fact('native', dayTwo + 200, 1.5)] });
        const expected = mixed ? [
            { tokens: { input: 108, output: 72, reasoning: 7, cacheRead: 21, cacheWrite: 3, total: 180 }, cost: { reportedUsd: 3.6 } },
            { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { reportedUsd: 0 } },
        ] : reset ? [
            { tokens: { total: 100 }, cost: { reportedUsd: 2 } },
            { tokens: { total: 40 }, cost: { reportedUsd: 0.8 } },
        ] : [
            { tokens: { input: 60, output: 40, reasoning: 4, cacheRead: 12, cacheWrite: 2, total: 100 }, cost: { reportedUsd: 2 } },
            { tokens: { input: 30, output: 20, reasoning: 2, cacheRead: 6, cacheWrite: 1, total: 50 }, cost: { reportedUsd: 1 } },
        ];
        const scalar = await queryUsageAnalytics(account.id, full);
        expect(scalar.totals).toMatchObject({
            tokens: { total: reset ? 140 : mixed ? 180 : 150 }, cost: { reportedUsd: reset ? 2.8 : mixed ? 3.6 : 3 },
        });
        expect(scalar.series).toMatchObject(expected);
        if (reset) {
            expect(firstDay.coverage.reasons).not.toContain('counter_discontinuity');
            expect(scalar.coverage.reasons).toContain('counter_discontinuity');
            expect(firstDayOperand).toBeDefined();
            const longer = await compactRead(request(dayOne, end, true));
            expect(longer.days?.get(dayOne)?.coverage).toEqual(firstDayOperand);
            expect(longer.days?.get(dayTwo)?.coverage.coverageReasons).toContain('counter_discontinuity');
        }
        if (mixed) {
            expect(firstDay.coverage.status).toBe('partial');
            expect(firstDay.coverage.reasons).toEqual(expect.arrayContaining(['unknown_source', 'incomplete_history']));
            expect(scalar.coverage.reasons).toEqual(expect.arrayContaining(['unknown_source', 'incomplete_history']));
        }
        const historicalCoverage = [];
        for (const [index, query] of historical.entries()) {
            const result = await queryUsageAnalytics(account.id, query);
            expect(result.totals).toMatchObject(expected[index]);
            if (index === 0) expect(result.coverage).toEqual(firstDay.coverage);
            else if (reset) expect(result.coverage.reasons).toContain('counter_discontinuity');
            historicalCoverage.push(result.coverage);
        }
        const batch = await captureUsageAnalyticsBatch(account.id, [full, ...historical]);
        const projected = await projectUsageAnalyticsBatch(batch, [full, ...historical], true);
        expect(projected.results[0]).toMatchObject({ value: { series: expected } });
        expect(projected.results.slice(1)).toMatchObject(expected.map((totals, index) => ({
            value: { totals, coverage: historicalCoverage[index] },
        })));
        for (const [index, query] of compact.entries()) {
            const { projected } = await compactRead(query);
            expect(projected.results[0]).toMatchObject({ value: { totals: expected[index], coverage: historicalCoverage[index] } });
        }
    });

    it.each([
        ['cumulative runtime-first', 'cumulative', false],
        ['cumulative native-first (unlinked native rows are outside Session totals)', 'cumulative', true],
        ['exact runtime-first', 'exact', false],
        ['exact native-first (unlinked native rows are outside Session totals)', 'exact', true],
        ['keeps an unpublished native response', 'exact', false],
        ['keeps a runtime-only response', 'exact', false],
        ['keeps a restarted native counter', 'cumulative', false],
        ['old producer without identity keeps the known doubled totals', 'cumulative', false],
        ['keeps other Sessions, Agents, Machines and Accounts separate', 'exact', false],
    ] as const)('counts one Codex response across first consent: %s', async (scenario, recorder, nativeFirst) => {
        const account = await db.account.create({ data: { publicKey: 'codex-usage-consent-account' } });
        const machine = await db.machine.create({ data: { id: 'codex-usage-consent-machine', accountId: account.id, metadata: '{}' } });
        const session = await db.session.create({ data: { id: 'actual-happier-session', accountId: account.id, tag: 'codex-usage-consent', encryptionMode: 'plain', metadata: '{}' } });

        await withCodexNativeAttachFixture(async fixture => {
            const native = await fixture.openConfiguredSession();
            const agent = { pluginId: 'happier.agent.codex', localId: 'codex' };
            const authority = { serverId: 'home', accountId: account.id, machineId: machine.id };
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(fixture.directory, 'device.key') });
            const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: fixture.directory } });
            const source = { kind: 'codexHome', home: 'user', homePath: fixture.directory };
            const descriptor = { agent, source, root: fixture.directory, sourceKey: fixture.directory, supported: true };
            const nativeThread = 'fresh-thread';
            const turn = 'provider-turn-1';
            const response = 'provider-response';
            const nextResponse = 'next-provider-response';
            const total = 10_841;
            const second = 177;
            const extraNative = scenario === 'keeps an unpublished native response';
            const extraRuntime = scenario === 'keeps a runtime-only response';
            const reset = scenario === 'keeps a restarted native counter';
            const oldProducer = scenario === 'old producer without identity keeps the known doubled totals';
            const otherScope = scenario === 'keeps other Sessions, Agents, Machines and Accounts separate';
            const runtimeCounters = { inputTokens: 10_800, outputTokens: 41, totalTokens: total,
                cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 };
            const recorderCounters = { input_tokens: 10_800, output_tokens: 41, total_tokens: total,
                cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 };
            const recordedAt = Date.now();
            const nativeExtraCounters = { input_tokens: second - 1, output_tokens: 1, total_tokens: second,
                cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 };
            const rollout = join(fixture.directory, 'sessions');
            await mkdir(rollout, { recursive: true });
            const records = [
                { type: 'session_meta', payload: { id: nativeThread } },
                { type: 'turn_context', payload: { turn_id: turn, model: 'gpt-5' } },
                recorder === 'exact' ? { type: 'token_usage_record', payload: {
                    thread_id: nativeThread, response_id: response, turn_id: turn, usage: recorderCounters,
                } } : { type: 'event_msg', payload: { type: 'token_count', info: {
                    total_token_usage: recorderCounters, last_token_usage: recorderCounters,
                } } },
            ];
            if (extraNative) records.push({ type: 'token_usage_record', payload: {
                thread_id: nativeThread, response_id: nextResponse, turn_id: turn, usage: nativeExtraCounters,
            } });
            await writeFile(join(rollout, 'rollout.jsonl'), records.map((record, index) =>
                JSON.stringify({ ...record, timestamp: new Date(recordedAt + index).toISOString() }) + '\n').join(''));
            const query = (filters?: { agentIds?: string[]; sources?: string[]; sessionIds?: string[] }) =>
                queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({ filters }));
            const nativeFilters = { sources: ['codex-native-accounting'] };
            const writes: Array<ReturnType<typeof recordUsageEvent>> = [];
            const wire: Array<ReturnType<typeof UsageEventIngestRequestSchema.parse>> = [];
            const nativeWire: Array<ReturnType<typeof UsageEventIngestRequestSchema.parse>> = [];
            const operations = createNativeAgentSessionOperations(native, session.id, undefined, undefined, {
                provider: 'codex',
                async resolveAccountingWitness(nativeSessionId) {
                    return { authority, storage, agent, nativeSessionId,
                        ...(nativeFirst ? { sourceKey: descriptor.sourceKey } : {}) };
                },
                publish(input) {
                    const request = UsageEventIngestRequestSchema.parse(
                        buildUsageEventIngestRequest({ ...input, sessionId: session.id, machineId: machine.id }));
                    if (oldProducer && request.metadata) {
                        const { nativeSessionKey: _session, responseKey: _response,
                            ...accounting } = readUsageAccountingMetadata(request.metadata)!;
                        request.metadata.usageAccounting = { ...accounting, nativeSessionId: nativeThread,
                            ...(request.scope === 'turn_delta' ? { inferenceId: response } : {}) };
                    }
                    wire.push(request);
                    writes.push(recordUsageEvent(account.id, request));
                },
            }, undefined, undefined, {
                context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
                cwd: fixture.directory, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
            });
            const collector = createNativeUsageCollector({
                authority, storage, store: createNativeUsageCaptureStore({ authority, storage, path: join(fixture.directory, 'capture.sealed') }),
                budgetRegistry: new ExecutionBudgetRegistry(),
                discoverSources: async () => [descriptor],
                resolveRoot: async () => descriptor,
                async readAccounting(capture, signal) {
                    return await contribution.readAccounting!({ source: capture.source, cursor: capture.cursor, signal });
                },
                subscribeSource: async () => ({ dispose() {} }),
                publisher: {
                    async publish(input) {
                        const request = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({
                            ...input, observedAt: input.observedAt ?? Date.now(),
                        }));
                        if (oldProducer && request.accounting) {
                            const { nativeSessionKey: _session, responseKey: _response, ...evidence } = request.accounting;
                            request.accounting = evidence;
                        }
                        nativeWire.push(request);
                        const result = await recordUsageEvent(account.id, request);
                        return { status: result.ok ? 'sent' : 'failed' };
                    },
                },
                async deleteHistory(capture, dateRange) {
                    const result = await deleteNativeUsageHistory(account.id, { machineId: machine.id, sourceRootKey: capture.sourceId, dateRange });
                    if (!result.ok) throw new Error('Native capture delete was refused');
                    return { success: true, deletedEventCount: result.deletedEventCount };
                },
            });
            const unsubscribe = operations.subscribeRuntimeEvents(() => undefined);
            try {
                const [capture] = await collector.discover();
                expect((await query(nativeFilters)).totals.tokens.total ?? 0).toBe(0);
                async function consent() {
                    await collector.setConsent(capture.sourceId, true);
                    await collector.flushPending();
                    expect(await db.usageEvent.count({ where: { accountId: account.id, source: 'codex-native-accounting' } })).toBe(extraNative || reset ? 2 : 1);
                }
                if (nativeFirst) {
                    await consent();
                    expect((await query()).totals.tokens.total).toBe(total);
                }
                await operations.sendTurnPrompt('one real Codex response', { turnId: 'host-turn', localId: 'input' });
                fixture.emitNotification('rawResponse/completed', { threadId: nativeThread, turnId: turn,
                    responseId: response, usage: runtimeCounters, usageMetadata: null });
                const runtimeSecond = { inputTokens: second - 1, outputTokens: 1, totalTokens: second,
                    cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 };
                if (extraRuntime) fixture.emitNotification('rawResponse/completed', { threadId: nativeThread, turnId: turn,
                    responseId: nextResponse, usage: runtimeSecond, usageMetadata: null });
                const measured = extraRuntime
                    ? { ...runtimeCounters, inputTokens: runtimeCounters.inputTokens + runtimeSecond.inputTokens,
                        outputTokens: runtimeCounters.outputTokens + runtimeSecond.outputTokens, totalTokens: total + second }
                    : runtimeCounters;
                fixture.emitNotification('thread/tokenUsage/updated', { threadId: nativeThread, turnId: turn,
                    tokenUsage: { total: measured, last: extraRuntime ? runtimeSecond : runtimeCounters, modelContextWindow: 200_000 } });
                await expect.poll(() => writes.length).toBe(extraRuntime ? 3 : 2);
                expect((await Promise.all(writes)).every(result => result.ok)).toBe(true);
                const runtimeFact = await db.usageEvent.findFirstOrThrow({ where: { accountId: account.id, sessionId: session.id, source: 'codex-app-server-response-usage' } });
                const runtimeFilters = { sessionIds: [session.id] };
                const runtimeTotal = total + (extraRuntime ? second : 0);
                const runtimeUsage = await query(runtimeFilters);
                expect(runtimeUsage.totals.tokens.total).toBe(runtimeTotal);
                if (nativeFirst) {
                    // A capture preceding any verified link stays outside this Session.
                    expect(await db.usageEvent.count({ where: { accountId: account.id,
                        source: 'codex-native-accounting', sessionId: null } })).toBe(1);
                    expect((await query({ ...runtimeFilters, sources: ['codex-native-accounting'] })).totals.tokens.total).toBe(0);
                    const demands = [
                        UsageAnalyticsQueryRequestSchema.parse({}),
                        UsageAnalyticsQueryRequestSchema.parse({ filters: runtimeFilters }),
                    ];
                    const captured = await captureUsageAnalyticsBatch(account.id, demands);
                    const batch = await projectUsageAnalyticsBatch(captured, demands, false);
                    expect(batch.results).toMatchObject(demands.map(() => ({ value: { totals: { tokens: { total: runtimeTotal } } } })));
                }
                let captureEnd = recordedAt + records.length;
                if (reset) {
                    captureEnd = Math.max(...wire.map(request => request.observedAt)) + 10;
                    const restarted = [
                        { type: 'session_meta', payload: { id: nativeThread } },
                        { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: nativeExtraCounters } } },
                    ];
                    await writeFile(join(rollout, 'rollout-after-reset.jsonl'), restarted.map((record, index) =>
                        JSON.stringify({ ...record, timestamp: new Date(captureEnd - restarted.length + index).toISOString() }) + '\n').join(''));
                }
                if (!nativeFirst) {
                    expect((await query()).totals.tokens.total).toBe(runtimeTotal);
                    expect((await query(nativeFilters)).totals.tokens.total ?? 0).toBe(0);
                    await consent();
                }
                if (scenario === 'cumulative runtime-first') {
                    expect(nativeWire[0]!.observedAt).toBeLessThan(wire.find(request => request.scope === 'turn_delta')!.observedAt);
                }
                if (otherScope) {
                    const exact = wire.find(request => request.scope === 'turn_delta')!;
                    const accounting = readUsageAccountingMetadata(exact.metadata)!;
                    const identity = { authority, agent, nativeSessionId: nativeThread, inferenceId: response };
                    const otherDevice = await readOrCreateDeviceLocalSecretStorage({ path: join(fixture.directory, 'other-device.key') });
                    const otherKeys = deriveNativeUsageOverlapIdentity({ ...identity, storage: otherDevice });
                    expect(Boolean(accounting.nativeSessionKey && accounting.responseKey)).toBe(true);
                    expect(JSON.stringify(exact).includes(nativeThread)).toBe(false);
                    expect(JSON.stringify(exact).includes(response)).toBe(false);
                    expect(JSON.stringify(exact).includes(fixture.directory)).toBe(false);
                    expect(nativeWire[0]?.accounting?.nativeSessionKey === accounting.nativeSessionKey).toBe(true);
                    expect(nativeWire[0]?.accounting?.responseKey === accounting.responseKey).toBe(true);
                    expect(JSON.stringify(nativeWire[0]).includes(nativeThread)).toBe(false);
                    expect(JSON.stringify(nativeWire[0]).includes(fixture.directory)).toBe(false);
                    expect(accounting.nativeSessionKey === otherKeys.nativeSessionKey).toBe(false);
                    expect(accounting.responseKey === otherKeys.responseKey).toBe(false);
                    expect(exact.externalKey === accounting.responseKey).toBe(true);
                    expect(exact.externalKey === otherKeys.responseKey).toBe(false);

                    const otherSession = await db.session.create({ data: { accountId: account.id, tag: 'other-native-thread',
                        encryptionMode: 'plain', metadata: '{}' } });
                    const otherThreadKeys = deriveNativeUsageOverlapIdentity({ ...identity, storage, nativeSessionId: 'independent-native-thread' });
                    const otherMachine = await db.machine.create({ data: { id: 'independent-machine',
                        accountId: account.id, metadata: '{}' } });
                    const otherAccount = await db.account.create({ data: { publicKey: 'independent-account' } });
                    const otherAccountSession = await db.session.create({ data: { accountId: otherAccount.id, tag: 'independent',
                        encryptionMode: 'plain', metadata: '{}' } });
                    const otherAccountMachine = await db.machine.create({ data: { id: 'independent-account-machine',
                        accountId: otherAccount.id, metadata: '{}' } });
                    const otherWrites = await Promise.all([
                        recordUsageEvent(account.id, { ...exact, sessionId: otherSession.id,
                            metadata: { ...exact.metadata, usageAccounting: { ...accounting, ...otherThreadKeys } } }),
                        recordUsageEvent(account.id, { ...exact, machineId: otherMachine.id }),
                        recordUsageEvent(account.id, { ...exact, agentId: 'happier.agent.fixture/codex' }),
                        recordUsageEvent(otherAccount.id, { ...exact, sessionId: otherAccountSession.id, machineId: otherAccountMachine.id }),
                    ]);
                    expect(otherWrites.every(result => result.ok && result.event.id !== runtimeFact.id)).toBe(true);
                    expect((await query()).totals.tokens.total).toBe(4 * total);
                    expect((await query({ sessionIds: [otherSession.id] })).totals.tokens.total).toBe(total);
                    const otherTotals = await queryUsageAnalytics(otherAccount.id, UsageAnalyticsQueryRequestSchema.parse({}));
                    expect(otherTotals.totals.tokens.total).toBe(total);
                }
                const combined = await query();
                const codexOnly = await query({ agentIds: ['codex'] });
                await collector.stop(capture.sourceId);
                const deleted = await collector.deleteHistory(capture.sourceId, { startMs: recordedAt, endMs: captureEnd });
                expect(deleted).toMatchObject({ success: true, deletedEventCount: extraNative || reset ? 2 : 1 });
                expect(await db.usageEvent.count({ where: { accountId: account.id, id: runtimeFact.id, sessionId: session.id } })).toBe(1);
                expect(await db.usageEvent.count({ where: { accountId: account.id, source: 'codex-native-accounting' } })).toBe(0);
                expect((await query(runtimeFilters)).totals.tokens.total).toBe(runtimeTotal + (otherScope ? 2 * total : 0));
                expect((await query()).totals.tokens.total).toBe(runtimeTotal + (otherScope ? 3 * total : 0));
                const expected = oldProducer ? 2 * total : runtimeTotal + (extraNative || reset ? second : 0);
                expect(combined.totals.tokens.total).toBe(expected + (otherScope ? 3 * total : 0));
                expect(codexOnly.totals.tokens.total).toBe(expected + (otherScope ? 2 * total : 0));
                if (!oldProducer && !reset && !otherScope && !extraNative && !extraRuntime) {
                    expect(runtimeUsage.totals.cost.estimatedUsd).toBeGreaterThan(0);
                    expect(combined.totals.cost.estimatedUsd).toBeCloseTo(runtimeUsage.totals.cost.estimatedUsd!, 10);
                }
                if (recorder === 'cumulative' && !nativeFirst && !oldProducer && !reset) {
                    // Re-consent honors the retired cursor. A newly discovered
                    // rollout re-admits the same historical native checkpoint.
                    await writeFile(join(rollout, 'rollout-backfill.jsonl'), records.map((record, index) =>
                        JSON.stringify({ ...record, timestamp: new Date(recordedAt + index).toISOString() }) + '\n').join(''));
                    await consent();
                    const restored = await query();
                    expect(restored.totals.tokens.total).toBe(total);
                    expect(restored.totals.cost.estimatedUsd).toBeCloseTo(runtimeUsage.totals.cost.estimatedUsd!, 10);
                    expect(await db.usageEvent.count({ where: { accountId: account.id, id: runtimeFact.id, sessionId: session.id } })).toBe(1);
                }
            } finally {
                unsubscribe();
                await operations.resetOrDisposeRuntime();
                await collector.dispose();
            }
        }, { threadStartModel: 'gpt-5' });
    });

    it.each(['inference', 'session only', 'root resolved and restarted'] as const)(
      'keeps runtime publication opaque and cumulative (%s)', async scenario => {
        const withInference = scenario === 'inference';
        const resolvesRoot = scenario === 'root resolved and restarted';
        const provider = resolvesRoot ? 'pi' : 'muse';
        const account = await db.account.create({ data: { publicKey: 'opaque-runtime-usage-account' } });
        const machine = await db.machine.create({ data: { id: 'opaque-runtime-usage-machine', accountId: account.id, metadata: '{}' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'opaque-runtime-usage',
            encryptionMode: 'plain', metadata: '{}' } });
        const directory = await mkdtemp(join(tmpdir(), 'happier-opaque-runtime-usage-'));
        const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
        const authority = { serverId: 'home', accountId: account.id, machineId: machine.id };
        const agent = resolvesRoot ? { pluginId: 'happier.agent.pi', localId: 'pi' }
            : { pluginId: 'happier.agent.muse', localId: 'muse' };
        const rawSession = 'private-provider-session-fixture';
        let sourceKey: string | undefined;
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const native: AgentSessionRuntime = {
            send: async () => ({ status: 'admitted' }),
            watch(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            async dispose() {},
        };
        const writes: Array<ReturnType<typeof recordUsageEvent>> = [];
        const wire: Array<ReturnType<typeof UsageEventIngestRequestSchema.parse>> = [];
        const createObserver = () => createNativeAgentSessionOperations(native, session.id, undefined, undefined, {
            provider,
            resolveAccountingWitness: async nativeSessionId => ({ authority, storage, agent, nativeSessionId, sourceKey }),
            publish(input) {
                const request = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({
                    ...input, sessionId: session.id, machineId: machine.id,
                }));
                wire.push(request);
                writes.push(recordUsageEvent(account.id, request));
            },
        }, undefined, undefined, {
            context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
            cwd: directory, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
        });
        let operations = createObserver();
        let unsubscribe = operations.subscribeRuntimeEvents(() => undefined);
        try {
            const started = Date.now();
            for (const [index, total] of (resolvesRoot ? [10, 25, 40] : [10, 25]).entries()) {
                if (resolvesRoot && index === 1) sourceKey = 'configured-capture-source';
                if (resolvesRoot && index === 2) {
                    unsubscribe();
                    await operations.resetOrDisposeRuntime('runtime_recovery');
                    operations = createObserver();
                    unsubscribe = operations.subscribeRuntimeEvents(() => undefined);
                }
                const rawInference = 'private-provider-inference-fixture';
                const event: AgentSessionRuntimeEvent = { kind: 'usage-observed', sessionId: session.id,
                    sequence: index + 1, emittedAtMs: started + index, scope: 'session_cumulative',
                    source: resolvesRoot ? 'pi-session-stats' : 'muse-runtime-usage',
                    observationId: `${rawSession}:${index}:${withInference ? rawInference : 'counter'}`,
                    accounting: { nativeSessionId: rawSession, ...(withInference ? { inferenceId: rawInference } : {}) },
                    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total },
                };
                for (const listener of listeners) listener(event);
                await expect.poll(() => writes.length).toBe(index + 1);
                expect(await writes[index]).toMatchObject({ ok: true });
                const result = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({}));
                expect(result.totals.tokens.total).toBe(total);
            }

            const first = readUsageAccountingMetadata(wire[0].metadata);
            const second = readUsageAccountingMetadata(wire[1].metadata);
            expect(first?.nativeSessionId).toEqual(expect.any(String));
            expect(second?.nativeSessionId).toBe(first?.nativeSessionId);
            if (withInference) expect(first?.inferenceId).toEqual(expect.any(String));
            else expect(first?.inferenceId).toBeUndefined();
            expect(second?.inferenceId).toBe(first?.inferenceId);
            expect(wire[0].externalKey === wire[1].externalKey).toBe(false);
            expect(JSON.stringify(wire).includes(rawSession)).toBe(false);
            expect(JSON.stringify(wire).includes('private-provider-inference-')).toBe(false);
            if (resolvesRoot) {
                const stored = await db.usageEvent.findMany({ where: { accountId: account.id }, select: { metadata: true } });
                const storedSubjects = stored.map(row => readUsageAccountingMetadata(row.metadata)?.nativeSessionKey);
                expect(storedSubjects).toEqual(Array(3).fill(expect.any(String)));
                expect(new Set(storedSubjects).size).toBe(1);
            }
        } finally {
            unsubscribe();
            await operations.resetOrDisposeRuntime('runtime_recovery');
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.each(['one cumulative stream', 'two cumulative children', 'exact live delta', 'Muse exact live delta', 'OpenCode settled replay'] as const)(
        'keeps admitted totals when device custody is unavailable (%s)', async scenario => {
            const account = await db.account.create({ data: { publicKey: `runtime-custody-${scenario}` } });
            const machine = await db.machine.create({ data: { accountId: account.id, id: 'device-custody', metadata: '{}' } });
            const session = await db.session.create({ data: { accountId: account.id, tag: 'custody', encryptionMode: 'plain', metadata: '{}' } });
            const directory = await mkdtemp(join(tmpdir(), 'happier-runtime-custody-'));
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
            const authority = { serverId: 'home', accountId: account.id, machineId: machine.id };
            const replay = scenario === 'OpenCode settled replay';
            const provider = replay ? 'opencode' : 'muse';
            const agent = replay ? { pluginId: 'happier.agent.opencode', localId: 'opencode' }
                : { pluginId: 'happier.agent.muse', localId: 'muse' };
            const rawIds = scenario === 'two cumulative children' ? ['raw-child-a', 'raw-child-b'] : ['raw-child-a'];
            const museLive = scenario === 'Muse exact live delta';
            const live = scenario === 'exact live delta' || museLive;
            const exact = live || replay;
            let custody = false;
            let sequence = 0;
            const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
            const native: AgentSessionRuntime = {
                send: async () => ({ status: 'admitted' }),
                watch(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
                async dispose() {},
            };
            const writes: Array<ReturnType<typeof recordUsageEvent>> = [];
            const wire: Array<ReturnType<typeof UsageEventIngestRequestSchema.parse>> = [];
            const createObserver = () => createNativeAgentSessionOperations(native, session.id, undefined, undefined, {
                provider,
                resolveAccountingWitness: async nativeSessionId => {
                    if (!custody) throw new Error('Device fixture unavailable');
                    return { authority, storage, agent, nativeSessionId };
                },
                publish(input) {
                    const request = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({
                        ...input, sessionId: session.id, machineId: machine.id,
                    }));
                    wire.push(request);
                    writes.push(recordUsageEvent(account.id, request));
                },
            }, undefined, undefined, {
                context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
                cwd: directory, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
            });
            let operations = createObserver();
            let unsubscribe = operations.subscribeRuntimeEvents(() => undefined);
            const emit = (event: AgentSessionRuntimeEvent) => { for (const listener of listeners) listener(event); };
            const emitMuse = (nativeSessionId: string, total: number) => {
                emit({ kind: 'usage-observed', sessionId: session.id,
                    sequence: ++sequence, emittedAtMs: Date.now() + sequence,
                    scope: exact ? 'turn_delta' : 'session_cumulative',
                    source: 'muse-native-accounting',
                    observationId: museLive ? `${nativeSessionId}:session/tokenUsage:raw-custody-inference`
                        : `${nativeSessionId}:raw-custody-inference:${sequence}`,
                    accounting: { nativeSessionId, ...(!live || museLive ? { inferenceId: 'raw-custody-inference' } : {}) },
                    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total },
                });
            };
            const presentOpenCode = async (fromHistory: boolean) => {
                const providerSessionId = rawIds[0]!;
                const info = { id: 'raw-custody-inference', sessionID: providerSessionId, role: 'assistant', finish: 'stop',
                    time: { created: 100, completed: 200 }, modelID: 'test-model',
                    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 12 } };
                const signal = new AbortController().signal;
                const noop = () => undefined;
                // Only OpenCode's HTTP and host services are fixture boundaries.
                const client = {
                    sessionUpdatePermissions: async () => undefined,
                    agentsList: async () => [],
                    sessionReadAgent: async () => null,
                    sessionMessages: async () => fromHistory ? [{ info, parts: [] }] : [],
                    subscribeGlobalEvents: async ({ signal }) => new Promise<void>(resolve =>
                        signal.addEventListener('abort', () => resolve(), { once: true })),
                } satisfies Partial<OpenCodeServerClient>;
                const controller = createOpenCodeServerRuntime({
                    ctx: {
                        abort: { signal, compose: signals => AbortSignal.any(signals) },
                        logger: { debug: noop, info: noop, warn: noop, error: noop },
                        sessions: { current: { permissions: { requestDecision: async () => ({ status: 'cancelled' }) } },
                            writeStateField: async () => undefined },
                        storage: { daemonSession: { get: async () => undefined, set: async () => undefined } },
                        config: { values: {} }, env: { list: () => ({}) },
                        exec: { systemTools: { resolve: async () => { throw new Error('Provider launch is outside the test'); } } },
                        managedServices: { dependencies: {} as never,
                            supervise: async () => { throw new Error('Provider launch is outside the test'); } },
                        ui: { askQuestions: async () => { throw new Error('Unexpected provider question'); } },
                        experimental: { telemetry: { emit: noop } },
                    },
                    directory, happierSessionId: session.id, providerModelId: 'test-model',
                    client: client as OpenCodeServerClient,
                    mcpRegistration: Promise.resolve({ requiredHappier: { status: 'ready' }, registeredServers: [] }),
                    mcpProjection: { registrations: [], requiredHappierServerName: null, requiredHappierConfigurationPresent: false },
                });
                const unwatch = controller.subscribeRuntimeEvents(event => {
                    if (event.kind === 'usage-observed') emit({ ...event, sessionId: session.id, sequence: ++sequence });
                });
                try {
                    await controller.openSession({ kind: 'resume', providerSessionId });
                    await controller.handleProviderEvent({ payload: fromHistory
                        ? { type: 'server.connected' }
                        : { type: 'message.updated', properties: { info } } });
                } finally {
                    unwatch();
                    await controller.resetOrDisposeRuntime();
                }
            };
            try {
                if (replay) await presentOpenCode(false);
                else for (const id of rawIds) emitMuse(id, 10);
                await new Promise<void>(resolve => setImmediate(resolve));
                if (replay) expect(wire).toHaveLength(0);
                if (replay) {
                    unsubscribe();
                    await operations.resetOrDisposeRuntime('runtime_recovery');
                    custody = true;
                    operations = createObserver();
                    unsubscribe = operations.subscribeRuntimeEvents(() => undefined);
                    await presentOpenCode(true);
                } else if (!exact) {
                    custody = true;
                    for (const id of rawIds) emitMuse(id, 25);
                }
                const expected = replay ? 12 : live ? 10 : 25;
                if (!live) await expect.poll(() => wire.length).toBe(rawIds.length);
                expect((await Promise.all(writes)).every(result => result.ok)).toBe(true);
                const result = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({}));
                expect(result.totals.tokens.total).toBe(expected * rawIds.length);
                expect(wire).toHaveLength(rawIds.length);
                expect(rawIds.some(id => JSON.stringify(wire).includes(id))).toBe(false);
                expect(JSON.stringify(wire).includes('raw-custody-inference')).toBe(false);
                const subjects = wire.map(row => readUsageAccountingMetadata(row.metadata)?.nativeSessionId);
                if (live) expect(subjects).toEqual([undefined]);
                else {
                    expect(subjects.every(subject => typeof subject === 'string')).toBe(true);
                    expect(new Set(subjects).size).toBe(rawIds.length);
                }
            } finally {
                unsubscribe();
                await operations.resetOrDisposeRuntime('runtime_recovery');
                await rm(directory, { recursive: true, force: true });
            }
        },
    );

    it.each(['healthy', 'response outage', 'response and snapshot outage'] as const)(
        'counts the Codex response and its cumulative presentation once (%s)', async scenario => {
        const account = await db.account.create({ data: { publicKey: 'codex-paired-runtime-usage' } });
        const machine = await db.machine.create({ data: { id: 'codex-paired-runtime-machine', accountId: account.id, metadata: '{}' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: 'codex-paired-runtime-usage', encryptionMode: 'plain', metadata: '{}',
        } });
        await withCodexNativeAttachFixture(async fixture => {
            const native = await fixture.openConfiguredSession();
            const authority = { serverId: 'home', accountId: account.id, machineId: machine.id };
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(fixture.directory, 'paired-usage-device.key') });
            const agent = { pluginId: 'happier.agent.codex', localId: 'codex' };
            let custody = scenario === 'healthy';
            const wire: Array<ReturnType<typeof UsageEventIngestRequestSchema.parse>> = [];
            const controlWire: typeof wire = [];
            const writes: Array<ReturnType<typeof recordUsageEvent>> = [];
            const seen: string[] = [];
            const publisher = {
                provider: 'codex',
                resolveAccountingWitness: async (nativeSessionId: string) => {
                    if (!custody) throw new Error('Device fixture unavailable');
                    return { authority, storage, agent, nativeSessionId };
                },
            };
            const toRequest = (input: Parameters<Parameters<typeof createNativeAgentSessionUsageObserver>[0]['publish']>[0]) =>
                UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({ ...input, sessionId: session.id, machineId: machine.id }));
            const observe = createNativeAgentSessionUsageObserver({
                ...publisher,
                publish(input) {
                    const request = toRequest(input);
                    wire.push(request);
                    writes.push(recordUsageEvent(account.id, request));
                },
            }, () => true, 'codex-paired-runtime-incarnation');
            const observeWithoutDeclaration = createNativeAgentSessionUsageObserver({
                ...publisher,
                publish(input) { controlWire.push(toRequest(input)); },
            }, () => true, 'codex-paired-runtime-incarnation');
            const subscription = native.watch(event => {
                if (event.kind !== 'usage-observed') return;
                observe(event, event.attribution);
                if (scenario === 'healthy') {
                    const { replayObservationId: _declaration, ...accounting } = event.accounting ?? {};
                    observeWithoutDeclaration({ ...event, accounting }, event.attribution);
                }
                seen.push(event.scope);
            });
            const query = UsageAnalyticsQueryRequestSchema.parse({});
            try {
                expect(await native.send({
                    inputIds: ['paired-input'],
                    input: { text: 'one paired response' },
                    delivery: { kind: 'newTurn', turnId: 'paired-turn' },
                })).toMatchObject({ status: 'admitted' });
                const response = { totalTokens: 10, inputTokens: 8, outputTokens: 2 };
                const sendSnapshot = () => fixture.emitNotification('thread/tokenUsage/updated', {
                    threadId: 'fresh-thread', turnId: 'provider-turn-1',
                    tokenUsage: { total: { totalTokens: 25, inputTokens: 19, outputTokens: 6 }, last: response },
                });
                fixture.emitNotification('rawResponse/completed', {
                    threadId: 'fresh-thread', turnId: 'provider-turn-1', responseId: 'paired-response', usage: response,
                });
                await expect.poll(() => seen.slice()).toEqual(['turn_delta']);
                if (scenario === 'response outage') custody = true;
                sendSnapshot();
                await expect.poll(() => seen.slice()).toEqual(['turn_delta', 'session_cumulative']);
                if (scenario === 'response and snapshot outage') {
                    const outageTotal = (await queryUsageAnalytics(account.id, query)).totals.tokens.total;
                    expect(outageTotal ?? 0).toBe(0);
                    expect(wire).toHaveLength(0);
                    custody = true;
                    sendSnapshot();
                    await expect.poll(() => seen.slice()).toEqual(['turn_delta', 'session_cumulative', 'session_cumulative']);
                }
                expect((await Promise.all(writes)).every(write => write.ok)).toBe(true);
                expect((await queryUsageAnalytics(account.id, query)).totals.tokens.total).toBe(25);
                const stored = await db.usageEvent.findMany({ where: { accountId: account.id },
                    select: { externalKey: true, scope: true, totalTokens: true, metadata: true },
                });
                if (scenario === 'healthy') {
                    expect(wire.map(row => row.scope)).toEqual(['turn_delta', 'session_cumulative']);
                    expect(JSON.stringify(wire) === JSON.stringify(controlWire)).toBe(true);
                    expect(stored.map(row => [row.scope, row.totalTokens]).sort()).toEqual([['session_cumulative', 25], ['turn_delta', 10]]);
                    expect(stored.every(row => wire.some(request => request.externalKey === row.externalKey))).toBe(true);
                    expect(stored.every(row => !JSON.stringify(row.metadata).includes('replayObservationId'))).toBe(true);
                } else {
                    expect(wire.map(row => row.scope)).toEqual(['session_cumulative']);
                    expect(stored.map(row => [row.scope, row.totalTokens])).toEqual([['session_cumulative', 25]]);
                }
            } finally {
                subscription.dispose();
                await native.dispose();
            }
        });
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
        const machine = await db.machine.create({ data: { id: 'exact-codex-machine', accountId: account.id,
            metadata: 'ciphertext' } });
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
                accountingWitness: {
                    authority: { serverId: 'home', accountId: account.id, machineId: machine.id },
                    storage: await readOrCreateDeviceLocalSecretStorage({ path: join(fixture.directory, 'usage-test-device.key') }),
                    agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    nativeSessionId: 'fresh-thread',
                },
                publish(input) {
                    const request = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({
                        ...input, sessionId: session.id, machineId: machine.id,
                    }));
                    if (delivery === 'reversed-same-clock') delayed.push(request);
                    else writes.push(recordUsageEvent(account.id, request));
                    published++;
                },
            }, undefined, undefined, {
                // The host invocation services are the external process boundary;
                // native JSON-RPC, host event admission, accounting and DB stay real.
                context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
                cwd: fixture.directory, connectedAccounts, capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
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
        const machine = await db.machine.create({ data: { id: `claude-scope-${subscriptionType}`,
            accountId: account.id, metadata: 'ciphertext' } });
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
            const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(startup.nativeHome.root, 'device.key') });
            const writes: Array<ReturnType<typeof recordUsageEvent>> = [];
            const operations = createNativeAgentSessionOperations(native, session.id, undefined, undefined, {
                provider: 'claude',
                accountingWitness: { storage, nativeSessionId: 'native-claude-session',
                    authority: { serverId: 'home', accountId: account.id, machineId: machine.id },
                    agent: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                publish(input) {
                    const request = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({
                        ...input, sessionId: session.id, machineId: machine.id,
                    }));
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
                cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } });
            const unsubscribe = operations.subscribeRuntimeEvents(() => undefined);
            try {
                await operations.sendTurnPrompt('reply ready', { localId: 'claude-input', turnId: 'claude-host-turn' });
                await exec.emit({ type: 'assistant', uuid: 'claude-record', session_id: 'native-claude-session',
                    message: { id: 'claude-inference', role: 'assistant', model: 'claude-haiku-4-5', content: [],
                        usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
                await exec.emit({ type: 'result', subtype: 'success', session_id: 'native-claude-session', total_cost_usd: 0.01,
                    modelUsage: { 'claude-haiku-4-5': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
                await expect.poll(() => writes.length).toBe(2);
                for (const result of await Promise.all(writes)) expect(result).toMatchObject({ ok: true });
                const privateResult = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({ filters: { sessionIds: [session.id] } }));
                expect(privateResult.totals.tokens.total).toBe(12);
                const publicResult = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({
                    filters: { sessionIds: [session.id] }, population: 'public_eligible_personal' }));
                const eligible = subscriptionType !== 'team' && subscriptionType !== 'enterprise';
                expect(publicResult.totals.tokens.total ?? 0).toBe(eligible ? 12 : 0);
                if (eligible) expect(publicResult.contributions).toEqual(expect.arrayContaining([expect.objectContaining({
                    turnId: 'claude-host-turn', providerAttribution: 'known', providerSource: 'native' })]));
                else expect(publicResult.contributions?.some(row => row.turnId !== null)).toBe(false);
            } finally { unsubscribe(); await operations.resetOrDisposeRuntime('runtime_recovery'); }
        } });
    });

    it.each([
        ['assistant', 'unbound-runtime-first'],
        ['result', 'unbound-runtime-first'],
        ['assistant', 'native-capture-first'],
        ['assistant', 'former-bound-key'],
        ['assistant', 'old-producer-without-declaration'],
        ['assistant', 'device-custody-outage'],
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
            async function observeSdk(resume: boolean, oldProducer: boolean, publicationStorage: typeof storage | null) {
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
                        if (!publicationStorage) throw new Error('Device fixture unavailable');
                        const localFile = await resolveClaudeJsonlSessionFile({ remoteSessionId, env: {},
                            source: { kind: 'claudeConfig', configDir: directory } });
                        return { ...witness, storage: publicationStorage, nativeSessionId: remoteSessionId,
                            sourceKey: localFile ? witness.sourceKey : undefined };
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
                            const { nativeSessionKey: _streamKey, responseKey: _responseKey, ...oldAccounting } = accounting;
                            request.metadata = { ...metadata, usageAccounting: { ...oldAccounting, nativeSessionId } };
                        }
                        writes.push({ request, result: recordUsageEvent(account.id, request) });
                    },
                }, undefined, undefined, { context, cwd: directory, connectedAccounts: [],
                    capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                    cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } });
                let observations = 0;
                const unsubscribe = operations.subscribeRuntimeEvents(event => { if (event.kind === 'usage-observed') observations++; });
                try {
                    await operations.sendTurnPrompt('reply ready', { localId: resume ? 'resumed-input' : 'first-input',
                        turnId: resume ? 'second-turn' : 'first-turn' });
                    await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledOnce());
                    await exec.emit(resume ? { ...replayed, isReplay: true } : replayed);
                    await expect.poll(() => observations).toBe(1);
                    if (!publicationStorage) {
                        await new Promise<void>(resolve => setImmediate(resolve));
                        expect(writes).toHaveLength(0);
                        return null;
                    }
                    await expect.poll(() => writes.length).toBe(1);
                    const result = await writes[0]!.result;
                    if (!result.ok) throw new Error('Usage observation was refused');
                    return { ...writes[0]!.request, eventId: result.event.id };
                } finally { unsubscribe(); await operations.resetOrDisposeRuntime('runtime_recovery'); }
            }

            async function publishFromSdk(resume: boolean, oldProducer = false, publicationStorage = storage) {
                const result = await observeSdk(resume, oldProducer, publicationStorage);
                if (!result) throw new Error('Expected an admitted usage observation');
                return result;
            }

            const storedRows = () => db.usageEvent.findMany({ where: { accountId: account.id },
                select: { id: true, metadata: true, totalTokens: true, observedAt: true, turnId: true } });
            if (scenario === 'device-custody-outage') {
                await observeSdk(false, false, null);
                expect(await storedRows()).toHaveLength(0);
                await exposeSource();
                await publishFromSdk(true);
                expect((await query()).totals.tokens.total).toBe(12);
                expect(await storedRows()).toHaveLength(1);
                return;
            }
            if (scenario === 'native-capture-first') {
                const native = deriveNativeUsageAccountingIdentity({ ...witness, nativeSessionId, inferenceId: 'claude-inference' });
                const first = await recordUsageEvent(account.id, UsageEventIngestRequestSchema.parse({
                    subject: { ...subject, sourceRootKey: native.sourceRootKey, nativeSessionKey: native.nativeSessionKey },
                    source: 'claude-assistant-usage', agentId: 'claude', observedAt: 100,
                    externalKey: native.externalKey, scope: 'turn_delta', isCumulative: false, modelId,
                    tokens: { input: 10, output: 2, reasoning: null, cacheRead: 0, cacheWrite: 0, total: 12 },
                    cost: { reportedUsd: null, estimatedUsd: null, currency: 'USD' },
                    accounting: { inferenceKey: native.externalKey, status: 'available',
                        ...deriveNativeUsageOverlapIdentity({ ...witness, nativeSessionId, inferenceId: 'claude-inference' }) },
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
            const firstNativeKey = readUsageAccountingMetadata(first.metadata)?.nativeSessionId;
            const replayNativeKey = readUsageAccountingMetadata(second.metadata)?.nativeSessionId;
            expect(/^[0-9a-f]{64}$/.test(firstNativeKey ?? '')).toBe(true);
            expect(firstNativeKey === nativeSessionId).toBe(false);
            expect(replayNativeKey === firstNativeKey).toBe(true);
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

            const otherStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'other-device.key') });
            const otherPublication = await publishFromSdk(true, false, otherStorage);
            const otherNativeKey = readUsageAccountingMetadata(otherPublication.metadata)?.nativeSessionId;
            expect(/^[0-9a-f]{64}$/.test(otherNativeKey ?? '')).toBe(true);
            expect(otherNativeKey === nativeSessionId).toBe(false);
            expect(otherNativeKey === firstNativeKey).toBe(false);
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
