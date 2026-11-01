import { describe, expect, it } from 'vitest';
import { mapAcpRegistryAgentToDefinitionV1 } from '@happier-dev/protocol/acp/catalog/registry/mapAcpRegistryAgentV1';
import { createRegistryHostV1, BUILT_IN_REGISTRY_SOURCES_V1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { summarizeAcpRegistryDistributionV1 } from '@happier-dev/protocol/acp/catalog/registry/acpPlatformFitV1';
import { ACP_REGISTRY_V1_FIXTURE } from '../../../../../../../packages/protocol/src/registries/formats/fixtures/acpRegistryV1Fixture';
import {
  AcpRegistryAgentV1Schema,
  HAPPIER_PICKS_SOURCE_ID,
  RegistryItemSummaryV1Schema,
  type AcpRegistryAgentV1,
  type RegistryItemSummaryV1,
} from '@happier-dev/protocol/registries';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';

import {
  buildAgentAddRows,
  type AgentAddMachine,
} from './agentAddRows';

const ACP = 'builtin:acp-registry';
const ACP_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

// Registry entries shaped as the ACP reader normalizes them (published 2026-10-11 data).
const goose = AcpRegistryAgentV1Schema.parse({
  id: 'goose',
  name: 'goose',
  version: '1.54.0',
  description: 'A local, extensible, open source AI agent.',
  authors: ['Block'],
  license: 'Apache-2.0',
  distributions: {
    binary: {
      'darwin-arm64': {
        archiveUrl:
          'https://github.com/block/goose/releases/download/v1.54.0/goose-aarch64-apple-darwin.tar.bz2',
        command: './goose',
        args: ['acp'],
        env: {},
      },
      'linux-x64': {
        archiveUrl:
          'https://github.com/block/goose/releases/download/v1.54.0/goose-x86_64-unknown-linux-gnu.tar.gz',
        command: './goose',
        args: ['acp'],
        env: {},
      },
    },
  },
});
const junie = AcpRegistryAgentV1Schema.parse({
  id: 'junie',
  name: 'Junie',
  version: '3579.5.0',
  description: 'AI coding agent by JetBrains.',
  authors: ['JetBrains'],
  distributions: {
    npm: {
      package: '@jetbrains/junie-acp',
      version: '3579.5.0',
      args: [],
      env: {},
    },
  },
});

function summary(
  sourceId: string,
  agent: Pick<AcpRegistryAgentV1, 'id' | 'name' | 'version'> & Partial<Pick<AcpRegistryAgentV1, 'distributions'>>,
  extra: Partial<RegistryItemSummaryV1> = {},
): RegistryItemSummaryV1 {
  return RegistryItemSummaryV1Schema.parse({
    sourceId,
    kind: 'agent',
    itemId: agent.id,
    title: agent.name,
    version: agent.version,
    ...(agent.distributions ? { agentDistribution: summarizeAcpRegistryDistributionV1(agent.distributions) } : {}),
    ...extra,
  });
}

function builtIn(
  agentId: string,
  acpRegistryIds: readonly string[],
): ResolvedAgentCatalogEntry {
  return {
    agentId,
    qualifiedId: agentId,
    identity: null,
    installedPackage: null,
    projectionGeneration: null,
    catalogAgentId: null,
    iconAgentId: null,
    backendTargetKey: null,
    title: 'Claude Code',
    subtitle: null,
    iconName: 'code',
    channel: 'stable',
    enabled: true,
    isBuiltIn: true,
    descriptor: null,
    behavior: null,
    authPlugin: null,
    acpRegistryIds,
    cliAuthBackgroundCheckSafe: true,
    connectedAccounts: [],
  };
}

const machines: readonly AgentAddMachine[] = [
  {
    machineId: 'mbp',
    name: 'MacBook Pro',
    platform: 'darwin',
    arch: 'arm64',
    offline: false,
  },
  {
    machineId: 'win',
    name: 'Windows desktop',
    platform: 'win32',
    arch: 'arm64',
    offline: true,
  },
];

describe('buildAgentAddRows', () => {
  it('computes list fit from registered reader summaries before any detail is opened', async () => {
    const unused = async (): Promise<never> => { throw new Error('Unexpected transport'); };
    const host = createRegistryHostV1({ host: 'web', readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1,
      http: { getJson: async () => ({ ok: true, value: ACP_REGISTRY_V1_FIXTURE, fetchedAt: 1 }), getText: unused, getBytes: unused } });
    const response = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(
      await host.execute('registries.items.list', { kind: 'agent', sourceIds: [ACP] }),
    );
    const items = response.pages.flatMap(page => page.items).map(item => RegistryItemSummaryV1Schema.parse(item));
    const build = (knownMachines: readonly AgentAddMachine[]) => buildAgentAddRows({ items, machines: knownMachines,
      catalogEntries: [], definitions: [] }).rows;
    const linux: AgentAddMachine = { machineId: 'linux', name: 'Linux', platform: 'linux', arch: 'x86_64', offline: false };
    const rows = build([linux]);
    // The 2026-10-31 bzip2 owner ruling makes the captured goose archive runnable.
    expect(rows.find(row => row.summary.itemId === 'goose')?.status).toBeNull();
    expect(rows.find(row => row.summary.itemId === 'junie')?.status).toBeNull();
    expect(rows.find(row => row.summary.itemId === 'claude-acp')?.status).toBeNull();
    expect(build([{ ...linux, arch: null }]).find(row => row.summary.itemId === 'junie')?.status).toEqual({ kind: 'unknown' });
    expect(build([{ ...linux, platform: 'windows', arch: 'aarch64' }]).find(row => row.summary.itemId === 'goose')?.status)
      .toMatchObject({ kind: 'cantRun', fit: { reason: 'no_build_for_platform' } });
    expect(build([]).every(row => row.status === null)).toBe(true);
  });
  it('leads with Happier picks, then each registry in the order it answered, keeping the registry order', () => {
    const { groups } = buildAgentAddRows({
      items: [
        summary(ACP, goose),
        summary(HAPPIER_PICKS_SOURCE_ID, {
          id: 'aider',
          name: 'Aider',
          version: '0.4.2',
        }),
        summary(ACP, junie),
      ],
      catalogEntries: [],
      definitions: [],
      machines,
    });
    expect(groups.map((group) => [group.key, group.itemKeys])).toEqual([
      ['picks', [`${HAPPIER_PICKS_SOURCE_ID}|aider`]],
      [`source:${ACP}`, [`${ACP}|goose`, `${ACP}|junie`]],
    ]);
  });

  it('says Built into Happier from acpRegistryIds and Added from a definition of the same registry item', () => {
    const added = mapAcpRegistryAgentToDefinitionV1({
      agent: junie,
      nowMs: 1,
      provenance: {
        sourceId: ACP,
        format: 'acp-registry',
        sourceUrl: ACP_URL,
        itemId: 'junie',
        ref: { kind: 'version', version: '3579.5.0' },
        importedAt: 1,
      },
    });
    if (!added.ok) throw new Error('mapping failed');
    const { rows } = buildAgentAddRows({
      items: [
        summary(ACP, {
          id: 'claude-agent',
          name: 'Claude Agent',
          version: '0.4.0',
        }),
        summary(ACP, junie),
        summary(ACP, goose),
      ],
      catalogEntries: [builtIn('claude', ['claude-agent'])],
      definitions: [added.definition],
      machines,
    });
    expect(rows.map((row) => row.status?.kind ?? null)).toEqual([
      'builtIn',
      'added',
      null,
    ]);
    expect(rows[0]?.status).toMatchObject({
      kind: 'builtIn',
      entry: { agentId: 'claude' },
    });
    expect(rows[1]?.status).toEqual({
      kind: 'added',
      definitionId: added.definition.id,
    });
  });

  it("says Can't run here with the first machine's reason only when no machine can run it", () => {
    const windowsOnly = [machines[1]!];
    const linux: AgentAddMachine = {
      machineId: 'nl2',
      name: 'nl2',
      platform: 'linux',
      arch: 'x64',
      offline: false,
    };
    const items = [summary(ACP, goose)];
    const cant = buildAgentAddRows({
      items,
      catalogEntries: [],
      definitions: [],
      machines: windowsOnly,
    });
    expect(cant.rows[0]?.status).toEqual({
      kind: 'cantRun',
      machineName: 'Windows desktop',
      fit: { kind: 'cant_run', reason: 'no_build_for_platform' },
    });
    // One machine that can run it keeps the row quiet, even beside one that can't.
    const can = buildAgentAddRows({
      items,
      catalogEntries: [],
      definitions: [],
      machines: [...windowsOnly, linux],
    });
    expect(can.rows[0]?.status).toBeNull();
  });

  it('never assumes fit: a machine without its architecture reads Unknown, no machines read nothing', () => {
    const items = [summary(ACP, goose)];
    const unknown = buildAgentAddRows({
      items,
      catalogEntries: [],
      definitions: [],
      machines: [
        {
          machineId: 'm',
          name: 'Mystery',
          platform: 'linux',
          arch: null,
          offline: false,
        },
      ],
    });
    expect(unknown.rows[0]?.status).toEqual({ kind: 'unknown' });
    const none = buildAgentAddRows({
      items,
      catalogEntries: [],
      definitions: [],
      machines: [],
    });
    expect(none.rows[0]?.status).toBeNull();
  });

  it("shows the registry's own problem before any other status", () => {
    const { rows } = buildAgentAddRows({
      items: [
        summary(
          ACP,
          { id: 'claude-agent', name: 'Claude Agent', version: '0.4.0' },
          { problem: { code: 'unsupported_entry', reason: 'distribution' } },
        ),
      ],
      catalogEntries: [builtIn('claude', ['claude-agent'])],
      definitions: [],
      machines,
    });
    expect(rows[0]?.status).toEqual({
      kind: 'problem',
      problem: { code: 'unsupported_entry', reason: 'distribution' },
    });
  });
});
