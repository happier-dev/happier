import '../configureZodLocale';
import { dirname, join } from 'node:path';

import packageJson from '../../package.json' with { type: 'json' };

import {
  assertRunnerArtifactMatchesCurrentExecutable,
  readStrictEphemeralRunnerActivationDocument,
} from './activationFile';
import { resolveEphemeralRunnerSafeFatalError } from './endpointTerminalUi';
import {
  bindEphemeralRunnerProcessStorageEnvironment,
  createEphemeralRunnerLocalState,
} from './localState';

export type {
  EphemeralRunnerDependencies,
  EphemeralRunnerEndpointUi,
  EphemeralRunnerEndpointSnapshot,
  EphemeralRunnerEndpointFailure,
  EphemeralRunnerControllerResult,
} from './controlPlane';
export type {
  EphemeralRunnerEndpointPresentation,
  EphemeralRunnerEndpointPresentationAction,
} from './endpointTerminalUi';
export { resolveEphemeralRunnerEndpointPresentation } from './endpointTerminalUi';

export function formatEphemeralRunnerFatalError(_error: unknown): string {
  // Provider/runtime failures can contain prompt, path, or credential-adjacent
  // diagnostics. The ordinary Session and redacted logging owners retain the
  // detail; the standalone entry prints only the safe recovery direction.
  return resolveEphemeralRunnerSafeFatalError();
}

export async function runEphemeralRunnerMain(input: Readonly<{
  argv?: readonly string[];
  executablePath?: string;
  signal?: AbortSignal;
  writeVersion?: (value: string) => void;
  createApplication?: typeof import('./runtimeIntegrations').createProductionEphemeralRunnerApplication;
  runApplication?: typeof import('./endpointApp').runEphemeralRunner;
  localStateParentDirectory?: string;
}> = {}): Promise<void> {
  const argv = [...(input.argv ?? process.argv.slice(2))];
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    (input.writeVersion ?? ((value) => console.log(value)))(`happier-runner ${packageJson.version}`);
    return;
  }
  if (argv.length > 0) throw new Error('Happier Runner does not accept CLI commands or Account credentials');

  const shellActivationPath = process.env.HAPPIER_RUNNER_NATIVE_SHELL === 'stdio'
    ? process.env.HAPPIER_RUNNER_ACTIVATION_FILE
    : undefined;
  const activationFilePath = shellActivationPath?.trim() || join(
    dirname(input.executablePath ?? process.execPath),
    'happier-runner.activation.json',
  );
  const activationDocument = await readStrictEphemeralRunnerActivationDocument(activationFilePath);
  // Reject the wrong executable before creating any local state. This is the
  // same canonical check repeated after full activation-key verification by
  // endpointApp; neither path interprets the artifact independently.
  assertRunnerArtifactMatchesCurrentExecutable(activationDocument.activation.artifact);
  const localState = await createEphemeralRunnerLocalState({
    activationId: activationDocument.activation.id,
    ...(input.localStateParentDirectory
      ? { parentDirectory: input.localStateParentDirectory }
      : {}),
  });
  const restoreStorageEnvironment = bindEphemeralRunnerProcessStorageEnvironment(localState);
  try {
    // Runtime modules instantiate the canonical configuration singleton. They
    // must not be evaluated until the activation-local storage authority is in
    // process.env; importing and then reloading configuration is too late for
    // other module-level owners that already captured its paths.
    const createApplication = input.createApplication
      ?? (await import('./runtimeIntegrations')).createProductionEphemeralRunnerApplication;
    const runApplication = input.runApplication
      ?? (await import('./endpointApp')).runEphemeralRunner;
    for (;;) {
      const application = await createApplication({
        activationFilePath,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const result = await runApplication({
        activationFilePath,
        artifact: application.artifact,
        dependencies: application.dependencies,
        ui: application.ui,
        localState,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (result.status === 'retry_requested') continue;
      if (result.status === 'failed') throw result.error;
      return;
    }
  } finally {
    restoreStorageEnvironment();
    await localState.dispose().catch(() => undefined);
  }
}

// Bun's compiled-binary entry preserves import.meta.main. Keeping startup here
// makes this the actual shipped product entry while imports remain side-effect
// free for tests and the release builder.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  void runEphemeralRunnerMain().catch((error) => {
    console.error(formatEphemeralRunnerFatalError(error));
    process.exitCode = 1;
  });
}
