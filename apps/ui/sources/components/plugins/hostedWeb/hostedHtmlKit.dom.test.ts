import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { HOSTED_HTML_GUEST_BOOTSTRAP_SCRIPT } from './guestBootstrap.generated';

/**
 * The agent visual kit as shipped: the generated guest bootstrap every hosted document
 * carries, run ahead of an agent page written with native controls inside `happier-*`
 * wrappers. The page keeps its own names, values and events, the host stylesheet comes
 * ahead of the page's own, and the slider shows its value as it moves. (The frame's
 * admission prefix needs a real browser, so the bootstrap runs here on its own.)
 */
describe('hosted HTML kit', () => {
  it('styles agent controls from the host and keeps the page script in charge of their values', async () => {
    const body = [
      '<happier-tabs><label><input type="radio" name="pct" value="p50">p50</label><label><input type="radio" name="pct" value="p95" checked>p95</label></happier-tabs>',
      '<happier-slider label="Base delay" unit="ms"><input type="range" name="delay" min="0" max="1200" step="100" value="400"></happier-slider>',
      "<script>globalThis.delays = []; document.querySelector('[name=delay]').addEventListener('input', event => globalThis.delays.push(event.target.value));</script>",
    ].join('');
    const guest = HOSTED_HTML_GUEST_BOOTSTRAP_SCRIPT.replace(/<\/script/giu, '<\\/script');
    const html = `<!doctype html><html><head><script>${guest}</script></head><body>${body}</body></html>`;
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      // jsdom lacks the encoding globals every browser frame has; the bootstrap's modules read them at load.
      beforeParse(window) {
        Object.assign(window, { TextEncoder, TextDecoder });
      },
    });
    try {
      const { document } = dom.window;
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

      // The kit sheet comes first in <head>, so the author's own rules win by order.
      const firstSheet = document.head.querySelector(
        'link[rel=stylesheet], style',
      );
      expect(firstSheet?.getAttribute('href')).toMatch(/^data:text\/css/u);
      expect(decodeURIComponent(firstSheet!.getAttribute('href')!)).toContain(
        'happier-tabs>label:has(>input:checked)',
      );

      const slider = document.querySelector('happier-slider')!;
      const input = slider.querySelector('input')!;
      const readout = () =>
        slider.shadowRoot?.querySelector('.value')?.textContent;
      expect(slider.shadowRoot?.querySelector('.label')?.textContent).toBe(
        'Base delay',
      );
      expect(readout()).toBe('400 ms');
      expect(input.getAttribute('aria-label')).toBe('Base delay');
      expect(slider.getAttribute('style')).toContain(
        '--happier-slider-fill: 33.3',
      );

      input.value = '900';
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      expect(readout()).toBe('900 ms');
      expect(input.getAttribute('aria-valuetext')).toBe('900 ms');
      expect(slider.getAttribute('style')).toContain(
        '--happier-slider-fill: 75%',
      );
      // The page's own listener still owns the value.
      expect((dom.window as unknown as { delays: string[] }).delays).toEqual([
        '900',
      ]);

      // Tabs stay native radios: the form value is the browser's.
      const checked = document.querySelector<HTMLInputElement>(
        'happier-tabs input:checked',
      );
      expect(checked?.value).toBe('p95');
    } finally {
      dom.window.close();
    }
  });
});
