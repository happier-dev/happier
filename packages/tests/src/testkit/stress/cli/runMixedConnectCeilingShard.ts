import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { StressConfig } from '../config/stressScenarioSchema';
import {
    runMixedConnectCeilingShardWork,
    type MixedConnectCeilingShardProgressSnapshot,
} from '../scenarios/runMixedConnectCeilingShardWork';
import type { MixedConnectCeilingShardResult } from '../scenarios/runMixedConnectCeilingScenario';

type MixedConnectCeilingShardRequest = Readonly<{
    baseUrl: string;
    controlPlaneBaseUrl?: string;
    config: StressConfig;
    shardPlan: {
        shardIndex: number;
        authIndexStart: number;
        userCount: number;
        mixedSetupConcurrency: number;
        mixedConnectConcurrency: number;
    };
    outputPath: string;
    progressPath?: string;
}>;

type RunMixedConnectCeilingShardCliDeps = Readonly<{
    readFileSync: typeof readFileSync;
    writeFileSync: typeof writeFileSync;
    runMixedConnectCeilingShardWork: typeof runMixedConnectCeilingShardWork;
    processStderrWrite: (message: string) => void;
}>;

const defaultDeps: RunMixedConnectCeilingShardCliDeps = {
    readFileSync,
    writeFileSync,
    runMixedConnectCeilingShardWork,
    processStderrWrite: (message) => {
        process.stderr.write(message);
    },
};

function writeShardResult(params: {
    outputPath: string;
    result: MixedConnectCeilingShardResult;
    writeFileSync: typeof writeFileSync;
}): void {
    params.writeFileSync(params.outputPath, `${JSON.stringify(params.result, null, 2)}\n`, 'utf8');
}

function writeShardProgressSnapshot(params: {
    progressPath: string;
    snapshot: MixedConnectCeilingShardProgressSnapshot;
    writeFileSync: typeof writeFileSync;
}): void {
    params.writeFileSync(params.progressPath, `${JSON.stringify(params.snapshot, null, 2)}\n`, 'utf8');
}

function readShardRequest(params: {
    requestPath: string;
    readFileSync: typeof readFileSync;
}): MixedConnectCeilingShardRequest {
    return JSON.parse(params.readFileSync(params.requestPath, 'utf8')) as MixedConnectCeilingShardRequest;
}

function resolvePartialResult(error: unknown): MixedConnectCeilingShardResult | undefined {
    if (!(error instanceof Error) || !('partialResult' in error)) {
        return undefined;
    }
    return (error as Error & { partialResult?: MixedConnectCeilingShardResult }).partialResult;
}

export async function runMixedConnectCeilingShardCli(
    args: readonly string[],
    deps: RunMixedConnectCeilingShardCliDeps = defaultDeps,
): Promise<void> {
    const requestPath = args[0];
    if (!requestPath) {
        throw new Error('Usage: runMixedConnectCeilingShard.ts <request.json>');
    }

    const request = readShardRequest({
        requestPath,
        readFileSync: deps.readFileSync,
    });

    try {
        const result = await deps.runMixedConnectCeilingShardWork({
            baseUrl: request.baseUrl,
            controlPlaneBaseUrl: request.controlPlaneBaseUrl,
            authIndexStart: request.shardPlan.authIndexStart,
            shardIndex: request.shardPlan.shardIndex,
            onProgress: async (snapshot) => {
                if (request.progressPath) {
                    writeShardProgressSnapshot({
                        progressPath: request.progressPath,
                        snapshot,
                        writeFileSync: deps.writeFileSync,
                    });
                }
            },
            config: {
                ...request.config,
                load: {
                    ...request.config.load,
                    users: request.shardPlan.userCount,
                    mixedSetupConcurrency: request.shardPlan.mixedSetupConcurrency,
                    mixedConnectConcurrency: request.shardPlan.mixedConnectConcurrency,
                    mixedRunnerShards: 1,
                },
            },
        });

        writeShardResult({
            outputPath: request.outputPath,
            result,
            writeFileSync: deps.writeFileSync,
        });
    } catch (error) {
        const partialResult = resolvePartialResult(error);
        if (partialResult) {
            writeShardResult({
                outputPath: request.outputPath,
                result: partialResult,
                writeFileSync: deps.writeFileSync,
            });
        }
        throw error;
    }
}

const invokedPath = process.argv[1];
if (invokedPath && basename(invokedPath) === 'runMixedConnectCeilingShard.ts') {
    void runMixedConnectCeilingShardCli(process.argv.slice(2)).catch((error: unknown) => {
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
        defaultDeps.processStderrWrite(`${message}\n`);
        process.exit(1);
    });
}
