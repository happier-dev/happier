import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_INSTALLABLES_REGISTRY,
  CODEX_ACP_DEP_ID,
  resolveInstallablesRegistry,
} from '@happier-dev/protocol/installables';

import { CHECKLIST_IDS } from './checklistIds';
import { resumeChecklistId } from './checklistIds';
import { checklists, createCapabilityChecklists } from './checklists';

describe('capabilities checklists', () => {
  afterEach(() => {
    vi.doUnmock('@/agent/catalog/registry');
    vi.resetModules();
  });

  it('includes tool.executionRuns in MACHINE_DETAILS checklist', () => {
    const entries = checklists[CHECKLIST_IDS.MACHINE_DETAILS] ?? [];
    expect(entries.some((e) => e.id === 'tool.executionRuns')).toBe(true);
  });

  it('derives machine detail dependency checks from installable descriptors', () => {
    const entries = checklists[CHECKLIST_IDS.MACHINE_DETAILS] ?? [];
    const expectedIds = BUILT_IN_INSTALLABLES_REGISTRY.descriptors.map((entry) => entry.descriptor.capabilityId);

    expect(entries.map((entry) => entry.id)).toEqual(expect.arrayContaining(expectedIds));
  });

  it('derives machine detail dependency checks from the runtime installables registry', () => {
    const descriptor = {
      ...BUILT_IN_INSTALLABLES_REGISTRY.descriptors[0]!.descriptor,
      id: 'plugin-managed-tool',
      key: 'plugin-managed-tool',
      capabilityId: 'dep.plugin-managed-tool',
      display: { name: 'Plugin managed tool' },
    } as const;
    const installablesRegistry = resolveInstallablesRegistry({
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.agent.fixture',
          pluginId: 'happier.agent.fixture',
          manifestPath: 'bundled:happier.agent.fixture',
          },
        descriptor,
      }],
    });

    const entries = createCapabilityChecklists(installablesRegistry)[CHECKLIST_IDS.MACHINE_DETAILS] ?? [];

    expect(entries.map((entry) => entry.id)).toContain('dep.plugin-managed-tool');
  });

  it('does not request ACP capabilities in normal checklists', () => {
    const entries = Object.values(checklists).flat();
    expect(entries.some((e) => (e as any)?.params?.includeAcpCapabilities === true)).toBe(false);
  });

  it('does not emphasize Codex ACP installables for the default resume checklist', () => {
    const entries = checklists[resumeChecklistId('codex')] ?? [];
    expect(entries.some((entry) => entry.id === CODEX_ACP_DEP_ID)).toBe(false);
  });

  it('reflects an Agent contributed after the first checklist read', async () => {
    // `AGENTS` is a live Proxy over `readAgentCatalogSnapshot()`, so the catalog gains entries as
    // plugins activate. Memoizing the resolved table froze the `cli.<agentId>` capability requests
    // to whichever catalog happened to exist at the first read, which reported a later-contributed
    // Agent as having no CLI capability check for the rest of the process.
    const catalogEntries: Record<string, { id: string }> = { claude: { id: 'claude' } };
    vi.resetModules();
    vi.doMock('@/agent/catalog/registry', () => ({
      get AGENTS() {
        return catalogEntries;
      },
    }));

    const moduleExports = await import('./checklists');
    expect(moduleExports.checklists[CHECKLIST_IDS.NEW_SESSION]?.map((entry) => entry.id)).toContain(
      'cli.claude',
    );

    catalogEntries['acme.later'] = { id: 'acme.later' };

    expect(moduleExports.checklists[CHECKLIST_IDS.NEW_SESSION]?.map((entry) => entry.id)).toContain(
      'cli.acme.later',
    );
  });

  it('does not read AGENTS during module initialization', async () => {
    let initialized = false;

    vi.doMock('@/agent/catalog/registry', () => ({
      get AGENTS() {
        if (!initialized) {
          throw new ReferenceError("Cannot access 'AGENTS' before initialization");
        }
        return {
          claude: { id: 'claude' },
        };
      },
    }));

    const moduleExports = await import('./checklists');
    initialized = true;

    expect(moduleExports.checklists[CHECKLIST_IDS.NEW_SESSION]).toEqual(
      expect.arrayContaining([{ id: 'cli.claude' }]),
    );
  });

});
