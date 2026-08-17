import { describe, expect, it } from 'vitest';

import {
  CURSOR_AGENT_SETTINGS_CONTRIBUTION,
  normalizeCursorAgentFallbackEnabled,
  normalizeCursorApiEndpoint,
  normalizeCursorBinaryPath,
} from './settings.js';

describe('Cursor predecessor settings compatibility', () => {
  // Prospective predecessor vector:
  // ../remote-dev@24b6016fce2bee0e741a8fbb50ccdc5631b24ad0
  // packages/agents/src/providerSettings/definitions/cursor.ts
  it('preserves the released account field ids, local scope, defaults, and controls', () => {
    expect(CURSOR_AGENT_SETTINGS_CONTRIBUTION).toMatchObject({
      id: 'agent-settings',
      version: 1,
      target: { kind: 'agent', agent: 'cursor' },
      scope: 'daemon',
      fields: [
        {
          id: 'cursorBinaryPath',
          schema: { type: 'string' },
          default: '',
          presentation: { control: 'text' },
        },
        {
          id: 'cursorAgentFallbackEnabled',
          schema: { type: 'boolean' },
          default: true,
          presentation: { control: 'switch' },
        },
        {
          id: 'cursorApiEndpoint',
          schema: { type: 'string' },
          default: '',
          presentation: { control: 'text' },
        },
      ],
      presentation: {
        sections: [{
          fields: [
            'cursorBinaryPath',
            'cursorAgentFallbackEnabled',
            'cursorApiEndpoint',
          ],
        }],
      },
    });
  });

  it('matches predecessor normalization for persisted string and boolean values', () => {
    expect(normalizeCursorBinaryPath('  /opt/cursor-agent  ')).toBe('/opt/cursor-agent');
    expect(normalizeCursorBinaryPath(null)).toBe('');
    expect(normalizeCursorApiEndpoint('  https://cursor.example.test  '))
      .toBe('https://cursor.example.test');
    expect(normalizeCursorApiEndpoint(undefined)).toBe('');

    for (const disabled of [false, '0', ' false ', 'NO']) {
      expect(normalizeCursorAgentFallbackEnabled(disabled)).toBe(false);
    }
    for (const enabled of [true, '1', 'yes', null, undefined]) {
      expect(normalizeCursorAgentFallbackEnabled(enabled)).toBe(true);
    }
  });
});
