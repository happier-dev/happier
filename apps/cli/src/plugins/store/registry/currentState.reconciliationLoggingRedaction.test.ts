import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePluginStorePaths } from '../paths';
import {
  createImmutablePluginGenerationRecordFromSource,
  prepareImmutablePluginGeneration,
} from './generationStore';
import { createPluginRegistryStateStore } from './currentState';
import { Logger, logger } from '@/ui/logger';

const loggerConfiguration = vi.hoisted(() => ({
  happyHomeDir: '',
  logsDir: '',
}));

vi.mock('../../../configuration', () => ({
  configuration: {
    isDaemonProcess: false,
    get happyHomeDir() {
      return loggerConfiguration.happyHomeDir;
    },
    get logsDir() {
      return loggerConfiguration.logsDir;
    },
  },
}));

const temporaryDirectories: string[] = [];

function createCleanupFailure(): Error {
  const error = new Error([
    'CLEANUP_FAILURE client_secret=cleanup-error-secret',
    "failed to retire '/Users/alice/private/obsolete-generation/plugin-generation.v1.json'",
    '🙂'.repeat(1_200),
    'END_CLEANUP_FAILURE',
  ].join(' '));
  error.stack = 'BEGIN_STACK client_secret=cleanup-stack-secret END_STACK';
  return error;
}

async function prepareObsoleteGeneration(params: Readonly<{
  happyHomeDir: string;
  immutableGenerationId: string;
}>): Promise<void> {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-reconciliation-redaction-source-'));
  temporaryDirectories.push(sourceRoot);
  await writeFile(join(sourceRoot, 'marker'), 'obsolete', 'utf8');
  const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
  const record = await createImmutablePluginGenerationRecordFromSource({
    pluginId: 'acme.reconciliation.redaction',
    sourceRootPath: sourceRoot,
    manifestRelativePath: 'marker',
    distribution: { kind: 'localPath', canonicalPath: sourceRoot },
    updatePolicy: 'manual',
    createdAtMs: 1,
    immutableGenerationId: params.immutableGenerationId,
  });
  await prepareImmutablePluginGeneration({
    paths,
    sourceRootPath: sourceRoot,
    record,
  });
}

function readDiagnostic(message: string, marker: string): Readonly<{
  operation: string;
  pendingSurfaces: readonly string[];
  message?: string;
}> {
  const markerIndex = message.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(message.slice(markerIndex + marker.length).trim()) as Readonly<{
    operation: string;
    pendingSurfaces: readonly string[];
    message?: string;
  }>;
}

describe('plugin registry reconciliation diagnostic logging', () => {
  const envKeys = [
    'DEBUG',
    'HAPPIER_HOME_DIR',
    'HAPPIER_LOG_LEVEL',
    'DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING',
    'HAPPIER_SERVER_URL',
  ] as const;
  let previousEnvironment: Record<string, string | undefined>;

  beforeEach(() => {
    previousEnvironment = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    delete process.env.DEBUG;
    process.env.HAPPIER_LOG_LEVEL = 'debug';
    process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '1';
    process.env.HAPPIER_SERVER_URL = 'https://logs.example.test';
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
    loggerConfiguration.happyHomeDir = '';
    loggerConfiguration.logsDir = '';
    for (const key of envKeys) {
      const previous = previousEnvironment[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('projects malformed obsolete directory names and cleanup failures before file and remote logger egress', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-reconciliation-redaction-home-'));
    const logDirectory = await mkdtemp(join(tmpdir(), 'happier-reconciliation-redaction-logs-'));
    temporaryDirectories.push(happyHomeDir, logDirectory);
    process.env.HAPPIER_HOME_DIR = logDirectory;
    loggerConfiguration.happyHomeDir = logDirectory;
    loggerConfiguration.logsDir = join(logDirectory, 'logs');
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const isolatedLogger = new Logger(join(logDirectory, 'reconciliation.log'));
    vi.spyOn(isolatedLogger, 'localTimezoneTimestamp').mockReturnValue('00:00:00.000');
    vi.spyOn(logger, 'warn').mockImplementation((message, ...args) => {
      isolatedLogger.warn(message, ...args);
    });

    const marker = '[PLUGIN RUNTIME] Plugin registry reconciliation remains pending';
    const store = createPluginRegistryStateStore({ happyHomeDir });
    await store.initialize();
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const malformedDirectoryName = 'z malformed directory secret';
    await mkdir(join(paths.generationsDir, malformedDirectoryName));
    await prepareObsoleteGeneration({
      happyHomeDir,
      immutableGenerationId: 'generation-obsolete-redaction',
    });

    const reconcilingStore = createPluginRegistryStateStore({
      happyHomeDir,
      generationCustodyRetirement: {
        readCredentials: async () => ({ token: 'fixture-token', encryption: null }),
        retireGeneration: async () => {
          throw createCleanupFailure();
        },
      },
      onReconciliationPending: (diagnostic) => {
        logger.warn(marker, diagnostic);
      },
    });
    await expect(reconcilingStore.initialize()).resolves.toMatchObject({ plugins: {} });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(existsSync(join(paths.generationsDir, malformedDirectoryName))).toBe(true);
    isolatedLogger.flushSync();

    expect(existsSync(isolatedLogger.getLogPath())).toBe(true);
    const fileLines = readFileSync(isolatedLogger.getLogPath(), 'utf8')
      .split('\n')
      .filter((line) => line.includes(marker));
    expect(fileLines).toHaveLength(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const remoteMessages = fetchMock.mock.calls.map(([, init]) => {
      const body = (init as RequestInit | undefined)?.body;
      expect(typeof body).toBe('string');
      const payload = JSON.parse(body as string) as Readonly<{ message: string }>;
      return payload.message;
    });
    const diagnostics = [
      ...fileLines.map((line) => readDiagnostic(line, marker)),
      ...remoteMessages.map((message) => readDiagnostic(message, marker)),
    ];
    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.operation).toBe('startup');
      expect(diagnostic.pendingSurfaces).toEqual(['reconciliation']);
      expect(diagnostic.message).toMatch(/^generationCleanup: Immutable generation cleanup remains pending:/u);
      expect(diagnostic.message).toContain(
        'An obsolete plugin generation directory has an invalid storage id',
      );
      expect(diagnostic.message).toContain('generation-obsolete-redaction');
      expect(diagnostic.message).toContain('client_secret: [REDACTED]');
      expect(diagnostic.message).not.toContain(malformedDirectoryName);
      expect(diagnostic.message).not.toContain('cleanup-error-secret');
      expect(diagnostic.message).not.toContain('cleanup-stack-secret');
      expect(diagnostic.message).not.toContain('/Users/alice/private/obsolete-generation');
      expect(diagnostic.message).not.toContain('END_CLEANUP_FAILURE');
      expect(Buffer.byteLength(diagnostic.message ?? '', 'utf8')).toBeLessThanOrEqual(2_048);
    }
  });
});
