import { describe, expect, it } from 'vitest';
import { SettingsDeclarationActionInputSchemasV1 } from './settingsDeclarationActionFamily.js';

describe('Settings history purge operation admission', () => {
  it('admits only an explicit nonempty exact-version target without credential or confirmation fields', () => {
    const schema = SettingsDeclarationActionInputSchemasV1['settings.invoke'];
    const operation = { anchor: 'account.settingsHistory', input: { kind: 'account_settings_history_purge', versions: [1, 4] } };
    expect(schema.safeParse(operation).success).toBe(true);
    for (const input of [
      { ...operation.input, versions: [] },
      { ...operation.input, versions: [-1] },
      { ...operation.input, confirmed: true },
      { ...operation.input, content: { t: 'encrypted', c: 'private' } },
    ]) expect(schema.safeParse({ ...operation, input }).success).toBe(false);
  });
});
