import { describe, expect, it } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import { runMixedRealisticTraffic } from './mixedRealisticTraffic';

const baseConfig: StressConfig = {
    targetMode: 'full-compose',
    baseUrl: undefined,
    repeat: 1,
    seed: 42,
    flakeRetry: false,
    socketTransport: 'websocket',
    duration: {
        warmupMs: 0,
        durationMs: 1_000,
        cooldownMs: 0,
        soakMs: 0,
    },
    load: {
        users: 1,
        machinesPerUser: 1,
        sessionsPerUser: 1,
        rpcListenersPerUser: 1,
        rpcCallsPerSecond: 10,
        messagesPerSecond: 10,
        reconnectRate: 1,
        mixedSessionMode: 'representative',
        mixedSetupConcurrency: 1,
        mixedConnectConcurrency: 1,
    },
    orchestration: {
        rollingRestartEnabled: false,
        killTarget: 'none',
        expectedApiReplicas: 1,
        expectedWorkerReplicas: 1,
    },
    compose: {
        apiReplicas: 1,
        workerReplicas: 1,
        imageBuildStrategy: 'never',
        reuseRunningTopology: false,
        frontDoorMode: 'gateway',
        metricsEnabled: false,
        filesBackend: 's3',
    },
    artifacts: {
        saveArtifactsOnSuccess: false,
        metricsScrapeEnabled: false,
        keepTopologyOnFailure: false,
    },
};

describe('runMixedRealisticTraffic', () => {
    it('treats zero active sessions as a no-op workload instead of crashing the message loop', async () => {
        await expect(runMixedRealisticTraffic({
            baseUrl: 'http://gateway:8080',
            controlPlaneBaseUrl: 'http://api:53288',
            config: baseConfig,
            workload: {
                sessionCount: 1,
                activeSessionCount: 0,
                sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
                sessionPlanCount: 1,
                rpcListenerCount: 1,
                rpcReadinessProbeCount: 1,
                messageCount: 10,
                streamSegmentCount: 5,
                reconnectCycles: 3,
                verificationSessionCount: 0,
                presencePulseCollectorCount: 0,
            },
            userDevices: [],
            sessions: [{
                sessionId: 'session-1',
                authIndex: 0,
            }],
            machineCollectors: [],
            verificationSessionIds: [],
            verificationSessionTokensBySessionId: new Map(),
            expectedLocalIdsBySession: new Map(),
        })).resolves.toEqual({
            listeners: [],
            rpcReadinessLedger: [],
            ackLatencies: [],
            rpcLatencies: [],
            streamDispatchLatencies: [],
            duplicateLocalIds: 0,
            messageAckFailures: 0,
            rpcFailures: 0,
            reconnectFailures: 0,
            reconnectsTriggered: 0,
            rpcCalls: 0,
            streamSegmentsSent: 0,
            stageDurationsMs: {
                connectMs: 0,
                trafficMs: 0,
                verificationMs: 0,
            },
        });
    });
});
