import { afterEach, describe, expect, it, vi } from 'vitest';
import { HappierSpinnerHost } from '@happier-dev/plugin-ui/presentation';

import { mountThroughReactNativeWebAsync, type RnwMount } from '../../rnwMount.testSupport.js';
import { HappierSpinner, resolveHappierSpinnerPresentation, resolveHappierWebSpinnerPresentation } from './Spinner.js';

describe('shared web-spinner presentation', () => {
  it.each([false, true])('keeps an explicitly stopped classic ring visible and still with reduced motion %s', (reducedMotion) => {
    const presentation = resolveHappierSpinnerPresentation({
      platform: 'web',
      indicatorStyle: 'classicRing',
      animating: false,
      hidesWhenStopped: false,
      animationEnabled: true,
      reducedMotion,
    });
    expect(presentation?.kind).toBe('webRing');
    if (presentation?.kind !== 'webRing') throw new Error('Expected the visible classic ring');
    expect(presentation.style.opacity).toBe(1);
    expect(presentation.style.animationName).toBeUndefined();
    expect(presentation.style.animationIterationCount).toBeUndefined();
    expect(presentation.style.willChange).toBeUndefined();
  });
  it('keeps a reduced-motion spinner visible while removing its continuous animation', () => {
    const presentation = resolveHappierWebSpinnerPresentation({
      animating: true,
      animationEnabled: true,
      color: 'red',
      reducedMotion: true,
      size: 12,
    });

    expect(presentation?.style).toMatchObject({
      width: 12,
      height: 12,
      borderColor: 'red',
      opacity: 1,
    });
    expect(presentation?.style.animationName).toBeUndefined();
    expect(presentation?.style.animationIterationCount).toBeUndefined();
    expect(presentation?.style.willChange).toBeUndefined();
  });

  it('uses the small-spinner stepped timing and hides a stopped hidden spinner', () => {
    expect(resolveHappierWebSpinnerPresentation({
      animating: false,
      hidesWhenStopped: true,
    })).toBeNull();

    const presentation = resolveHappierWebSpinnerPresentation({
      animating: true,
      animationEnabled: true,
      size: 'small',
    });

    expect(presentation?.style.animationName).toBe('happierActivitySpinnerSpin');
    expect(presentation?.style.animationTimingFunction).toBe('steps(6, end)');
  });
});

describe('shared spinner presentation (dot styles)', () => {
  const base = { platform: 'web', defaultColor: 'theme-secondary' } as const;

  it('draws the mark wave by default in a self-centred square box', () => {
    const presentation = resolveHappierSpinnerPresentation({ ...base, size: 12 });

    expect(presentation?.kind).toBe('dots');
    if (presentation?.kind !== 'dots') throw new Error('expected dots');
    expect(presentation.accessibilityRole).toBe('progressbar');
    expect(presentation.style).toEqual({ width: 12, height: 12, alignSelf: 'center', overflow: 'hidden' });
    expect(presentation.dots).toEqual({ styleId: 'wave', speed: 'normal', pause: 'short', size: 12, motion: 'animate', ink: { color: 'theme-secondary' } });
  });

  it('draws the chosen style, and the wave for an id it does not know', () => {
    const radar = resolveHappierSpinnerPresentation({ ...base, indicatorStyle: 'radar' });
    const retired = resolveHappierSpinnerPresentation({ ...base, indicatorStyle: 'retiredStyle' });

    expect(radar?.kind === 'dots' ? radar.dots?.styleId : null).toBe('radar');
    expect(retired?.kind === 'dots' ? retired.dots?.styleId : null).toBe('wave');
  });

  it('keeps the classic ring as its own choice on each platform', () => {
    const web = resolveHappierSpinnerPresentation({ ...base, indicatorStyle: 'classicRing', size: 12, color: 'red' });
    expect(web?.kind).toBe('webRing');
    expect(web?.kind === 'webRing' ? web.style.animationName : null).toBe('happierActivitySpinnerSpin');

    const native = resolveHappierSpinnerPresentation({ ...base, platform: 'native', indicatorStyle: 'classicRing', reducedMotion: true });
    expect(native).toEqual({ kind: 'nativeRing', color: 'theme-secondary', animating: false, hidesWhenStopped: false });
  });

  it('holds the still mark when paused, and breathes it under reduced motion', () => {
    const paused = resolveHappierSpinnerPresentation({ ...base, animationEnabled: false });
    const stoppedButShown = resolveHappierSpinnerPresentation({ ...base, animating: false, hidesWhenStopped: false });
    const reduced = resolveHappierSpinnerPresentation({ ...base, reducedMotion: true });

    expect(paused?.kind === 'dots' ? paused.dots?.motion : null).toBe('still');
    expect(stoppedButShown?.kind === 'dots' ? stoppedButShown.dots?.motion : null).toBe('still');
    expect(reduced?.kind === 'dots' ? reduced.dots?.motion : null).toBe('breathe');
  });

  it('renders nothing on web but keeps the layout box on native when stopped and hidden', () => {
    expect(resolveHappierSpinnerPresentation({ ...base, animating: false })).toBeNull();
    const native = resolveHappierSpinnerPresentation({ ...base, platform: 'native', animating: false, size: 18 });
    expect(native?.kind).toBe('dots');
    expect(native?.kind === 'dots' ? native.dots : undefined).toBeNull();
    expect(native?.style).toMatchObject({ width: 18, height: 18 });
  });

  it.each(['aurora', 'hAurora'])('colors %s with the theme accents, but an explicit color wins so the mark stays legible on tinted buttons', (indicatorStyle) => {
    const accents = ['accent-indigo', 'accent-purple', 'accent-orange'] as const;
    const themed = resolveHappierSpinnerPresentation({ ...base, indicatorStyle, auroraAccents: accents });
    const tinted = resolveHappierSpinnerPresentation({ ...base, indicatorStyle, auroraAccents: accents, color: 'white' });
    const noAccents = resolveHappierSpinnerPresentation({ ...base, indicatorStyle });

    expect(themed?.kind === 'dots' ? themed.dots?.ink : null).toEqual({ aurora: accents });
    expect(tinted?.kind === 'dots' ? tinted.dots?.ink : null).toEqual({ color: 'white' });
    expect(noAccents?.kind === 'dots' ? noAccents.dots?.ink : null).toEqual({ color: 'theme-secondary' });
  });
});

