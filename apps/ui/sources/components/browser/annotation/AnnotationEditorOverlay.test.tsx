import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { BrowserAnnotationCaptureCapability } from '@/sync/domains/browser/context';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

import {
    AnnotationCaptureSurface,
    AnnotationEditorOverlay,
    type AnnotationEditorOverlayProps,
} from './AnnotationEditorOverlay';

const available: BrowserAnnotationCaptureCapability = { available: true, fidelity: 'nativeCallback' };

function buildProps(overrides?: Partial<AnnotationEditorOverlayProps>): AnnotationEditorOverlayProps {
    return {
        testID: 'anno',
        captureCapability: available,
        markCount: 0,
        marks: [],
        comment: '',
        onSelectElement: vi.fn(),
        onAddRegion: vi.fn(),
        onAddStroke: vi.fn(),
        onRemoveMark: vi.fn(),
        onCommentChange: vi.fn(),
        onAttach: vi.fn(),
        onCancel: vi.fn(),
        ...overrides,
    };
}

describe('AnnotationEditorOverlay (ANNO-1)', () => {
    it('gates Attach until >=1 mark, then commits via onAttach', async () => {
        const onAttach = vi.fn();
        const props = buildProps({ markCount: 0, onAttach });
        const screen = await renderScreen(<AnnotationEditorOverlay {...props} />);

        // Disabled while empty: the press handler must not fire onAttach.
        const attach = screen.findByTestId('anno-attach');
        expect(attach?.props.disabled).toBe(true);

        await screen.update(<AnnotationEditorOverlay {...buildProps({ markCount: 1, onAttach })} />);
        const enabledAttach = screen.findByTestId('anno-attach');
        expect(enabledAttach?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('anno-attach');
        expect(onAttach).toHaveBeenCalledTimes(1);
    });

    it('routes each tool to exactly one draft handler through the capture surface', async () => {
        const onSelectElement = vi.fn();
        const onAddRegion = vi.fn();
        const onAddStroke = vi.fn();
        const props = buildProps({ onSelectElement, onAddRegion, onAddStroke });
        const screen = await renderScreen(<AnnotationEditorOverlay {...props} />);

        // Select tool is the default; the surface tap routes to the element-picker bridge.
        const surface = () => screen.findByType(AnnotationCaptureSurface);
        expect(surface().props.tool).toBe('select');
        surface().props.onPick({ x: 12, y: 34 });
        expect(onSelectElement).toHaveBeenCalledTimes(1);

        // Region tool → marquee rect routes to onAddRegion.
        await screen.pressByTestIdAsync('anno-tool-region');
        expect(surface().props.tool).toBe('region');
        surface().props.onRegion({ x: 1, y: 2, width: 30, height: 40 });
        expect(onAddRegion).toHaveBeenCalledWith({ x: 1, y: 2, width: 30, height: 40 });

        // Draw tool → freehand points route to onAddStroke.
        await screen.pressByTestIdAsync('anno-tool-draw');
        expect(surface().props.tool).toBe('draw');
        surface().props.onStroke([{ x: 0, y: 0 }, { x: 5, y: 5 }]);
        expect(onAddStroke).toHaveBeenCalledWith([{ x: 0, y: 0 }, { x: 5, y: 5 }]);
    });

    it('comment input and cancel route to their handlers', async () => {
        const onCommentChange = vi.fn();
        const onCancel = vi.fn();
        const screen = await renderScreen(
            <AnnotationEditorOverlay {...buildProps({ onCommentChange, onCancel })} />,
        );
        screen.changeTextByTestId('anno-comment', 'needs spacing');
        expect(onCommentChange).toHaveBeenCalledWith('needs spacing');
        screen.pressByTestId('anno-cancel');
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('Erase tool lists marks and removes one by id', async () => {
        const onRemoveMark = vi.fn();
        const marks = [
            { draftId: 'target_1', kind: 'element' as const, label: '#a' },
            { draftId: 'region_1', kind: 'region' as const, label: 'region' },
        ];
        const screen = await renderScreen(
            <AnnotationEditorOverlay {...buildProps({ markCount: 2, marks, onRemoveMark })} />,
        );
        await screen.pressByTestIdAsync('anno-tool-erase');
        await screen.pressByTestIdAsync('anno-erase-target_1');
        expect(onRemoveMark).toHaveBeenCalledWith('target_1');
    });

    it('keeps element, region, and stroke visual marks visible while authoring', async () => {
        const marks = [
            {
                draftId: 'target_1',
                kind: 'element' as const,
                label: '#save',
                rect: { x: 10, y: 20, width: 120, height: 36 },
            },
            {
                draftId: 'region_1',
                kind: 'region' as const,
                label: 'region',
                rect: { x: 40, y: 80, width: 160, height: 90 },
            },
            {
                draftId: 'stroke_1',
                kind: 'stroke' as const,
                label: 'drawing',
                points: [{ x: 8, y: 12 }, { x: 18, y: 20 }, { x: 30, y: 22 }],
            },
        ];

        const screen = await renderScreen(
            <AnnotationEditorOverlay {...buildProps({ marks, markCount: 3 })} />,
        );

        expect(screen.findByTestId('anno-mark-target_1')).toBeTruthy();
        expect(screen.findByTestId('anno-mark-region_1')).toBeTruthy();
        expect(screen.findByTestId('anno-mark-stroke_1')).toBeTruthy();
        // U-7: one SVG path (plus its legibility casing), not up to 512 point Views.
        expect(screen.findByTestId('anno-mark-stroke_1-path')).toBeTruthy();
        expect(screen.findByTestId('anno-mark-stroke_1-point-0')).toBeNull();
    });

    it('disables capture with an explicit reason when the engine has no producer', async () => {
        const unavailable: BrowserAnnotationCaptureCapability = {
            available: false,
            disabledReason: 'browser_context_annotation_capture_unavailable',
        };
        const screen = await renderScreen(
            <AnnotationEditorOverlay {...buildProps({ captureCapability: unavailable, markCount: 3 })} />,
        );
        // Reason surfaced, Attach disabled even with marks, surface inert.
        expect(screen.findByTestId('anno-capture-unavailable')).toBeTruthy();
        expect(screen.findByTestId('anno-attach')?.props.disabled).toBe(true);
        expect(screen.findByType(AnnotationCaptureSurface).props.disabled).toBe(true);
    });
});
