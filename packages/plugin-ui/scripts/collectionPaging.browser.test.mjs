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


test('the page List retains a keyed Files anchor at 390 px', async t => {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: resolve(repositoryRoot, 'packages/plugin-ui'),
      sourcefile: 'collectionPageAnchoring.browser.fixture.tsx',
      loader: 'tsx',
      contents: `
        import { useLayoutEffect, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Button, ScrollArea } from './src/index.ts';
        import { PluginUiProviderInternal } from './src/components/PluginUiProvider.tsx';
        import { PluginUiPresentationHostProviderInternal } from './src/presentationHost/context.ts';
        import { createSurfaceContextFixture } from '../plugin-sdk/src/ui/surfaceContext.fixture.ts';
        import { TriageChangedFilesList } from '../triage-sources/src/ui/changedFilesList.tsx';
        import { TriageDetailPageScrollProvider, TriageDetailPanel } from '../triage-sources/src/ui/detailPanel.tsx';
        import { createScrollViewNearViewportTracker } from '@/components/widgets/nearViewport';
        import { TriageDetailPageLeadProvider, TriageDetailTabbedBody } from '../plugins/triage/src/ui/detail/body.tsx';
        import { planTriageDetailTabsV1 } from '../plugins/triage/src/ui/detail/tabs.ts';
        import { GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../plugins/scm-github/src/triage/contribution.ts';
        import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

        const files = Array.from({ length: 200 }, (_, index) => ({
          path: 'fixture/alpha/row-' + String(index + 1).padStart(3, '0') + '.txt', diffAvailable: true,
        }));
        const fixture = createSurfaceContextFixture();
        const context = { ...fixture, theme: { ...fixture.theme, typography: {
          ...fixture.theme.typography, reading: { ...fixture.theme.typography.reading, lineHeight: 41 },
        } } };
        const hostApi = {
          version: () => ({ methods: [] }),
          watchContext: async () => ({ dispose() {} }),
          readResource: async () => { throw new Error('This fixture needs no Resources'); },
        };
        const host = {
          renderIcon: () => null,
          createScrollActivityTracker: (ref, horizontal) =>
            createScrollViewNearViewportTracker(ref, horizontal, { initialViewportHeight: 715 }),
        };

        const plan = planTriageDetailTabsV1({ workflowSubject: 'pullRequest',
          entryTabs: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.kinds.find(kind => kind.workflowSubject === 'pullRequest').detailTabs,
          fixPullRequest: null });
        const entry = { surface: {}, input: createTriageSourceV1Fixture().detailInput, instanceKey: 'pull-request' };
        const handoffHost = { ...host, renderTargetedSurface: ({ input }) =>
          <TriageDetailPanel panel={input.panel} scrollOwner={input.panelScrollOwner} ariaLabel="Pull request source"
            retention={{ files: 'retain' }} panels={{
              overview: <div>Overview content</div>,
              files: <TriageChangedFilesList accessibilityLabel="Files" accessibilityLabelKey="fixture.files"
                active={input.panel === 'files'} sections={[{ key: 'source', title: '', data: files }]}
                focusPath={null} onFocusPath={() => {}} viewed={null} renderBody={() => null} />,
            }} /> };

        function ResizableDetail() {
          const [pushed, setPushed] = useState(false);
          useLayoutEffect(() => {
            const media = matchMedia('(max-width: 480px)');
            const publish = () => setPushed(media.matches);
            publish();
            media.addEventListener('change', publish);
            return () => media.removeEventListener('change', publish);
          }, []);
          return <PluginUiPresentationHostProviderInternal host={handoffHost}>
            <TriageDetailPageLeadProvider lead={pushed ? <div style={{ height: 180 }}>Entry title and facts</div> : null}>
              <TriageDetailTabbedBody pushed={pushed} tabs={plan.tabs} entry={entry} fixPullRequest={null}
                overviewTail={null} fallback={<div>Panel unavailable</div>} />
            </TriageDetailPageLeadProvider>
          </PluginUiPresentationHostProviderInternal>;
        }

        function Fixture() {
          const [panel, setPanel] = useState('files');
          const [rows, setRows] = useState(() => files.slice(0, 100));
          const [focusPath, setFocusPath] = useState(null);
          return <>
            <button onClick={() => { setFocusPath(null); setPanel('checks'); }}>Checks tab</button>
            <button onClick={() => setPanel('files')}>Files tab</button>
            <TriageDetailPageScrollProvider pageScroll>
              <ScrollArea testID="page-scroll" style={{ height: 715 }} scrollEventThrottle={16}>
                <TriageDetailPanel panel={panel} scrollOwner="list" ariaLabel="Pull request" retention={{ files: 'retain' }}
                  panels={{
                    files: <TriageChangedFilesList accessibilityLabel="Files" accessibilityLabelKey="fixture.files"
                      active={panel === 'files'} sections={[{ key: 'source', title: '', data: rows }]} focusPath={focusPath}
                      onFocusPath={setFocusPath} viewed={null} header={<div style={{ height: 100 }}>Files</div>}
                      renderBody={() => <div data-testid="expanded-diff" style={{ height: 200 }}>Diff</div>}
                      endContent={<Button title="Show more files" onPress={() => {
                        window.deliverNextPage = () => {
                          const next = [...files];
                          if (window.sortNewRows) next.push({ path: 'fixture/alpha/row-005z.txt', diffAvailable: true });
                          setRows(next.sort((left, right) => left.path.localeCompare(right.path)));
                        };
                      }} />} />,
                    checks: <span>No checks</span>,
                  }} />
              </ScrollArea>
            </TriageDetailPageScrollProvider>
          </>;
        }

        createRoot(document.getElementById('root')).render(
          <PluginUiProviderInternal hostApi={hostApi} context={context}>
            <PluginUiPresentationHostProviderInternal host={host}>
              {document.getElementById('root').dataset.handoff ? <ResizableDetail /> : <Fixture />}
            </PluginUiPresentationHostProviderInternal>
          </PluginUiProviderInternal>,
        );
      `,
    },
    bundle: true, write: false, jsx: 'automatic', conditions: ['happier-source', 'browser'],
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@': resolve(repositoryRoot, 'apps/ui/sources'), react: uiPackage('react'), 'react-dom': uiPackage('react-dom'),
      'react-native': uiPackage('react-native-web'),
      'react-native-svg': requireUi.resolve('react-native-svg/lib/module/elements.web.js') },
  });

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  function readPageAnchor() {
    const scroller = document.querySelector('[data-testid="page-scroll"]');
    const bounds = scroller.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + 30, bounds.top + 24)?.closest('[role="listitem"]');
    const row = hit ?? [...scroller.querySelectorAll('[role="listitem"]')].find(item => {
      const rect = item.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > bounds.top + 24 && rect.top < bounds.bottom;
    });
    return row === undefined ? null : {
      path: row.textContent.match(/fixture\/alpha\/row-\d+z?\.txt/)?.[0],
      top: row.getBoundingClientRect().top - bounds.top,
    };
  }

  async function readSettledAnchor(page) {
    return page.evaluate(async () => {
      let last;
      let stableFrames = 0;
      for (let frame = 0; frame < 180; frame++) {
        await new Promise(requestAnimationFrame);
        const anchor = window.readPageAnchor();
        const scroller = document.querySelector('[data-testid="page-scroll"]');
        const snapshot = JSON.stringify([anchor, scroller.scrollTop, scroller.scrollHeight]);
        stableFrames = snapshot === last ? stableFrames + 1 : 0;
        if (stableFrames === 10) return anchor;
        last = snapshot;
      }
      throw new Error('The page anchor never settled');
    });
  }

  async function mountPage(t, { openDiff = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    t.after(() => page.close());
    await page.setContent('<div id="root" style="height:780px;display:flex;flex-direction:column"></div>');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.evaluate(source => {
      window.readPageAnchor = new Function('return (' + source + ')')();
      document.addEventListener('pointerdown', event => {
        if (event.target.closest('button,[role="button"]')?.textContent === 'Show more files') {
          window.anchorAtPress = window.readPageAnchor();
        }
      }, true);
    }, readPageAnchor.toString());
    if (openDiff) {
      await page.getByRole('button', { name: /row-001\.txt/ }).click();
      await page.getByTestId('expanded-diff').waitFor();
    }
    const more = await page.getByRole('button', { name: 'Show more files' }).elementHandle();
    await more.evaluate(node => node.scrollIntoView({ block: 'nearest' }));
    // Start from a stable reading position with the button already visible.
    await readSettledAnchor(page);
    await page.waitForFunction(node => {
      const scroller = document.querySelector('[data-testid="page-scroll"]');
      if (node.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().bottom) return true;
      node.scrollIntoView({ block: 'nearest' });
      return false;
    }, more);
    const before = await readSettledAnchor(page);
    const point = await more.boundingBox();
    await page.mouse.click(point.x + point.width / 2, point.y + point.height / 2);
    await page.waitForFunction(() => Boolean(window.deliverNextPage));
    assert.match(before?.path ?? '', /^fixture\/alpha\/row-\d+\.txt$/);
    assert.deepEqual(await page.evaluate(() => window.anchorAtPress), before);
    return { page, before };
  }

  await t.test('sorted paging keeps the pressed row and inset beside an open diff', async t => {
    const { page, before } = await mountPage(t, { openDiff: true });
    await page.evaluate(() => { window.sortNewRows = true; window.deliverNextPage(); });
    await page.getByRole('button', { name: /row-101\.txt/ }).waitFor({ state: 'attached' });
    assert.deepEqual(await readSettledAnchor(page), before);
    assert.equal(await page.getByRole('button', { name: /row-001\.txt/ }).getAttribute('aria-expanded'), 'true');
  });

  await t.test('tab return keeps the last physical offset before a pending scroll notification', async t => {
    const { page, before } = await mountPage(t);
    await page.evaluate(() => window.deliverNextPage());
    await page.getByRole('button', { name: /row-101\.txt/ }).waitFor({ state: 'attached' });
    assert.deepEqual(await readSettledAnchor(page), before);
    const leaving = await page.getByRole('button', { name: 'Checks tab' }).evaluate(button => {
      // The browser can move during a flick without delivering RNW's scroll event before the tab click.
      document.querySelector('[data-testid="page-scroll"]').scrollTop -= 67;
      const anchor = window.readPageAnchor();
      button.click();
      return anchor;
    });
    assert.notDeepEqual(leaving, before);
    await page.getByText('No checks').waitFor();
    await page.getByRole('button', { name: 'Files tab' }).click();
    assert.deepEqual(await readSettledAnchor(page), leaving);
  });

  await t.test('the mounted Triage PR Files viewport keeps its offset through pane and compact page handoff', async t => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 970 } });
    t.after(() => page.close());
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setContent('<div id="root" data-handoff="true" style="height:900px;display:flex;flex-direction:column"></div>');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.getByRole('tab', { name: 'Files', exact: true }).click().catch(error => {
      throw new Error(pageErrors.join('\n') || error.message, { cause: error });
    });
    const row = page.getByRole('button', { name: /row-001\.txt/ });
    await row.waitFor();
    const measure = setOffset => row.evaluate((button, set) => {
      let scroller = button.parentElement;
      while (scroller && !(scroller.clientHeight > 0 && scroller.scrollHeight - scroller.clientHeight > 140
        && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      if (!scroller) throw new Error('Expected the Files scroller');
      if (set) {
        window.filesScroller = scroller;
        window.filesList = button.closest('[role="list"]');
        scroller.scrollTop = 140;
      }
      return {
        sameScroller: scroller === window.filesScroller,
        sameList: button.closest('[role="list"]') === window.filesList,
        offset: scroller.scrollTop,
      };
    }, setOffset);
    const positions = [await measure(true)];
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 970 });
      await page.getByText('Entry title and facts').waitFor({ state: width === 390 ? 'attached' : 'detached' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      positions.push(await measure(false));
    }
    assert.deepEqual(positions, Array.from({ length: 3 }, () => ({ sameScroller: true, sameList: true, offset: 140 })));
  });
});
