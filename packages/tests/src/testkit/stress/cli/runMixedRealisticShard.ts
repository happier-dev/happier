import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { StressConfig } from '../config/stressScenarioSchema';
import type {
    MixedRealisticShardProgressSnapshot,
    MixedRealisticShardResult,
} from '../scenarios/runMixedRealisticShardWork';
import { runMixedRealisticShardWork } from '../scenarios/runMixedRealisticShardWork';

type MixedRealisticShardRequest = Readonly<{
    baseUrl: string;
    controlPlaneBaseUrl?: string;
    controlPlaneBaseUrls?: readonly string[];
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

type RunMixedRealisticShardCliDeps = Readonly<{
    readFileSync: typeof readFileSync;
    writeFileSync: typeof writeFileSync;
    runMixedRealisticShardWork: typeof runMixedRealisticShardWork;
    processStderrWrite: (message: string) => void;
}>;

const defaultDeps: RunMixedRealisticShardCliDeps = {
    readFileSync,
    writeFileSync,
    runMixedRealisticShardWork,
    processStderrWrite: (message) => {
        process.stderr.write(message);
    },
};

function writeShardResult(params: {
    outputPath: string;
    result: MixedRealisticShardResult;
    writeFileSync: typeof writeFileSync;
}): void {
    params.writeFileSync(params.outputPath, `${JSON.stringify(params.result, null, 2)}\n`, 'utf8');
}

function writeShardProgressSnapshots(params: {
    progressPath: string;
    snapshots: readonly MixedRealisticShardProgressSnapshot[];
    writeFileSync: typeof writeFileSync;
}): void {
    params.writeFileSync(params.progressPath, `${JSON.stringify(params.snapshots, null, 2)}\n`, 'utf8');
}

function readShardRequest(params: {
    requestPath: string;
    readFileSync: typeof readFileSync;
}): MixedRealisticShardRequest {
    return JSON.parse(params.readFileSync(params.requestPath, 'utf8')) as MixedRealisticShardRequest;
}

function resolvePartialResult(error: unknown): MixedRealisticShardResult | undefined {
    if (!(error instanceof Error) || !('partialResult' in error)) {
        return undefined;
    }
    return (error as Error & { partialResult?: MixedRealisticShardResult }).partialResult;
}

export async function runMixedRealisticShardCli(
    args: readonly string[],
    deps: RunMixedRealisticShardCliDeps = defaultDeps,
): Promise<void> {
    const requestPath = args[0];
    if (!requestPath) {
        throw new Error('Usage: runMixedRealisticShard.ts <request.json>');
    }

    const request = readShardRequest({
        requestPath,
        readFileSync: deps.readFileSync,
    });
    const progressSnapshots: MixedRealisticShardProgressSnapshot[] = [];

    try {
        const result = await deps.runMixedRealisticShardWork({
            baseUrl: request.baseUrl,
            controlPlaneBaseUrl: request.controlPlaneBaseUrl,
            controlPlaneBaseUrls: request.controlPlaneBaseUrls,
            authIndexStart: request.shardPlan.authIndexStart,
            shardIndex: request.shardPlan.shardIndex,
            onProgressSnapshot: async (snapshot) => {
                progressSnapshots.push(snapshot);
                if (request.progressPath) {
                    writeShardProgressSnapshots({
                        progressPath: request.progressPath,
                        snapshots: progressSnapshots,
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
        if (request.progressPath && result.progressSnapshots.length > 0) {
            writeShardProgressSnapshots({
                progressPath: request.progressPath,
                snapshots: result.progressSnapshots,
                writeFileSync: deps.writeFileSync,
            });
        }
    } catch (error) {
        const partialResult = resolvePartialResult(error);
        if (partialResult) {
            writeShardResult({
                outputPath: request.outputPath,
                result: partialResult,
                writeFileSync: deps.writeFileSync,
            });
        }
        if (request.progressPath && progressSnapshots.length > 0) {
            writeShardProgressSnapshots({
                progressPath: request.progressPath,
                snapshots: progressSnapshots,
                writeFileSync: deps.writeFileSync,
            });
        }
        throw error;
    }
}

const invokedPath = process.argv[1];
if (invokedPath && basename(invokedPath) === 'runMixedRealisticShard.ts') {
    void runMixedRealisticShardCli(process.argv.slice(2)).catch((error: unknown) => {
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
        defaultDeps.processStderrWrite(`${message}\n`);
        process.exit(1);
    });
}
