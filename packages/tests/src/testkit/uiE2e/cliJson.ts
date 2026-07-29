import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import {
  resolveCliTestLaunchSpec,
  resolveCliTestLaunchSpecOrOverride,
  type CliTestLaunchSpec,
} from '../process/cliLaunchSpec';
import {
  readLoggedCommandProcessOutcome,
  runLoggedCommandWithOutcome,
} from '../process/spawnProcess';
import { repoRootDir } from '../paths';

export type JsonEnvelope = {
  ok: boolean;
  kind: string;
  data?: unknown;
  error?: unknown;
};

export type RedactedResultOutcome = Readonly<Record<string, boolean | number | string | null>>;

function snapshotRedactedResultOutcome(outcome: RedactedResultOutcome): RedactedResultOutcome {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new TypeError('Redacted result outcome must be a scalar record');
  }
  const prototype = Object.getPrototypeOf(outcome);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Redacted result outcome must be a plain scalar record');
  }
  const keys = Reflect.ownKeys(outcome);
  if (keys.length > 32) {
    throw new TypeError('Redacted result outcome exceeds the scalar field limit');
  }
  const snapshot: Record<string, boolean | number | string | null> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new TypeError('Redacted result outcome keys must be strings');
    }
    const property = Object.getOwnPropertyDescriptor(outcome, key);
    if (!property || !property.enumerable || !('value' in property)) {
      throw new TypeError(`Redacted result outcome '${key}' must be an enumerable scalar field`);
    }
    const value = property.value as unknown;
    if (
      value !== null
      && typeof value !== 'boolean'
      && typeof value !== 'string'
      && !(typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new TypeError(`Redacted result outcome '${key}' must be a JSON scalar`);
    }
    snapshot[key] = value;
  }
  return Object.freeze(snapshot);
}

/**
 * Persists caller-selected scalar facts; it does not scrub arbitrary text.
 * Keep raw command payloads in the separately named stdout/stderr logs.
 */
export async function writeRedactedResultArtifact(params: Readonly<{
  testDir: string;
  artifactName: string;
  label: string;
  process?: Readonly<{ exitCode: number | null; signal: string | null }>;
  outcome: RedactedResultOutcome;
}>): Promise<void> {
  const outcome = snapshotRedactedResultOutcome(params.outcome);
  const artifact = {
    v: 1 as const,
    label: params.label,
    ...(params.process ? { process: params.process } : {}),
    outcome,
  };
  await writeFile(
    resolvePath(join(params.testDir, params.artifactName)),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );
}

function pickLastJsonEnvelope(text: string): JsonEnvelope {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    if (!(line.startsWith('{') || line.startsWith('['))) continue;
    try {
      const parsed = JSON.parse(line) as JsonEnvelope;
      if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean' && typeof parsed.kind === 'string') {
        return parsed;
      }
    } catch {
      // keep scanning backwards
    }
  }
  throw new Error(`Failed to parse JSON envelope from CLI stdout: ${JSON.stringify(lines.slice(-20).join('\n'))}`);
}

export async function runCliJson(params: Readonly<{
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  env: NodeJS.ProcessEnv;
  label: string;
  args: string[];
  timeoutMs?: number;
  acceptedExitCodes?: readonly number[];
  cliLaunchSpec?: CliTestLaunchSpec;
  launchOptions?: Readonly<{
    preferSourceEntrypoint?: boolean;
    skipSourceFreshnessCheck?: boolean;
    skipSharedDepsBuild?: boolean;
  }>;
}>): Promise<JsonEnvelope> {
  const launchEnv = {
    ...params.env,
    ...(params.launchOptions?.skipSharedDepsBuild
      ? {
          HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        }
      : {}),
  };
  const cliLaunchSpec = await resolveCliTestLaunchSpecOrOverride(
    params.cliLaunchSpec,
    () => resolveCliTestLaunchSpec(
      { testDir: params.testDir, env: launchEnv },
      {
        snapshotDir: resolvePath(join(params.testDir, 'cli-dist')),
        preferSourceEntrypoint: params.launchOptions?.preferSourceEntrypoint,
        skipSourceFreshnessCheck: params.launchOptions?.skipSourceFreshnessCheck,
      },
    ),
  );
  const stdoutPath = resolvePath(join(params.testDir, `cli.${params.label}.stdout.log`));
  const stderrPath = resolvePath(join(params.testDir, `cli.${params.label}.stderr.log`));
  const env = {
    ...launchEnv,
  };

  let processOutcome: Readonly<{ exitCode: number | null; signal: string | null }>;
  try {
    processOutcome = await runLoggedCommandWithOutcome({
      command: cliLaunchSpec.command,
      args: [...cliLaunchSpec.args, ...params.args],
      cwd: cliLaunchSpec.cwd ?? repoRootDir(),
      env: {
        ...env,
        ...(cliLaunchSpec.env ?? {}),
        CI: '1',
        HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
        HAPPIER_HOME_DIR: params.cliHomeDir,
        HAPPIER_SERVER_URL: params.serverUrl,
        HAPPIER_WEBAPP_URL: params.webappUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
      },
      stdoutPath,
      stderrPath,
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    const failedProcessOutcome = readLoggedCommandProcessOutcome(error);
    const acceptedExitCode = failedProcessOutcome?.signal === null
      && typeof failedProcessOutcome.exitCode === 'number'
      && params.acceptedExitCodes?.includes(failedProcessOutcome.exitCode) === true;
    if (!acceptedExitCode) {
      await writeRedactedResultArtifact({
        testDir: params.testDir,
        artifactName: `cli.${params.label}.result.json`,
        label: params.label,
        ...(failedProcessOutcome ? { process: failedProcessOutcome } : {}),
        outcome: { commandSucceeded: false, jsonEnvelopeParsed: false },
      });
      throw error;
    }
    processOutcome = failedProcessOutcome;
  }

  const stdoutText = await readFile(stdoutPath, 'utf8').catch(() => '');
  let envelope: JsonEnvelope;
  try {
    envelope = pickLastJsonEnvelope(stdoutText);
  } catch (error) {
    await writeRedactedResultArtifact({
      testDir: params.testDir,
      artifactName: `cli.${params.label}.result.json`,
      label: params.label,
      process: processOutcome,
      outcome: {
        commandSucceeded: processOutcome.exitCode === 0 && processOutcome.signal === null,
        jsonEnvelopeParsed: false,
      },
    });
    throw error;
  }
  await writeRedactedResultArtifact({
    testDir: params.testDir,
    artifactName: `cli.${params.label}.result.json`,
    label: params.label,
    process: processOutcome,
    outcome: { ok: envelope.ok, resultKind: envelope.kind },
  });
  return envelope;
}
