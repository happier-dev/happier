import type { DaemonTerminalLaunchIntent } from '@happier-dev/protocol';

import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';

export type TerminalLaunchProcess = Readonly<{
  file: string;
  args: readonly string[];
  env?: Readonly<Record<string, string | undefined>> | undefined;
}>;

export function resolveDaemonTerminalLaunch(
  launchRequest: DaemonTerminalLaunchIntent,
  deps: Readonly<{
    buildLaunchSpec?: typeof buildHappyCliSubprocessLaunchSpec;
  }> = {},
): TerminalLaunchProcess {
  const buildLaunchSpec = deps.buildLaunchSpec ?? buildHappyCliSubprocessLaunchSpec;
  switch (launchRequest.kind) {
    case 'session_attach': {
      const launch = buildLaunchSpec(['attach', launchRequest.sessionId]);
      return {
        file: launch.filePath,
        args: launch.args,
        env: launch.env,
      };
    }
  }
}
