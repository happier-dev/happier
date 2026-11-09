import { describe, expect, it } from 'vitest';
import { getBundledProjectStartersV1 } from '@happier-dev/protocol';
import { SUPPORTED_LANGUAGE_CODES } from '@/text/_all';
import { preloadLocaleBundle, readLocaleBundle } from '@/text/localeBundlesSync';
import { PROJECT_STARTER_PREVIEW_ASSETS } from './projectStarterPreviewAssets';

function readPath(root: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => value && typeof value === 'object' ? Reflect.get(value, part) : undefined, root);
}

describe('bundled Project starter presentation data', () => {
  it('resolves every bundled descriptor to local artwork and real copy in each supported locale', async () => {
    const starters = getBundledProjectStartersV1();
    for (const language of SUPPORTED_LANGUAGE_CODES) {
      await preloadLocaleBundle(language);
      const host = readLocaleBundle(language)?.host;
      for (const starter of starters) {
        for (const key of [starter.titleKey, starter.summaryKey]) {
          const value = readPath(host, key);
          expect(typeof value, `${language}: ${key}`).toBe('string');
          expect(value).not.toBe(key);
        }
        const source = PROJECT_STARTER_PREVIEW_ASSETS[starter.previewAssetKey];
        expect(source).toBeDefined();
        expect(source).toBe(PROJECT_STARTER_PREVIEW_ASSETS[starter.previewAssetKey]);
        expect(Object.isFrozen(source)).toBe(true);
        expect(source.uri).toMatch(/^data:image\/svg\+xml;/);
      }
    }
  });
});
