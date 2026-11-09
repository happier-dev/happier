import { afterAll, describe, expect, it } from 'vitest';

import { AGENT_IDS, DEFAULT_AGENT_ID, getAgentCore, isAgentStateRequestCoveredByCompletedRequests } from '@happier-dev/agents';
import { PluginAgentContributionV2Schema, buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import * as catalogRegistry from './registry';

import { LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID } from '@/agent/acp/catalog/compat/customAcp';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { readCurrentContributionRegistry } from './snapshot';

import {
  AGENTS,
  CatalogAgentNotInstalledError,
  findCatalogEntry,
  readCatalogEntriesSnapshot,
  requireCatalogEntry,
} from './registry';
import {
  isCatalogAgentId,
  isCatalogAgentLookupId,
  resolveAgentCliSubcommand,
  resolveCatalogAgentId,
  resolveCatalogAgentIdForCliSubcommand,
} from './resolution';

function captureThrown(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

async function publishCatalogProjection(projection: ResolvedContributionRegistry): Promise<void> {
  const runtime = await resolveExecutablePluginRuntimeRegistry({
    contributes: createResolvedContributionRegistry({}),
    pluginIds: [],
  });
  const adoption = await pluginReloadController.adoptPreparedRuntimeRegistry({
    registry: { ...runtime, contributes: projection },
    changedPluginIds: [],
    isDevelopmentCandidateCurrent: () => true,
    runningSessionDisposition: 'retainRunningSessions',
  });
  expect(adoption.ok).toBe(true);
}

afterAll(async () => {
  await pluginReloadController.shutdown();
});

describe('agent catalog registry read API', () => {
  it('uses request coverage declared by the selected current contributed Agent', async () => {
    expect(catalogRegistry.resolveCatalogAgentRequestCoverageOptions({ agentId: 'uninstalled' })).toBeUndefined();
    const identity = { pluginId: 'acme.coverage', localId: 'native' };
    const agentId = buildQualifiedPluginContributionKey(identity);
    const declaration = PluginAgentContributionV2Schema.parse({ id: identity.localId, title: 'Native',
      runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      requestCoverage: { equivalentSources: ['custom_native_dialog'], equivalentCompletedStatuses: ['canceled'],
        equivalentCompletedReasons: ['Native dialog stopped'] },
    });
    const projection = createResolvedContributionRegistry({ agents: [{ id: agentId, identity,
      pluginId: identity.pluginId, provenance: 'external', source: { kind: 'path' },
      definition: { kindVersion: 1, id: agentId, ownedBackendIds: [] },
      richDefinition: { provenance: 'external', definition: declaration },
    }] });
    const previousProjection = readCurrentContributionRegistry();
    try {
      await publishCatalogProjection(projection);
      const request = { tool: 'NativeChoice', source: 'custom_native_dialog', arguments: { choice: 1 }, createdAt: 10_400 };
      const completedRequests = { original: { ...request, status: 'canceled', reason: 'Native dialog stopped', completedAt: 10_000 } };
      const metadata = { runtimeDescriptorV1: { v: 1, agentId, agent: {} } };
      expect(isAgentStateRequestCoveredByCompletedRequests({ requestId: 'retry', request, completedRequests,
        options: catalogRegistry.resolveCatalogAgentRequestCoverageOptions({ metadata }) })).toBe(true);
    } finally {
      await publishCatalogProjection(previousProjection);
    }
  });
  it('exposes the merged catalog snapshot through the AGENTS proxy', () => {
    const snapshot = readCatalogEntriesSnapshot();

    expect(Object.keys(snapshot).sort()).toEqual([...AGENT_IDS].sort());
    expect(Object.keys(AGENTS).sort()).toEqual([...AGENT_IDS].sort());
    expect(Object.prototype.hasOwnProperty.call(AGENTS, 'codex')).toBe(true);
    expect(AGENTS.codex?.id).toBe('codex');
    expect(requireCatalogEntry('codex').id).toBe('codex');
  });

  it('keeps registry keys, entry ids, and shared agent ids aligned', () => {
    const keys = Object.keys(AGENTS).slice().sort();

    expect(keys).toEqual([...AGENT_IDS].slice().sort());
    expect(new Set(Object.values(AGENTS).map((entry) => entry.cliSubcommand)).size).toBe(keys.length);
    for (const [key, entry] of Object.entries(AGENTS)) {
      expect(key).toBe(entry.id);
    }
  });

  it('throws the canonical not-installed failure instead of falling back silently', () => {
    const thrown = captureThrown(() => requireCatalogEntry('__missing__' as never));

    expect(thrown).toBeInstanceOf(CatalogAgentNotInstalledError);
    expect(thrown).toMatchObject({ code: 'agent_not_installed', agentId: '__missing__' });
    expect((thrown as Error).message).toContain("'__missing__'");
  });

  it('projects plugin-owned providers without host built-in catalog entries', async () => {
    const piEntry = requireCatalogEntry('pi');

    expect(piEntry.getCliCommandHandler).toBeTypeOf('function');
    expect(piEntry.getCliAuthSpec).toBeTypeOf('function');
    expect(piEntry.getCliDetect).toBeTypeOf('function');
    expect(piEntry).not.toHaveProperty('checklists');
    expect(piEntry.vendorResumeSupport).toBe('supported');
    await expect(piEntry.getCliDetect?.()).resolves.toMatchObject({
      versionArgsToTry: [['--version'], ['version'], ['-v']],
      loginStatusArgs: null,
    });
  });

  it('keeps catalog metadata synchronized with shared agent facts', async () => {
    for (const id of AGENT_IDS) {
      const core = getAgentCore(id);
      const entry = requireCatalogEntry(id);

      expect(entry.vendorResumeSupport).toBe(core.resume.vendorResume);
    }
  });

  it('keeps only projected catalog entry hooks on the static catalog entries', () => {
    const claudeEntry = requireCatalogEntry('claude');
    const opencodeEntry = requireCatalogEntry('opencode');

    expect(claudeEntry).not.toHaveProperty('getHeadlessTmuxArgvTransform');
    expect(claudeEntry.getTerminalPromptSubmitVerificationPolicy).toBeUndefined();
    expect(requireCatalogEntry('codex').getTerminalPromptSubmitVerificationPolicy).toBeUndefined();

    expect(claudeEntry.getPreflightSessionControlsProbeAdapter).toBeUndefined();
    expect(opencodeEntry.getPreflightSessionControlsProbeAdapter).toBeUndefined();
    expect(requireCatalogEntry('kiro').getCliCommandHandler).toBeTypeOf('function');
    expect(requireCatalogEntry('ohMyPi').getCliCommandHandler).toBeTypeOf('function');
  });
});

describe('agent catalog id resolution', () => {
  it('recognizes canonical and legacy lookup ids', () => {
    expect(isCatalogAgentId('codex')).toBe(true);
    expect(isCatalogAgentId(LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID)).toBe(false);
    expect(isCatalogAgentLookupId('codex')).toBe(true);
    expect(isCatalogAgentLookupId(LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID)).toBe(true);
  });

  it('resolves runtime agent ids and CLI subcommands through the catalog', () => {
    const codexSubcommand = requireCatalogEntry('codex').cliSubcommand;

    expect(resolveCatalogAgentId('codex')).toBe('codex');
    expect(resolveAgentCliSubcommand('codex')).toBe(codexSubcommand);
    expect(resolveCatalogAgentIdForCliSubcommand(codexSubcommand)).toBe('codex');
    expect(resolveCatalogAgentIdForCliSubcommand('__missing__')).toBeNull();
  });

  it('answers an absent or uninstalled Agent with null instead of the default Agent', () => {
    // An absent id is not a request for Claude, and an uninstalled id is not a
    // request for any other installed Agent's facts.
    expect(resolveCatalogAgentId()).toBeNull();
    expect(resolveCatalogAgentId(null)).toBeNull();
    expect(resolveCatalogAgentId('   ')).toBeNull();
    expect(resolveCatalogAgentId('codex-experimental')).toBeNull();
    expect(resolveCatalogAgentId('__unknown__')).toBeNull();
    expect(resolveCatalogAgentId('__unknown__')).not.toBe(DEFAULT_AGENT_ID);
    expect(resolveAgentCliSubcommand('__unknown__')).toBeNull();
    expect(resolveAgentCliSubcommand()).toBeNull();
  });
});

describe('current catalog projection cost and isolation', () => {
  it('reads selected entries directly, enumerates once, and preserves explicit snapshots across replacement', async () => {
    const template = requireCatalogEntry('codex');
    const entries = Array.from({ length: 128 }, (_, index) => ({
      ...template,
      id: `contributed.agent-${index}`,
      cliSubcommand: `contributed-agent-${index}`,
    }));
    const projection = createResolvedContributionRegistry({ catalogEntries: entries });
    let enumerations = 0;
    let entryReads = 0;
    const measuredEntries = new Proxy(projection.catalogEntriesById, {
      ownKeys(target) {
        enumerations += 1;
        return Reflect.ownKeys(target);
      },
      get(target, property, receiver) {
        entryReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const previousProjection = readCurrentContributionRegistry();
    try {
      await publishCatalogProjection({ ...projection, catalogEntriesById: measuredEntries });
      enumerations = 0;
      entryReads = 0;

      const selected = entries[17]!;
      const lookups = 5;
      for (let index = 0; index < lookups; index += 1) {
        expect(AGENTS[selected.id]).toBe(selected);
        expect(findCatalogEntry(selected.id)).toBe(selected);
        expect(selected.id in AGENTS).toBe(true);
        expect(Object.getOwnPropertyDescriptor(AGENTS, selected.id)?.value).toBe(selected);
      }
      expect(enumerations).toBe(0);
      expect(entryReads).toBe(3 * lookups);
      expect(findCatalogEntry('__missing__')).toBeNull();
      expect('__missing__' in AGENTS).toBe(false);
      expect(Object.getOwnPropertyDescriptor(AGENTS, '__missing__')).toBeUndefined();

      enumerations = 0;
      entryReads = 0;
      expect(Object.keys(AGENTS)).toEqual(entries.map(entry => entry.id));
      expect(enumerations).toBe(1);
      expect(entryReads).toBe(entries.length);

      enumerations = 0;
      entryReads = 0;
      expect(Object.values(AGENTS)).toEqual(entries);
      expect(enumerations).toBe(1);
      expect(entryReads).toBe(2 * entries.length);

      const snapshot = readCatalogEntriesSnapshot();
      const retainedSnapshot = readCatalogEntriesSnapshot();
      delete snapshot[selected.id];
      expect(findCatalogEntry(selected.id)).toBe(selected);

      const replacement = { ...selected, cliSubcommand: 'replacement-command' };
      await publishCatalogProjection(createResolvedContributionRegistry({ catalogEntries: [replacement] }));
      expect(findCatalogEntry(selected.id)).toBe(replacement);
      expect(AGENTS[selected.id]).toBe(replacement);
      expect(Object.keys(AGENTS)).toEqual([selected.id]);
      expect(retainedSnapshot[selected.id]).toBe(selected);
      expect(readCatalogEntriesSnapshot()[selected.id]).toBe(replacement);
    } finally {
      await publishCatalogProjection(previousProjection);
    }
  });
});
