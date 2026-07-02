import { describe, expect, it } from 'vitest';

import {
  parseConnectedServiceBindingSelections,
  parseConnectedServicesBindings,
} from './parseConnectedServicesBindings';

describe('parseConnectedServicesBindings', () => {
  it('returns connected bindings with profile ids', () => {
    const parsed = parseConnectedServicesBindings({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', profileId: 'work' },
        anthropic: { source: 'native' },
      },
    });
    expect(parsed).toEqual([{ serviceId: 'openai-codex', profileId: 'work' }]);
  });

  it('returns an empty list for invalid payloads', () => {
    expect(parseConnectedServicesBindings(null)).toEqual([]);
    expect(parseConnectedServicesBindings({})).toEqual([]);
  });

  it('preserves group selections with a fallback profile id', () => {
    const parsed = parseConnectedServiceBindingSelections({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'codex-main',
          profileId: 'work',
        },
      },
    });

    expect(parsed).toEqual([
      {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fallbackProfileId: 'work',
      },
    ]);
    expect(parseConnectedServicesBindings({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'codex-main',
          profileId: 'work',
        },
      },
    })).toEqual([{ serviceId: 'openai-codex', profileId: 'work' }]);
  });

  it('accepts group selections without fallback profile ids', () => {
    const parsed = parseConnectedServiceBindingSelections({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'codex-main',
        },
      },
    });

    expect(parsed).toEqual([
      {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
      },
    ]);
    expect(parseConnectedServicesBindings({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'codex-main',
        },
      },
    })).toEqual([]);
  });

  it('rejects group selections without a protocol-valid group id', () => {
    expect(parseConnectedServiceBindingSelections({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: '../global-codex-home',
          profileId: 'work',
        },
      },
    })).toEqual([]);
  });
});
