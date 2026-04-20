import { readFileSync, writeFileSync } from 'node:fs';

import type { StressConfig } from '../config/stressScenarioSchema';
import { runMixedConnectCeilingShardWork } from '../scenarios/runMixedConnectCeilingShardWork';

type MixedConnectCeilingShardRequest = Readonly<{
  baseUrl: string;
  config: StressConfig;
  shardPlan: {
    shardIndex: number;
    authIndexStart: number;
    userCount: number;
    mixedSetupConcurrency: number;
    mixedConnectConcurrency: number;
  };
  outputPath: string;
}>;

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  if (!requestPath) {
    throw new Error('Usage: runMixedConnectCeilingShard.ts <request.json>');
  }

  const request = JSON.parse(readFileSync(requestPath, 'utf8')) as MixedConnectCeilingShardRequest;
  const result = await runMixedConnectCeilingShardWork({
    baseUrl: request.baseUrl,
    authIndexStart: request.shardPlan.authIndexStart,
    shardIndex: request.shardPlan.shardIndex,
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

  writeFileSync(request.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
