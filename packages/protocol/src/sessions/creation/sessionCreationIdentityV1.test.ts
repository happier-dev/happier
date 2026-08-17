import { describe, expect, it } from 'vitest';

import {
  deriveSessionCreationTagV1,
  SessionCreationKeyV1Schema,
} from './sessionCreationIdentityV1.js';

describe('Session creation identity V1', () => {
  it('trims one caller key and derives the opaque domain-separated server tag', () => {
    expect(SessionCreationKeyV1Schema.parse('  job-7  ')).toBe('job-7');
    expect(deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:com.example.demo',
      creationKey: '  job-7  ',
    })).toBe('create:v1:qOuEJH0e7x38dzVI6qgyMvoQ1FFbnWGc3sIIhMMqyCo');
  });

  it('keeps equally named caller keys separate by host-owned namespace', () => {
    const pluginTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:one',
      creationKey: 'durable-operation',
    });
    const userTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'durable-operation',
    });

    expect(pluginTag).not.toBe(userTag);
    expect(pluginTag).toMatch(/^create:v1:[A-Za-z0-9_-]{43}$/u);
    expect(pluginTag).not.toContain('durable-operation');
  });

  it('rejects blank and over-byte-limit public creation keys', () => {
    expect(() => SessionCreationKeyV1Schema.parse(' \t ')).toThrow();
    expect(() => SessionCreationKeyV1Schema.parse('é'.repeat(129))).toThrow();
  });
});
