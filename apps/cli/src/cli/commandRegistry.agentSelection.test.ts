import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';

import {
  ensureMergedAgentCommandRegistryLoaded,
  findCommandDispatchDescriptor,
  isAgentCliCommandRoot,
} from './commandRegistry';

describe('Agent command declaration demand', () => {
  // Codex refers to Connected services declared by other bundled plugins.
  it('admits the selected bundled Agent against only its reference closure', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-command-selection-'));
    const decode = vi.spyOn(fs, 'openSync');
    try {
      await ensureMergedAgentCommandRegistryLoaded({ happyHomeDir, commandRoot: 'codex' });
      const declarations = decode.mock.calls.filter(([path]) => /bundled-plugin-manifests[\\/]/.test(String(path)));
      const paths = declarations.map(([path]) => String(path));
      expect(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.length).toBeGreaterThan(20);
      expect(paths.some(path => path.endsWith('codex.json'))).toBe(true);
      expect(paths.length).toBeGreaterThan(1);
      expect(paths.length).toBeLessThanOrEqual(4);
      expect(new Set(paths).size).toBe(paths.length);
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
