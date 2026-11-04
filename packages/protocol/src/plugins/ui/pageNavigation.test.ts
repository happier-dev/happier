import { describe, expect, it } from 'vitest';
import { PluginUiSetPageNavigationRequestV1Schema, PluginUiPageNavigationProjectionV1Schema } from './pageNavigation.js';

describe('page navigation presentation contract', () => {
  it('admits portable page Items and rejects executable content and open nested identities', () => {
    const navigation = { pageKind: { pluginId: 'happier.triage', localId: 'entry' }, value: 'overview', items: [
      { value: 'overview', title: 'Overview', kind: 'page', phonePlacement: 'bar', glyph: 'info' },
      { value: 'source:comments', title: 'Comments', kind: 'page', phonePlacement: 'more' },
    ] };
    expect(PluginUiSetPageNavigationRequestV1Schema.parse({ navigation })).toEqual({ navigation });
    expect(PluginUiSetPageNavigationRequestV1Schema.parse({ navigation: null })).toEqual({ navigation: null });
    for (const invalid of [
      { ...navigation, children: 'body' },
      { ...navigation, pageKind: { ...navigation.pageKind, authority: true } },
      { ...navigation, items: [{ ...navigation.items[0], onSelect: 'callback' }] },
      { ...navigation, items: [{ ...navigation.items[0], kind: 'both' }] },
    ]) expect(PluginUiSetPageNavigationRequestV1Schema.safeParse({ navigation: invalid }).success).toBe(false);
  });

  it('carries only ordered strip ids, presentation and an optional transient request', () => {
    const projection = { pageKind: { pluginId: 'happier.triage', localId: 'entry' }, tabIds: ['files', 'overview'], overflowIds: ['comments'], presentation: 'top', request: 'files' };
    expect(PluginUiPageNavigationProjectionV1Schema.parse(projection)).toEqual(projection);
    expect(PluginUiPageNavigationProjectionV1Schema.safeParse({ ...projection, sequence: 1 }).success).toBe(false);
  });
});