describe('HappierSpinner on web (dot styles)', () => {
  let mount: RnwMount | null = null;

  afterEach(() => {
    mount?.unmount();
    mount = null;
    for (const node of document.head.querySelectorAll('style[id^="happier-activity-spinner-"]')) node.remove();
    document.getElementById('happier-spinner-keyframes')?.remove();
    vi.restoreAllMocks();
  });

  /** Every `@keyframes` name the page defines, from whatever stylesheets are in the document head. */
  function definedKeyframes(): string[] {
    const css = [...document.head.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');
    return [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]!);
  }

  function strip(): HTMLElement {
    const node = mount!.container.querySelector<HTMLElement>('[data-happier-activity-spinner]');
    if (!node) throw new Error('Expected the frame strip');
    return node;
  }

  function frameSheetFor(node: HTMLElement): string {
    const key = node.getAttribute('data-happier-activity-spinner');
    const rule = [...document.head.querySelectorAll('style')].map((style) => style.textContent ?? '').find((css) => css.includes(`"${key}"`));
    const payload = rule?.match(/data:image\/svg\+xml,([^")]+)/)?.[1];
    if (!payload) throw new Error(`Expected a frame-sheet rule for ${key}`);
    return decodeURIComponent(payload);
  }

  it.each(['classicRing', 'wave'] as const)('installs %s keyframes when the public host renders directly without an adapter', async (indicatorStyle) => {
    document.getElementById('happier-spinner-keyframes')?.remove();
    const presentation = resolveHappierSpinnerPresentation({
      platform: 'web',
      indicatorStyle,
      color: 'red',
      size: 12,
    });
    if (!presentation) throw new Error('Expected the visible web spinner');

    mount = await mountThroughReactNativeWebAsync(
      <HappierSpinnerHost presentation={presentation} hostProps={{ size: 12, testID: 'direct-spinner' }} />,
    );
    const animatedNode = mount.container.querySelector<HTMLElement>(indicatorStyle === 'classicRing'
      ? '[data-testid="direct-spinner"]'
      : '[data-happier-activity-spinner]');
    expect(animatedNode?.style.animationName).toBe(presentation.kind === 'webRing'
      ? presentation.style.animationName
      : 'happierActivitySpinnerFilmstrip');
    expect(definedKeyframes()).toContain(animatedNode!.style.animationName);
    expect(document.querySelectorAll('#happier-spinner-keyframes')).toHaveLength(1);
  });

  it('steps a strip of pre-drawn frames with one transform animation, sharing one sheet per style and ink', async () => {
    mount = await mountThroughReactNativeWebAsync(
      <>
        <HappierSpinner size={12} color="red" testID="a" />
        <HappierSpinner size={20} color="red" testID="b" />
      </>,
    );

    const strips = [...mount.container.querySelectorAll<HTMLElement>('[data-happier-activity-spinner]')];
    expect(strips).toHaveLength(2);
    expect(strips[0]!.getAttribute('data-happier-activity-spinner')).toBe(strips[1]!.getAttribute('data-happier-activity-spinner'));
    expect(document.head.querySelectorAll('style[id^="happier-activity-spinner-"]')).toHaveLength(1);
    expect(strips[0]!.style.animationName).toBe('happierActivitySpinnerFilmstrip');
    expect(strips[0]!.style.animationDuration).toBe('1004ms');
    expect(strips[0]!.style.animationTimingFunction).toBe('steps(30, end)');
    expect(strips[0]!.style.width).toBe('3000%');
    expect(frameSheetFor(strips[0]!)).toContain('fill="red"');
    expect(frameSheetFor(strips[0]!).match(/<circle /g)).toHaveLength(30 * 8);
  });

  it('renders the H wave with seven dots and a frame sheet distinct from the default mark', async () => {
    const h = resolveHappierSpinnerPresentation({ platform: 'web', indicatorStyle: 'hWave', size: 18 });
    if (!h) throw new Error('Expected a visible H spinner');
    mount = await mountThroughReactNativeWebAsync(<>
      <HappierSpinner size={18} />
      <HappierSpinnerHost presentation={h} hostProps={{ size: 18 }} />
    </>);
    const strips = [...mount.container.querySelectorAll<HTMLElement>('[data-happier-activity-spinner]')];
    expect(frameSheetFor(strips[0]!).match(/<circle /g)).toHaveLength(30 * 8);
    expect(frameSheetFor(strips[1]!).match(/<circle /g)).toHaveLength(30 * 7);
    expect(strips[1]!.getAttribute('data-happier-activity-spinner')).not.toBe(strips[0]!.getAttribute('data-happier-activity-spinner'));
  });

  it('keeps distinct valid colors in distinct frame sheets even when their former 32-bit hashes collide', async () => {
    mount = await mountThroughReactNativeWebAsync(<>
      <HappierSpinner color="#00018f" size={12} />
      <HappierSpinner color="#0002d9" size={12} />
    </>);
    const strips = [...mount.container.querySelectorAll<HTMLElement>('[data-happier-activity-spinner]')];
    expect(strips).toHaveLength(2);
    expect(frameSheetFor(strips[0]!)).toContain('fill="#00018f"');
    expect(frameSheetFor(strips[1]!)).toContain('fill="#0002d9"');
    expect(document.head.querySelectorAll('style[id^="happier-activity-spinner-"]')).toHaveLength(2);
  });

  it('defines the keyframes it animates with, so a standalone mount without the host stylesheet still moves', async () => {
    mount = await mountThroughReactNativeWebAsync(
      <>
        <HappierSpinner size={12} color="red" />
        <HappierSpinner size={12} color="red" reducedMotion />
      </>,
    );

    expect(definedKeyframes()).toEqual(expect.arrayContaining([
      'happierActivitySpinnerFilmstrip',
      'happierActivitySpinnerBreath',
      'happierActivitySpinnerSpin',
    ]));
    expect(document.querySelectorAll('#happier-spinner-keyframes')).toHaveLength(1);
  });

  it('encodes one shared frame sheet and recovers removed sheets when another spinner mounts', async () => {
    // Observe the real URI encoder: no frame construction or policy is mocked.
    const encode = vi.spyOn(globalThis, 'encodeURIComponent');
    const encodedFrameSheets = () => encode.mock.calls.filter(([input]) => (
      typeof input === 'string' && input.startsWith('<svg')
    )).length;
    const renderCopies = (count: number) => <>{Array.from({ length: count }, (_, index) => (
      <HappierSpinner key={index} color="tomato" size={12} />
    ))}</>;

    mount = await mountThroughReactNativeWebAsync(renderCopies(1));
    const sheet = document.head.querySelector<HTMLStyleElement>('style[id^="happier-activity-spinner-"]');
    const css = sheet?.textContent;
    const sheetId = sheet?.id;
    expect(css).toBeTruthy();
    expect(encodedFrameSheets()).toBe(1);

    await mount.render(renderCopies(4));
    expect(encodedFrameSheets()).toBe(1);
    expect(document.head.querySelectorAll('style[id^="happier-activity-spinner-"]')).toHaveLength(1);

    sheet!.remove();
    document.getElementById('happier-spinner-keyframes')!.remove();
    await mount.render(renderCopies(5));
    expect(encodedFrameSheets()).toBe(2);
    expect(document.getElementById(sheetId!)?.textContent).toBe(css);
    expect(document.querySelectorAll('#happier-spinner-keyframes')).toHaveLength(1);
    expect(definedKeyframes()).toContain(strip().style.animationName);
  });

  it('holds the still H without scheduling any animation when ambient motion is paused', async () => {
    mount = await mountThroughReactNativeWebAsync(<HappierSpinner size={12} color="red" animationEnabled={false} />);

    expect(strip().style.animationName).toBe('');
    expect(frameSheetFor(strip())).toContain('fill-opacity="0.85"');
  });

  it('replaces the travelling light with a slow breath of the still H under reduced motion', async () => {
    mount = await mountThroughReactNativeWebAsync(<HappierSpinner size={12} color="red" reducedMotion />);

    expect(strip().style.animationName).toBe('happierActivitySpinnerBreath');
    expect(frameSheetFor(strip())).toContain('fill-opacity="0.85"');
  });
});
