import { describe, expect, it } from 'vitest';

import {
  PluginIdSchema,
  encodePluginIdForFilesystem,
  isReservedHappierPluginId,
} from './pluginId.js';

describe('PluginIdSchema', () => {
  it('accepts lower-case dotted owner ids including first-party namespaces', () => {
    expect(PluginIdSchema.parse('acme.plugin')).toBe('acme.plugin');
    expect(PluginIdSchema.parse('happier.agent.codex')).toBe('happier.agent.codex');
    expect(PluginIdSchema.parse('happier.scm.hosting.github')).toBe('happier.scm.hosting.github');
    expect(PluginIdSchema.parse('happier.scm.backend.git')).toBe('happier.scm.backend.git');
  });

  it('rejects short, uppercase, reserved, and path-like owner ids', () => {
    for (const id of [
      'codex',
      'claude',
      'opencode',
      'scm-github',
      'Acme.Plugin',
      'acme.Plugin',
      'acme_plugin.tool',
      'acme.__proto__',
      'acme/plugin',
      'acme\\plugin',
      '.acme.plugin',
      'acme.plugin.',
    ]) {
      expect(PluginIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('identifies the host-reserved happier namespace separately from syntax validation', () => {
    expect(isReservedHappierPluginId('happier.agent.codex')).toBe(true);
    expect(isReservedHappierPluginId('acme.plugin')).toBe(false);
  });

  it('encodes canonical owner ids for filesystem storage without changing their identity', () => {
    expect(encodePluginIdForFilesystem(' happier.agent.codex ')).toBe('happier.agent.codex');
    expect(encodePluginIdForFilesystem('acme.plugin')).toBe('acme.plugin');
  });
});
