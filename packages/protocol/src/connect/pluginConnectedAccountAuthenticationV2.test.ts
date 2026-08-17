import { describe, expect, it } from 'vitest';

import { PluginConnectedAccountConfigurationFieldV2Schema } from './pluginConnectedAccountAuthenticationV2.js';

/**
 * A deployment a user picks from a closed list is routing configuration, not a
 * URL the user is asked to retype. The descriptor declares the closed choice set
 * and the exact canonical origin each choice resolves to; the host derives the
 * route from that declaration, so no free-form origin field has to stand in for
 * a fixed one.
 */
describe('connected-account fixed-origin configuration semantic', () => {
  const field = {
    id: 'region',
    title: 'Region',
    semantic: 'connectedAccountFixedOrigin',
    required: true,
    schema: { type: 'string', enum: ['us', 'de'] },
    originByValue: {
      us: 'https://us.example.test',
      de: 'https://de.example.test',
    },
  } as const;

  it('declares a closed choice set with one canonical origin per choice', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.parse(field)).toEqual({
      ...field,
      secret: false,
    });
  });

  it('refuses a choice set that does not exactly match its declared origins', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      schema: { type: 'string', enum: ['us', 'de', 'jp'] },
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      originByValue: {
        ...field.originByValue,
        jp: 'https://jp.example.test',
      },
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      schema: { type: 'string', minLength: 1 },
    }).success).toBe(false);
  });

  it('refuses a declared origin that is not an exact credential-free origin', () => {
    for (const declared of [
      'https://us.example.test/api',
      'https://user:secret@us.example.test',
      'ftp://us.example.test',
      'https://us.example.test/',
    ]) {
      expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
        ...field,
        originByValue: { ...field.originByValue, us: declared },
      }).success).toBe(false);
    }
  });

  it('keeps the descriptor from authoring a default or a secret route', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      default: 'us',
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      secret: true,
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      required: undefined,
    }).success).toBe(false);
  });

  it('leaves the free-form configured-origin semantic closed to a choice set', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      id: 'origin',
      title: 'Origin',
      semantic: 'connectedAccountOrigin',
      required: true,
      schema: { type: 'string', enum: ['https://us.example.test'] },
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      id: 'origin',
      title: 'Origin',
      semantic: 'connectedAccountOrigin',
      required: true,
      schema: { type: 'string', minLength: 1 },
      originByValue: { us: 'https://us.example.test' },
    }).success).toBe(false);
  });
});

/**
 * A configured *service base* is a distinct declaration from an origin: it may
 * live beneath a path segment, and it is never a closed choice set.
 */
describe('connected-account service-base configuration semantic', () => {
  const field = {
    id: 'service-base',
    title: 'Service base',
    semantic: 'connectedAccountBase',
    required: true,
    schema: { type: 'string', minLength: 1 },
  } as const;

  it('declares a required non-secret free-form base', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.parse(field)).toEqual({
      ...field,
      secret: false,
    });
  });

  it('refuses a default, an optional base, and a fixed-origin route table', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      default: 'https://dev.azure.test/acme',
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      required: false,
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      originByValue: { acme: 'https://dev.azure.test' },
    }).success).toBe(false);
  });
});
