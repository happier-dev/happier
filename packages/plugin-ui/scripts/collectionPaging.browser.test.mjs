import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const requireUi = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));
const uiPackage = name => dirname(requireUi.resolve(`${name}/package.json`));

function readReadingAnchor(scroller) {
  const bounds = scroller.getBoundingClientRect();
  const row = document.elementFromPoint(bounds.left + 26, bounds.top + 22)?.closest('[data-testid^="file-"]');
  return row ? { path: row.textContent, top: row.getBoundingClientRect().top - bounds.top } : null;
}

test('paging a grouped List starts after the loaded rows and holds the reading anchor beside an open diff', async () => {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: resolve(repositoryRoot, 'packages/plugin-ui'),
      sourcefile: 'collectionPaging.browser.fixture.tsx',
      loader: 'tsx',
      contents: `
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Button } from './src/components/Button.tsx';
        import { List } from './src/components/List.tsx';
        import { PluginUiProviderInternal } from './src/components/PluginUiProvider.tsx';
        import { createSurfaceContextFixture } from '../plugin-sdk/src/ui/surfaceContext.fixture.ts';

        const context = createSurfaceContextFixture();
        const hostApi = {
          watchContext: async () => ({ dispose() {} }),
          readResource: async () => { throw new Error('This fixture needs no Resources'); },
        };
        const file = 'long-diff.txt';
        const files = Array.from({ length: 199 }, (_, index) => 'file-' + (index + 1));
        const firstPage = [file, ...files.slice(0, 99)];
        const secondPage = [file, ...files];
        const sections = rows => [{ key: 'source', title: '', data: rows }];
        const firstSections = sections(firstPage);
        const secondSections = sections(secondPage);
        const keyForItem = path => path;

        function Fixture() {
          const [expanded, setExpanded] = useState(false);
          const [pending, setPending] = useState(false);
          const [append, setAppend] = useState(false);
          return <List sections={append ? secondSections : firstSections} keyForItem={keyForItem}
            accessibilityLabel="Files" density="flush" renderItem={path => <List.Item title={path} testID={path}
              {...(path === file ? {
                onPress: () => setExpanded(value => !value),
                expanded,
                expandedContent: <div data-testid="expanded-diff" style={{ height: 31200 }}>Diff contents</div>,
              } : {})} />}
            endContent={append ? undefined : <Button title="Show more files" busy={pending} onPress={() => {
              setPending(true);
              window.deliverNextPage = () => { setAppend(true); setPending(false); };
            }} />}
          />;
        }

        createRoot(document.getElementById('root')).render(
          <PluginUiProviderInternal hostApi={hostApi} context={context}><Fixture /></PluginUiProviderInternal>,
        );
      `,
    },
    bundle: true, write: false, jsx: 'automatic', conditions: ['happier-source', 'browser'],
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { react: uiPackage('react'), 'react-dom': uiPackage('react-dom'),
      'react-native': uiPackage('react-native-web'),
      'react-native-svg': requireUi.resolve('react-native-svg/lib/module/elements.web.js') },
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root" style="height:211px;width:460px;display:flex;flex-direction:column"></div>');
    await page.addScriptTag({ content: outputFiles[0].text });
    const list = page.getByRole('list', { name: 'Files' });
    const disclosure = page.getByRole('button', { name: 'long-diff.txt' });
    await disclosure.click();
    await page.getByTestId('expanded-diff').waitFor();
    await page.waitForFunction(() => {
      const scroller = document.querySelector('ul[aria-label="Files"]');
      const bottom = scroller.getBoundingClientRect().bottom;
      const more = [...scroller.querySelectorAll('button')].find(button => button.textContent === 'Show more files');
      if (more && more.getBoundingClientRect().bottom <= bottom) return true;
      scroller.scrollTop = scroller.scrollHeight;
      return false;
    });
    const lastRowVisible = await list.evaluate(scroller => {
      const bounds = scroller.getBoundingClientRect();
      const lastRow = scroller.querySelector('[data-testid="file-99"]');
      return Boolean(lastRow && lastRow.getBoundingClientRect().bottom <= bounds.bottom);
    });
    assert.equal(lastRowVisible, true, 'paging must appear after the last loaded row, even while the diff is open');
    const before = await list.evaluate(readReadingAnchor);
    assert.match(before?.path ?? '', /^file-\d+$/);

    const more = page.getByRole('button', { name: 'Show more files' });
    const hit = await more.boundingBox();
    await page.mouse.click(hit.x + hit.width / 2, hit.y + hit.height / 2);
    await page.waitForFunction(() => Boolean(window.deliverNextPage));
    await page.evaluate(() => window.deliverNextPage());
    await page.getByText('file-100', { exact: true }).waitFor();

    assert.deepEqual(await list.evaluate(readReadingAnchor), before);
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByTestId('expanded-diff').evaluate(node => node.getBoundingClientRect().height), 31200);
  } finally {
    await browser.close();
  }
});
