/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { GlassMaterialSettingsProvider } from '@/components/ui/glass/useGlassMaterialSettings';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { OverlayMotionFrame } from './overlayMotion';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    setReducedMotionPreferenceOverride(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('web overlay material composition', () => {
    it('moves a material frame whole by transform, never opacity, so its edges travel with its paint and content', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        // Hold the browser's clock at the first animation frame, before the enter settles.
        vi.useFakeTimers();
        const runs: { target: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }[] = [];
        // WAAPI is the browser boundary; the frame, material policy and RNW layout stay real.
        const animate = vi.fn(function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
            const cancel = vi.fn();
            runs.push({ target: this, frames, options, cancel });
            return { playState: 'running', effect: { target: this }, cancel } as unknown as Animation;
        });
        Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
        function Scene({ visible, preset, disabled }: { visible: boolean; preset: 'auto' | 'solid'; disabled?: boolean }) {
            return <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials(preset) }}>
                <OverlayMotionFrame visible={visible} disabled={disabled} kind="popover" direction="bottom">
                    {/* A card's elevation drawn on an ancestor of its paint (ModalCardFrame, floating chrome). */}
                    <div data-testid="elevation" style={{ boxShadow: '0px 8px 24px rgba(0, 0, 0, 0.2)' }}>
                        {/* The card's clipping edge, also an ancestor of its paint (ModalCardFrame's clip surface). */}
                        <div data-testid="edge" style={{ border: '1px solid rgba(0, 0, 0, 0.1)' }}>
                        <GlassSurface testID="material" finishRole={null} style={{ padding: 12, gap: 8, alignItems: 'stretch' }}>
                            <input data-testid="draft" defaultValue="keep this draft" />
                            <button>Continue</button>
                            {/* A card drawn solid on the material (an item group on a sheet): its paint samples no backdrop. */}
                            <GlassSurface testID="nested" finishRole={null} style={{ borderWidth: 1, borderColor: 'rgba(0, 0, 0, 0.08)' }}><button>Nested action</button></GlassSurface>
                        </GlassSurface>
                        </div>
                    </div>
                </OverlayMotionFrame>
            </GlassMaterialSettingsProvider>;
        }
        try {
            const styleReads = vi.spyOn(globalThis, 'getComputedStyle');
            // The placement owner keeps this subtree hidden until its geometry is published.
            // There is no presented frame to animate out or material to sample yet.
            await act(async () => root.render(<Scene visible={false} disabled preset="auto" />));
            const hiddenMaterial = container.querySelector<HTMLElement>('[data-testid="material"]')!;
            const hiddenFrame = hiddenMaterial.parentElement!.parentElement!.parentElement!;
            expect(styleReads.mock.calls.filter(([element]) => hiddenFrame.contains(element))).toHaveLength(0);
            expect(runs).toHaveLength(0);
            await act(async () => root.render(<Scene visible preset="auto" />));
            const material = container.querySelector<HTMLElement>('[data-testid="material"]')!;
            const elevation = container.querySelector<HTMLElement>('[data-testid="elevation"]')!;
            const frame = elevation.parentElement!;
            const paint = Array.from(material.children).find(child => (child as HTMLElement).style.backdropFilter.includes('blur')) as HTMLElement;
            expect(paint).toBeTruthy();
            // One run, on the frame: the material's own edge and fill (its ancestors of the paint) move with it.
            expect(runs.map(run => run.target)).toEqual([frame]);
            expect(runs[0]!.frames[0]).toHaveProperty('transform', 'translate(0px, -8px) scale(0.98)');
            // Opacity above the paint would empty the backdrop its blur samples.
            for (const frameStep of runs[0]!.frames) expect(frameStep).not.toHaveProperty('opacity');
            const input = container.querySelector<HTMLInputElement>('[data-testid="draft"]')!;
            for (let node: HTMLElement | null = paint; node && node !== frame; node = node.parentElement) {
                expect(node.style.opacity).toBe('');
                expect(node.style.transform).toBe('');
            }
            expect(material.style.padding).toBe('12px');
            expect(material.style.gap).toBe('8px');
            const enterRuns = runs.length;
            await act(async () => root.render(<Scene visible={false} preset="auto" />));
            const [exit, ...leaving] = runs.slice(enterRuns);
            // The elevation fades too, by its shadow alone: no shadow is left standing where the card was,
            // and no ancestor of the paint takes opacity.
            const shadowFades = leaving.filter(run => 'boxShadow' in run.frames.at(-1)!);
            expect(shadowFades.map(run => run.target)).toEqual([elevation]);
            expect(shadowFades[0]!.frames.at(-1)).toMatchObject({ boxShadow: 'none' });
            expect(shadowFades[0]!.options).toMatchObject({ duration: motionTokens.overlay.popover.exitMs, fill: 'forwards' });
            expect(elevation.style.opacity).toBe('');
            // Its clipping edge drops its colour with it: no empty rim stands where the card was (ghost rim).
            const edge = container.querySelector<HTMLElement>('[data-testid="edge"]')!;
            const edgeFades = leaving.filter(run => 'borderColor' in run.frames.at(-1)!);
            expect(edgeFades.map(run => run.target)).toEqual([edge]);
            expect(edgeFades[0]!.frames.at(-1)).toMatchObject({ borderColor: 'transparent' });
            expect(edge.style.opacity).toBe('');
            const fades = leaving.filter(run => !shadowFades.includes(run) && !edgeFades.includes(run));
            expect(exit!.target).toBe(frame);
            expect(exit!.frames[1]).toHaveProperty('transform', 'translate(0px, -8px) scale(0.98)');
            expect(exit!.frames[1]).not.toHaveProperty('opacity');
            expect(exit!.options.duration).toBe(motionTokens.overlay.popover.exitMs);
            expect(exit!.options.fill).toBeUndefined();
            expect(frame.style.pointerEvents).toBe('none');
            expect(frame.style.opacity).toBe('');
            // Leaving, the paint itself and everything beside it fade out and hold until unmount, so the
            // surface does not end in a cut; no ancestor of a blurring paint fades, so every blur keeps its backdrop.
            const paints = Array.from(frame.querySelectorAll<HTMLElement>('[data-happy-glass-backdrop]'))
                .filter(layer => (layer.style.backdropFilter ?? '').includes('blur'));
            const faded = fades.map(run => run.target);
            for (const layer of paints) expect(faded).toContain(layer);
            // A card drawn solid on it fades whole, edge and all, by opacity: an edge faded by its colour runs on the main
            // thread and stood as an empty outline while a busy close held that thread (MACH-SANDBOX r10 add-close).
            expect(faded).toContain(container.querySelector('[data-testid="nested"]'));
            expect(faded).toContain(input);
            expect(faded).toContain(Array.from(material.children).find(child => child.textContent === 'Continue'));
            for (const target of faded) expect(paints.some(layer => layer !== target && target.contains(layer))).toBe(false);
            for (const fade of fades) {
                expect(fade.frames.at(-1)).toMatchObject({ opacity: 0 });
                expect(fade.options).toMatchObject({ duration: motionTokens.overlay.popover.exitMs, fill: 'forwards' });
            }
            // Opening again mid-way turns each running fade around from where it is.
            const exitRuns = runs.length;
            await act(async () => root.render(<Scene visible preset="auto" />));
            for (const fade of leaving) expect(fade.cancel).toHaveBeenCalled();
            expect(runs.slice(exitRuns).filter(run => faded.includes(run.target)).length).toBe(fades.length);
            const shadowBack = runs.slice(exitRuns).filter(run => run.target === elevation);
            expect(shadowBack).toHaveLength(1);
            expect(shadowBack[0]!.frames[0]).toHaveProperty('boxShadow');
            await act(async () => root.render(<Scene visible={false} preset="auto" />));
            await act(async () => root.render(<Scene visible preset="auto" />));
            await act(async () => root.render(<Scene visible preset="solid" />));
            expect(container.querySelector('[data-testid="draft"]')).toBe(input);
            expect(input.value).toBe('keep this draft');
            await act(async () => root.render(<Scene visible preset="auto" />));
            expect(container.querySelector('[data-testid="draft"]')).toBe(input);
        } finally {
            await act(async () => root.unmount());
            expect(runs.every(run => run.cancel.mock.calls.length > 0)).toBe(true);
            delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
            container.remove();
        }
    });
    it('rises a bottom sheet by its own height, paper and content together, and changes at once under reduced motion', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const runs: { target: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
        Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
            runs.push({ target: this, frames, options });
            return { playState: 'finished', cancel: () => {} } as unknown as Animation;
        } });
        // jsdom has no layout: report the frame's height the way a browser would.
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 320 } as DOMRect);
        function Sheet() {
            return <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
                <OverlayMotionFrame visible kind="modal" direction="bottom">
                    <GlassSurface testID="sheet" finishRole={null}><button>Hold</button></GlassSurface>
                </OverlayMotionFrame>
            </GlassMaterialSettingsProvider>;
        }
        try {
            await act(async () => root.render(<Sheet />));
            const frame = container.querySelector<HTMLElement>('[data-testid="sheet"]')!.parentElement!;
            expect(runs.map(entry => entry.target)).toEqual([frame]);
            expect(runs[0]!.frames[0]).toEqual({ transform: 'translate(0px, 320px) scale(1)' });
            expect(runs[0]!.options.duration).toBe(motionTokens.overlay.modal.enterMs);
            runs.length = 0;
            await act(async () => setReducedMotionPreferenceOverride(true));
            // Fading content over still paper would show an empty card, so a material frame changes at once.
            expect(runs).toEqual([]);
        } finally {
            rect.mockRestore();
            await act(async () => root.unmount());
            delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
            container.remove();
        }
    });
    it('keeps plain popovers animated and honors reduced motion without leaving a transform after opening', async () => {
        const container = document.createElement('div');
        const root = createRoot(container);
        const runs: { target: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
        Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
            runs.push({ target: this, frames, options });
            return { playState: 'finished', cancel: () => {} } as unknown as Animation;
        } });
        try {
            await act(async () => root.render(<OverlayMotionFrame visible kind="popover" direction="bottom"><button>Plain action</button></OverlayMotionFrame>));
            expect(runs).toHaveLength(1);
            expect(runs[0]!.target.contains(container.querySelector('button'))).toBe(true);
            expect(runs[0]!.frames[0]).toMatchObject({ opacity: '0', transform: 'translate(0px, -8px) scale(0.98)' });
            expect(runs[0]!.target.style.transform).toBe('');
            await act(async () => setReducedMotionPreferenceOverride(true));
            const reduced = runs.at(-1)!;
            expect(reduced.options.duration).toBe(motionTokens.durationMs.fast);
            expect(reduced.frames).toEqual([{ opacity: '0', transform: 'none' }, { opacity: '1', transform: 'none' }]);
        } finally {
            await act(async () => root.unmount());
            delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
        }
    });
});
