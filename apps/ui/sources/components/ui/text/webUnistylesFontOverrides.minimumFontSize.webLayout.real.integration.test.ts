// @vitest-environment jsdom

import {
  HAPPIER_TYPE_SCALE,
  resolveHappierTypeScale,
  type HappierTypeRole,
} from '@happier-dev/plugin-ui/presentation';
import { afterEach, describe, expect, it } from 'vitest';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

import {
  observeDocumentUnistylesFontMetrics,
  setRootCssVar,
} from './webUnistylesFontOverrides';

/**
 * Large text from the browser's own minimum font size (DARK-1109-L1): Run start, Roles, settings
 * descriptions and the Add menu stacked title and meta lines that overlapped, because each
 * Unistyles text class kept its type-scale line height in pixels while the font grew to 24px.
 * The page's real text path on web is one `unistyles_*` class per element plus this owner's
 * override sheet, so the test renders exactly those rules, as Unistyles emits them, in Chrome.
 */

const ROLES = Object.keys(HAPPIER_TYPE_SCALE) as HappierTypeRole[];
const SUMMARY =
  'Runs on Codex with GPT-5 in happier-dev, reviews each step before it continues, and posts the result to the Session';

let stop: (() => void) | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  host?.remove();
  host = null;
  document.head
    .querySelectorAll('style')
    .forEach((element) => element.remove());
});

async function renderTypeScale() {
  const style = document.createElement('style');
  document.head.appendChild(style);
  stop = observeDocumentUnistylesFontMetrics(document);
  setRootCssVar(document, 1);
  // Unistyles merges an element's styles into one class and writes numbers as pixels.
  for (const role of ROLES) {
    const { fontSize, lineHeight } = resolveHappierTypeScale(role, 'web');
    style.sheet!.insertRule(
      `.unistyles_${role} { font-size: ${fontSize}px; line-height: ${lineHeight}px; }`,
    );
  }
  // A pane header's one-line facts row: it carries the facts' metrics and clips at `1lh`.
  const meta = resolveHappierTypeScale('meta', 'web');
  style.sheet!.insertRule(
    `.unistyles_facts { font-size: ${meta.fontSize}px; line-height: ${meta.lineHeight}px; height: 1lh; overflow: hidden; display: flex; flex-wrap: wrap; }`,
  );
  await Promise.resolve();
  host = document.createElement('div');
  host.innerHTML = [
    ...ROLES.map(
      (role) =>
        `<div data-testid="${role}" class="unistyles_${role}" style="white-space:nowrap">Reviewer</div>`,
    ),
    // A phone Run-start lead: the wrapped summary, then an Item title and its meta subtitle.
    `<div style="width:358px"><div data-testid="summary" class="unistyles_meta">${SUMMARY}</div>`,
    '<div data-testid="item-title" class="unistyles_label">Agent and model</div>',
    '<div data-testid="item-subtitle" class="unistyles_meta">Codex · GPT-5</div></div>',
    '<div data-testid="facts" class="unistyles_facts" style="width:358px"><span data-testid="fact" class="unistyles_meta" style="white-space:nowrap">Step 2 of 4</span><span class="unistyles_meta" style="white-space:nowrap">Waiting for you since 10:42</span></div>',
  ].join('');
  document.body.appendChild(host);
  return host;
}

describe('type-scale line heights in a real browser', () => {
  it('lay out at exactly the type scale at the default text size', async () => {
    const layout = await measureWebLayout(await renderTypeScale(), {
      viewport: { width: 390, height: 900 },
    });
    for (const role of ROLES) {
      const { lineHeight } = resolveHappierTypeScale(role, 'web');
      expect(layout.rect(role).lineHeight, role).toBe(lineHeight);
      expect(layout.rect(role).height, role).toBe(lineHeight);
    }
    expect(layout.rect('facts').height, 'the facts clip is one type-scale line').toBe(
      resolveHappierTypeScale('meta', 'web').lineHeight,
    );
    const summary = layout.rect('summary');
    expect(
      summary.height / summary.lineHeight!,
      'whole wrapped lines, no fractional drift',
    ).toBe(Math.round(summary.height / summary.lineHeight!));
  }, 120_000);

  it('grow with the text when the browser enlarges it, so stacked lines never overlap', async () => {
    const layout = await measureWebLayout(await renderTypeScale(), {
      viewport: { width: 390, height: 900 },
      minimumFontSize: 24,
    });
    for (const role of ROLES) {
      const rect = layout.rect(role);
      expect(rect.fontSize, role).toBeGreaterThanOrEqual(24);
      expect(
        rect.lineHeight!,
        `${role} line keeps room for its glyphs`,
      ).toBeGreaterThanOrEqual(rect.fontSize!);
    }
    const title = layout.rect('item-title');
    const subtitle = layout.rect('item-subtitle');
    expect(
      subtitle.top - title.top,
      'the subtitle starts below the title glyphs',
    ).toBeGreaterThanOrEqual(title.fontSize!);
    const summary = layout.rect('summary');
    expect(
      summary.lineHeight!,
      'wrapped summary lines do not overlap',
    ).toBeGreaterThanOrEqual(summary.fontSize!);
    expect(
      layout.rect('facts').height,
      'the facts clip keeps the whole enlarged line',
    ).toBeGreaterThanOrEqual(layout.rect('fact').height);
  }, 120_000);
});
