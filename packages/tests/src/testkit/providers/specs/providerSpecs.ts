import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ProviderUnderTest } from '../types';
import { repoRootDir } from '../../paths';
import {
  E2eCliProviderScenarioRegistryV1Schema,
  E2eCliProviderSpecV1Schema,
  type E2eCliProviderScenarioRegistryV1,
  type E2eCliProviderSpecV1,
} from '@happier-dev/protocol';

export type CliProviderSpecV1 = E2eCliProviderSpecV1;
export type CliProviderScenarioRegistryV1 = E2eCliProviderScenarioRegistryV1;

type ProviderSpecRecord = {
  entryName: string;
  e2eDir: string;
  specPath: string;
  spec: CliProviderSpecV1;
};

type ProviderSpecSearchRoot = {
  baseDir: string;
  e2eDirForEntry: (entryName: string) => string;
};

function resolveCoverageExpectation(
  scenariosRegistry: CliProviderScenarioRegistryV1,
): ProviderUnderTest['coverageExpectation'] {
  if (scenariosRegistry.coverageExpectation) {
    return scenariosRegistry.coverageExpectation;
  }

  return {
    providerLaneScope: 'declared-scenarios',
    defaultRuntimePath: 'provider-lane',
    appServerCoverage: 'not-applicable',
  };
}

function providerSpecSearchRoots(): ProviderSpecSearchRoot[] {
  return [
    {
      baseDir: join(repoRootDir(), 'apps', 'cli', 'src', 'backends'),
      e2eDirForEntry: (entryName) => join(repoRootDir(), 'apps', 'cli', 'src', 'backends', entryName, 'e2e'),
    },
    {
      baseDir: join(repoRootDir(), 'packages', 'plugins'),
      e2eDirForEntry: (entryName) => join(repoRootDir(), 'packages', 'plugins', entryName, 'src', 'agent', 'e2e'),
    },
    {
      baseDir: join(repoRootDir(), 'packages', 'tests', 'fixtures', 'cli-backends'),
      e2eDirForEntry: (entryName) => join(repoRootDir(), 'packages', 'tests', 'fixtures', 'cli-backends', entryName, 'e2e'),
    },
  ];
}

async function readJsonFile(path: string, parseErrorLabel: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${parseErrorLabel}: ${path} (${message})`);
  }
}

function parseProviderSpecJson(params: {
  entryName: string;
  specPath: string;
  json: unknown;
}): CliProviderSpecV1 {
  const parsed = E2eCliProviderSpecV1Schema.safeParse(params.json);
  if (!parsed.success) {
    throw new Error(`Invalid providerSpec.json (${params.entryName}): ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseScenarioRegistryJson(params: {
  entryName: string;
  json: unknown;
}): CliProviderScenarioRegistryV1 {
  const parsed = E2eCliProviderScenarioRegistryV1Schema.safeParse(params.json);
  if (!parsed.success) {
    throw new Error(`Invalid providerScenarios.json (${params.entryName}): ${parsed.error.message}`);
  }
  return parsed.data;
}

async function loadProviderSpecRecords(root: ProviderSpecSearchRoot): Promise<ProviderSpecRecord[]> {
  const entries = await readdir(root.baseDir, { withFileTypes: true });
  const records: ProviderSpecRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const e2eDir = root.e2eDirForEntry(entry.name);
    const specPath = join(e2eDir, 'providerSpec.json');
    if (!existsSync(specPath)) continue;

    const specJson = await readJsonFile(specPath, `Failed to parse providerSpec.json (${entry.name})`);
    const spec = parseProviderSpecJson({
      entryName: entry.name,
      specPath,
      json: specJson,
    });

    records.push({ entryName: entry.name, e2eDir, specPath, spec });
  }

  return records;
}

export async function loadCliProviderSpecs(): Promise<CliProviderSpecV1[]> {
  const records: ProviderSpecRecord[] = [];
  for (const root of providerSpecSearchRoots()) {
    records.push(...(await loadProviderSpecRecords(root)));
  }

  const seen = new Set<string>();
  const specs: CliProviderSpecV1[] = [];
  for (const record of records) {
    if (seen.has(record.spec.id)) continue;
    seen.add(record.spec.id);
    specs.push(record.spec);
  }
  return specs;
}

export async function loadProvidersFromCliSpecs(): Promise<ProviderUnderTest[]> {
  const records: ProviderSpecRecord[] = [];
  for (const root of providerSpecSearchRoots()) {
    records.push(...(await loadProviderSpecRecords(root)));
  }

  const providers: ProviderUnderTest[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.spec.id)) continue;
    seen.add(record.spec.id);

    const scenariosPath = join(record.e2eDir, 'providerScenarios.json');
    if (!existsSync(scenariosPath)) {
      throw new Error(`Missing providerScenarios.json (${record.entryName}): ${scenariosPath}`);
    }
    const scenariosJson = await readJsonFile(scenariosPath, `Failed to parse providerScenarios.json (${record.entryName})`);
    const scenariosRegistry = parseScenarioRegistryJson({ entryName: record.entryName, json: scenariosJson });
    const spec = record.spec;

    providers.push({
      id: spec.id,
      enableEnvVar: spec.enableEnvVar,
      protocol: spec.protocol,
      traceProvider: spec.traceProvider,
      coverageExpectation: resolveCoverageExpectation(scenariosRegistry),
      requiredEnv: spec.requiredEnv,
      auth: spec.auth,
      permissions: spec.permissions,
      scenarioRegistry: scenariosRegistry,
      requiresBinaries: spec.requiredBinaries,
      cli: spec.cli,
    });
  }

  return providers;
}
