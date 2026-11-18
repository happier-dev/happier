import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { readBundledPluginManifestInput } from '@/plugins/projection/registry/builtIn/manifestFile';
import {
  ensureMergedAgentCommandRegistryLoaded,
  findCommandDispatchDescriptor,
  isAgentCliCommandRoot,
} from './commandRegistry';

describe('Agent command declaration demand', () => {
  it('admits only the selected bundled Agent manifest', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-command-selection-'));
    const bundledInputs = new Set(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator => readBundledPluginManifestInput(locator)));
    const decode = vi.spyOn(JSON, 'parse');
    try {
      await ensureMergedAgentCommandRegistryLoaded({ happyHomeDir, commandRoot: 'codex' });
      const decodedBundledInputs = decode.mock.calls.filter(([input]) => bundledInputs.has(input));
      expect(decodedBundledInputs).toHaveLength(1);
      expect(findCommandDispatchDescriptor('codex')?.handler).toBeTypeOf('function');
      expect(isAgentCliCommandRoot('codex')).toBe(true);
      expect(isAgentCliCommandRoot('claude')).toBe(false);
    } finally {
      decode.mockRestore();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('selects the canonical Agent from a command with a different manifest local ID', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-command-selection-'));
    try {
      const registry = await ensureMergedAgentCommandRegistryLoaded({ happyHomeDir, commandRoot: 'ohmypi' });
      expect(registry.catalogEntriesById.ohMyPi?.cliSubcommand).toBe('ohmypi');
      expect(registry.catalogEntriesById.claude).toBeUndefined();
      expect(findCommandDispatchDescriptor('ohmypi')?.handler).toBeTypeOf('function');
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('leaves full discovery available after the selected read', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-full-discovery-'));
    try {
      await ensureMergedAgentCommandRegistryLoaded({ happyHomeDir });
      expect(findCommandDispatchDescriptor('claude')?.handler).toBeTypeOf('function');
      expect(isAgentCliCommandRoot('claude')).toBe(true);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
