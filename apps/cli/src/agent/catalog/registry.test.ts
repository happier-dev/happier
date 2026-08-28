import { describe, expect, it } from 'vitest';

import { AGENT_IDS, DEFAULT_AGENT_ID, getAgentCore } from '@happier-dev/agents';

import { LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID } from '@/agent/acp/catalog/compat/customAcp';

import {
  AGENTS,
  CatalogAgentNotInstalledError,
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

describe('agent catalog registry read API', () => {
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
