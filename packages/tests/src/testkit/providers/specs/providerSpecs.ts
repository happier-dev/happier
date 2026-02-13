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
  specPath: string;
  spec: CliProviderSpecV1;
};

function providerSpecSearchDirs(): string[] {
  return [
    join(repoRootDir(), 'apps', 'cli', 'src', 'backends'),
    join(repoRootDir(), 'packages', 'tests', 'fixtures', 'cli-backends'),
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

async function loadProviderSpecRecords(backendsDir: string): Promise<ProviderSpecRecord[]> {
  const entries = await readdir(backendsDir, { withFileTypes: true });
  const records: ProviderSpecRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const specPath = join(backendsDir, entry.name, 'e2e', 'providerSpec.json');
    if (!existsSync(specPath)) continue;

    const specJson = await readJsonFile(specPath, `Failed to parse providerSpec.json (${entry.name})`);
    const spec = parseProviderSpecJson({
      entryName: entry.name,
      specPath,
      json: specJson,
    });

    records.push({ entryName: entry.name, specPath, spec });
  }

  return records;
}

export async function loadCliProviderSpecs(): Promise<CliProviderSpecV1[]> {
  const records: ProviderSpecRecord[] = [];
  for (const dir of providerSpecSearchDirs()) {
    records.push(...(await loadProviderSpecRecords(dir)));
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
  const records: Array<ProviderSpecRecord & { baseDir: string }> = [];
  for (const dir of providerSpecSearchDirs()) {
    for (const record of await loadProviderSpecRecords(dir)) {
      records.push({ ...record, baseDir: dir });
    }
  }

  const providers: ProviderUnderTest[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.spec.id)) continue;
    seen.add(record.spec.id);

    const scenariosPath = join(record.baseDir, record.entryName, 'e2e', 'providerScenarios.json');
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
