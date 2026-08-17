import { describe, expect, it } from 'vitest';

import {
  ChangeEntrySchema,
  ChangeKindSchema,
  PluginDomainAvailabilityChangeHintSchema,
  PluginDomainChangeHintSchema,
  PluginDomainWebhookChangeHintSchema,
  buildPluginDomainAccountChangeEntityId,
} from './index.js';

describe('pluginDomain AccountChange entries', () => {
  it('admits only the closed content-free core arms with their canonical entity ids', () => {
    const hints = [
      {
        pluginDomain: 'dataKv',
        pluginId: 'example.tasks',
        keys: ['draft'],
      },
      {
        pluginDomain: 'dataKv',
        pluginId: 'example.tasks',
        full: true,
      },
      {
        pluginDomain: 'dataCollection',
        pluginId: 'example.tasks',
        collectionId: 'tasks',
        contractDigest: 'a'.repeat(43),
        revision: 4,
        rowIds: ['task-1'],
      },
      {
        pluginDomain: 'dataCollection',
        pluginId: 'example.tasks',
        collectionId: 'tasks',
        contractDigest: 'a'.repeat(43),
        revision: 5,
        full: true,
      },
      {
        pluginDomain: 'settings',
        pluginId: 'example.tasks',
        scope: 'account',
        revision: 6,
      },
      {
        pluginDomain: 'availability',
        pluginId: 'example.tasks',
      },
      {
        pluginDomain: 'webhook',
        pluginId: 'example.tasks',
      },
    ] as const;

    expect(ChangeKindSchema.parse('pluginDomain')).toBe('pluginDomain');
    for (const hint of hints) {
      const parsedHint = PluginDomainChangeHintSchema.parse(hint);
      expect(ChangeEntrySchema.parse({
        cursor: 9,
        kind: 'pluginDomain',
        entityId: buildPluginDomainAccountChangeEntityId(parsedHint),
        changedAt: 10,
        hint,
      })).toMatchObject({ kind: 'pluginDomain', hint });
    }
  });

  it('keeps availability and webhook invalidations content-free and level-triggered', () => {
    expect(PluginDomainAvailabilityChangeHintSchema.parse({
      pluginDomain: 'availability',
      pluginId: 'example.tasks',
    })).toEqual({
      pluginDomain: 'availability',
      pluginId: 'example.tasks',
    });
    expect(() => PluginDomainAvailabilityChangeHintSchema.parse({
      pluginDomain: 'availability',
      pluginId: 'example.tasks',
      action: 'changed',
    })).toThrow();
    expect(PluginDomainWebhookChangeHintSchema.parse({
      pluginDomain: 'webhook',
      pluginId: 'example.tasks',
    })).toEqual({
      pluginDomain: 'webhook',
      pluginId: 'example.tasks',
    });
    expect(() => PluginDomainWebhookChangeHintSchema.parse({
      pluginDomain: 'webhook',
      pluginId: 'example.tasks',
      webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
    })).toThrow();
  });

  it('rejects a deferred transport arm, content-bearing hint, or identity mismatch', () => {
    const base = {
      cursor: 9,
      kind: 'pluginDomain',
      entityId: 'pluginDomain/example.tasks/data-collection/tasks',
      changedAt: 10,
    } as const;

    expect(() => ChangeEntrySchema.parse({
      ...base,
      hint: { pluginDomain: 'http', pluginId: 'example.tasks' },
    })).toThrow();
    expect(() => ChangeEntrySchema.parse({
      ...base,
      hint: {
        pluginDomain: 'dataCollection',
        pluginId: 'example.tasks',
        collectionId: 'tasks',
        contractDigest: 'a'.repeat(43),
        revision: 1,
        rowIds: ['task-1'],
        value: { secret: 'must not cross AccountChange' },
      },
    })).toThrow();
    expect(() => ChangeEntrySchema.parse({
      ...base,
      entityId: 'pluginDomain/example.tasks/settings',
      hint: {
        pluginDomain: 'dataCollection',
        pluginId: 'example.tasks',
        collectionId: 'tasks',
        contractDigest: 'a'.repeat(43),
        revision: 1,
        full: true,
      },
    })).toThrow();
    expect(() => ChangeEntrySchema.parse({
      ...base,
      hint: {
        pluginDomain: 'dataCollection',
        pluginId: 'example.tasks',
        collectionId: 'tasks',
        contractDigest: 'a'.repeat(43),
        revision: 1,
        rowIds: ['task-1', 'task-1'],
      },
    })).toThrow();
  });
});
