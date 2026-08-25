import { AgentPermissionIntentV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { describe, expect, it } from 'vitest';

import {
  bindingPermissionIntentLabel,
  bindingPermissionIntentOptions,
  parseBindingPermissionIntent,
} from './permissionIntentOptions.js';

/**
 * The canonical intent vocabulary, read from the same Protocol schema the
 * surface parses with. Restating it here would make the exhaustiveness check
 * incapable of failing: a new Protocol intent would stay silently unofferable.
 */
const canonicalPermissionIntents = (AgentPermissionIntentV1Schema.jsonSchema.anyOf ?? [])
  .map((member) => member.const);

describe('Channels permission-intent presentation', () => {
  it('offers every canonical permission intent through one localized mapping', () => {
    const t = (key: string, fallback: string) => `${key}:${fallback}`;
    const options = bindingPermissionIntentOptions(t);

    expect([...options.map(({ value }) => value)].sort())
      .toEqual([...canonicalPermissionIntents].sort());
    for (const option of options) {
      expect(bindingPermissionIntentLabel(option.value, t)).toBe(option.label);
    }
  });

  it('presents the intents in the authored order', () => {
    const t = (key: string, fallback: string) => `${key}:${fallback}`;

    expect(bindingPermissionIntentOptions(t).map(({ value }) => value)).toEqual([
      'default',
      'read-only',
      'safe-yolo',
      'yolo',
      'plan',
    ]);
  });

  it('rejects an unknown permission intent instead of presenting a different intent', () => {
    expect(parseBindingPermissionIntent('future-intent')).toBeNull();
  });
});
