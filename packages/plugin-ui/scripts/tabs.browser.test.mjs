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

test('Tab enters a text-only panel and uses its controls when async content becomes interactive', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve(repositoryRoot, 'packages/plugin-ui'),
      sourcefile: 'tabs.browser.fixture.tsx', loader: 'tsx',
      contents: `
        import { useEffect, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { HappierTabs } from './src/presentation/navigation/Tabs.tsx';
        import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../plugin-sdk/src/ui/surfaceContext.fixture.ts';
        function Item() { return null; }
        function Body() {
          const [interactive, setInteractive] = useState(false);
          useEffect(() => { window.setPanelInteractive = setInteractive; }, []);
          return <>
            <p>Sampled sessions are not recordings.</p>
            <button disabled>Replay unavailable</button>
            <div hidden><button>Hidden replay</button></div>
            {interactive ? <input aria-label="Session filter" /> : null}
          </>;
        }
        function Fixture() {
          const [value, setValue] = useState('sessions');
          return <>
            <HappierTabs value={value} onValueChange={setValue} ariaLabel="Issue sections" theme={theme}
              trailing={<button>More</button>}>
              <Item value="sessions" title="Affected sessions" retention="retain"><Body /></Item>
              <Item value="overview" title="Overview"><button>Open issue</button></Item>
            </HappierTabs>
            <button>After tabs</button>
            <HappierTabs value="widgets" onValueChange={() => {}} ariaLabel="Widget views" theme={theme}
              sharedPanel={null} trailing={<button>New widget</button>}>
              <Item value="widgets" title="Widgets" />
              <Item value="activity" title="Widget activity" />
            </HappierTabs>
          </>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `,
    },
    bundle: true, write: false, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { react: uiPackage('react'), 'react-dom': uiPackage('react-dom'),
      'react-native': uiPackage('react-native-web'),
      'react-native-svg': requireUi.resolve('react-native-svg/lib/module/elements.web.js') },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const selected = page.getByRole('tab', { name: 'Affected sessions', exact: true });
    const panel = page.getByRole('tabpanel');
    await selected.focus();
    await page.keyboard.press('Tab');
    assert.equal(await panel.evaluate(node => node === document.activeElement), true,
      'Tab must enter the text-only panel instead of skipping to More');
    assert.equal(await panel.getAttribute('tabindex'), '0');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await selected.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.getByRole('button', { name: 'More', exact: true }).evaluate(node => node === document.activeElement), true,
      'More stays keyboard reachable before the tablist');
    await page.keyboard.press('Tab');
    assert.equal(await selected.evaluate(node => node === document.activeElement), true);

    // The panel's parent props do not change: its mounted child receives data later.
    await page.evaluate(() => window.setPanelInteractive(true));
    await page.getByRole('textbox', { name: 'Session filter' }).waitFor();
    await page.waitForFunction(() => document.querySelector('[role=tabpanel]')?.getAttribute('tabindex') === null);
    await selected.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('textbox', { name: 'Session filter' }).evaluate(node => node === document.activeElement), true);

    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    const hidden = page.locator('[role=tabpanel][aria-hidden=true]');
    assert.equal(await hidden.getAttribute('tabindex'), null, 'A retained inactive panel must not join tab order');
    await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: 'Open issue', exact: true }).evaluate(node => node === document.activeElement), true);

    await selected.click();
    await page.evaluate(() => window.setPanelInteractive(false));
    await page.waitForFunction(() => document.querySelector('[role=tabpanel]:not([aria-hidden=true])')?.getAttribute('tabindex') === '0');
    await selected.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('tabpanel').evaluate(node => node === document.activeElement), true);

    await page.getByRole('tab', { name: 'Widgets', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: 'New widget', exact: true }).evaluate(node => node === document.activeElement), true,
      'A strip whose host renders its panel elsewhere keeps the trailing control next in tab order');
  } finally { await browser.close(); }
});
