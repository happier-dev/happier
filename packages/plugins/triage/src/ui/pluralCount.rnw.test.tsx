// @vitest-environment jsdom
import { URL as NodeURL } from 'node:url';
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { readPluginTranslationResources } from '../../../../../scripts/testing/readPluginTranslationResources.js';
import { useTriagePluralCount } from './pluralCount.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const catalogs = readPluginTranslationResources(new NodeURL('../../', import.meta.url));
const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the findings count in the reader’s locale', () => {
  // French zero uses `one`; English zero uses `other`. Together with 1/2,
  // this rejects both a fixed suffix and plural rules fixed to English.
  it.each([
    { locale: 'en', count: 1, expected: '1 finding' },
    { locale: 'en', count: 2, expected: '2 findings' },
    { locale: 'fr', count: 0, expected: '0 constat' },
    { locale: 'fr', count: 2, expected: '2 constats' },
  ] as const)('renders $count findings in $locale as $expected', async ({ locale, count, expected }) => {
    const surface = defineUiSurface(function FindingsCount(): React.ReactElement {
      const pluralCount = useTriagePluralCount();
      return <Text value={pluralCount('surface.detail.agent.findings', count,
        { one: '{count} finding', other: '{count} findings' })} />;
    });
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-findings-count', mountNonce: `findings-${locale}-${count}` },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface,
        surfaceContext: createSurfaceContextFixture({ locale, translations: catalogs[locale] }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      });
    });
    mounted.push(fixture);
    await expect(fixture.getByText(expected)).resolves.toBeDefined();
  });
});
