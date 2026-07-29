import { describe, expect, it } from 'vitest';

import { AGENT_IDS, BUILT_IN_ACP_CONFIG, DEFAULT_AGENT_ID, getAgentCore } from '@happier-dev/agents';

import { LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID } from '@/agent/acp/catalog/compat/customAcp';

import {
  AGENTS,
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

  it('throws when requiring a missing entry instead of falling back silently', () => {
    expect(() => requireCatalogEntry('__missing__' as never)).toThrow(/missing catalog agent entry/i);
  });

  it('projects plugin-owned providers without host built-in catalog entries', async () => {
    const piEntry = requireCatalogEntry('pi');

    expect(piEntry.getCliCommandHandler).toBeTypeOf('function');
    expect(piEntry.getCliAuthSpec).toBeTypeOf('function');
    expect(piEntry.getCliDetect).toBeTypeOf('function');
    expect(piEntry.getCliCapabilityOverride).toBeUndefined();
    expect(piEntry.checklists).toEqual({});
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
      if (core.cloudConnect) {
        expect(entry.getCloudConnectTarget).toBeTruthy();
        const target = await entry.getCloudConnectTarget!();
        expect(target.vendorKey).toBe(core.cloudConnect.vendorKey);
        expect(target.status).toBe(core.cloudConnect.status);
      } else {
        expect(entry.getCloudConnectTarget).toBeFalsy();
      }
    }
  });

  it('keeps provider-specific entry hooks on the projected catalog entries', async () => {
    const claudeEntry = requireCatalogEntry('claude');
    const opencodeEntry = requireCatalogEntry('opencode');

    await expect(claudeEntry.getHeadlessTmuxArgvTransform?.()).resolves.toEqual(expect.any(Function));
    const transform = await claudeEntry.getHeadlessTmuxArgvTransform!();
    expect(transform(['--foo'])).toEqual(['--foo', '--happy-starting-mode', 'remote']);
    expect(requireCatalogEntry('codex').getHeadlessTmuxArgvTransform).toBeUndefined();

    const promptSubmitVerification = await claudeEntry.getTerminalPromptSubmitVerificationPolicy?.();
    expect(promptSubmitVerification?.shouldVerifyBeforeSubmit('first\nsecond')).toBe(false);
    expect(promptSubmitVerification?.shouldVerifyAfterSubmit('first\nsecond')).toBe(true);
    expect(requireCatalogEntry('codex').getTerminalPromptSubmitVerificationPolicy).toBeUndefined();

    await expect(claudeEntry.getPreflightSessionControlsProbeAdapter?.()).resolves.toMatchObject({
      probeModelsRaw: expect.any(Function),
    });
    await expect(opencodeEntry.getPreflightSessionControlsProbeAdapter?.()).resolves.toMatchObject({
      failureCacheStrategy: 'cooldown',
      cliModelsCommandArgs: ['models'],
      verboseModelsCommandArgs: ['models', '--verbose'],
    });
    expect(requireCatalogEntry('kiro').getCliCommandHandler).toBeTypeOf('function');
    expect(requireCatalogEntry('ohMyPi').getCliCommandHandler).toBeTypeOf('function');
  });

  it('does not let host built-in ACP config shadow plugin-authored ACP runtime specs', () => {
    const snapshot = readCatalogEntriesSnapshot();

    for (const agentId of Object.keys(BUILT_IN_ACP_CONFIG)) {
    }
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

    expect(resolveCatalogAgentId()).toBe(DEFAULT_AGENT_ID);
    expect(resolveCatalogAgentId('codex-experimental' as never)).toBe('codex');
    expect(resolveCatalogAgentId('__unknown__' as never)).toBe(DEFAULT_AGENT_ID);
    expect(resolveAgentCliSubcommand('codex')).toBe(codexSubcommand);
    expect(resolveCatalogAgentIdForCliSubcommand(codexSubcommand)).toBe('codex');
    expect(resolveCatalogAgentIdForCliSubcommand('__missing__')).toBeNull();
  });
});
