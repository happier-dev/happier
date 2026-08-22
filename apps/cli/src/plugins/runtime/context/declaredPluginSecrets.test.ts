import { describe, expect, it } from 'vitest';

import { collectDeclaredPluginSecrets } from './declaredPluginSecrets';

const manifest = (
  secrets: readonly Readonly<{ id: string; custody?: 'account' | 'daemon' }>[],
  settingFields: readonly Readonly<{ id: string; secret?: unknown }>[] = [],
) => ({
  secrets,
  contributes: settingFields.length > 0 ? { settings: [{ fields: settingFields }] } : {},
}) as never;

describe('declared plugin secret collection', () => {
  it('collects every plugin declaration when each plugin is coherent', () => {
    const collected = collectDeclaredPluginSecrets([
      { pluginId: 'a.plugin', manifest: manifest([{ id: 'token', custody: 'account' }]) },
      { pluginId: 'b.plugin', manifest: manifest([{ id: 'apiKey', custody: 'daemon' }]) },
    ]);
    expect(collected.map((entry) => [entry.pluginId, entry.declaration.id]))
      .toEqual([['a.plugin', 'token'], ['b.plugin', 'apiKey']]);
  });

  it('isolates one plugin whose secret custody declarations contradict each other', () => {
    const refused: { pluginId: string; secretId: string }[] = [];
    const collected = collectDeclaredPluginSecrets(
      [
        {
          pluginId: 'bad.plugin',
          manifest: manifest(
            [{ id: 'token', custody: 'daemon' }, { id: 'other', custody: 'account' }],
            [{ id: 'token', secret: { custody: 'account' } }],
          ),
        },
        { pluginId: 'good.plugin', manifest: manifest([{ id: 'apiKey', custody: 'account' }]) },
      ],
      {
        onSecretDeclarationRefused: (input) => {
          refused.push({ pluginId: input.pluginId, secretId: input.secretId });
        },
      },
    );
    // Every other plugin keeps its declarations.
    expect(collected.some((entry) => entry.pluginId === 'good.plugin' && entry.declaration.id === 'apiKey'))
      .toBe(true);
    // The contested id is admitted for neither claimant: custody must never be
    // decided by declaration order.
    expect(collected.some((entry) => entry.pluginId === 'bad.plugin' && entry.declaration.id === 'token'))
      .toBe(false);
    // The mis-authored plugin keeps its coherent declarations.
    expect(collected.some((entry) => entry.pluginId === 'bad.plugin' && entry.declaration.id === 'other'))
      .toBe(true);
    // The refusal is reported, never silently dropped.
    expect(refused).toEqual([{ pluginId: 'bad.plugin', secretId: 'token' }]);
  });

  it('still fails closed for the caller that scopes the collection to one plugin', () => {
    expect(() => collectDeclaredPluginSecrets([{
      pluginId: 'bad.plugin',
      manifest: manifest(
        [{ id: 'token', custody: 'daemon' }],
        [{ id: 'token', secret: { custody: 'account' } }],
      ),
    }])).toThrow('conflicting custody');
  });
});
