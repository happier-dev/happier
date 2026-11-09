import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';

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
    return createTextModuleMock();
});

const { TranscriptAnnotationEditor } = await import('./TranscriptAnnotationEditor');
const { TranscriptAnnotationPopover } = await import('./TranscriptAnnotationPopover');
const { Popover } = await import('@/components/ui/popover/Popover');
const { dispatchEscapeToLayerStack } = await import('@/keyboard/escape');
afterEach(standardCleanup);

const input = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllHostsByTestId('transcript-annotation-editor-note')[0]!;

describe('transcript annotation editor', () => {
    it('keeps the note and reports a refused attachment, then closes only after a successful retry', async () => {
        let accepted = false;
        const saved: string[] = [];
        const cancel = vi.fn();
        const screen = await renderScreen(<TranscriptAnnotationEditor quote="The exact selected passage"
            onSave={async (note) => { saved.push(note); return accepted; }} onCancel={cancel} />);
        const save = () => screen.findAllHostsByTestId('transcript-annotation-editor-save')[0]!;
        await act(async () => input(screen).props.onChangeText('Keep this note'));
        await act(async () => save().props.onPress());
        expect(saved).toEqual(['Keep this note']);
        expect(input(screen).props.value).toBe('Keep this note');
        expect(cancel).not.toHaveBeenCalled();
        expect(screen.findAllHostsByTestId('transcript-annotation-editor-note.error').length).toBeGreaterThan(0);
        accepted = true;
        await act(async () => save().props.onPress());
        expect(saved).toEqual(['Keep this note', 'Keep this note']);
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('adds the note with Cmd/Ctrl+Enter while a plain Enter stays a new line', async () => {
        const saved: string[] = [];
        const screen = await renderScreen(<TranscriptAnnotationEditor quote="The exact selected passage"
            onSave={async (note) => { saved.push(note); return true; }} onCancel={() => undefined} />);
        await act(async () => input(screen).props.onChangeText('First line'));
        await act(async () => input(screen).props.onKeyPress({ nativeEvent: { key: 'Enter' }, preventDefault: () => undefined }));
        expect(saved).toEqual([]);
        await act(async () => input(screen).props.onKeyPress({ nativeEvent: { key: 'Enter', metaKey: true }, preventDefault: () => undefined }));
        expect(saved).toEqual(['First line']);
        await act(async () => input(screen).props.onKeyPress({ nativeEvent: { key: 'Enter', ctrlKey: true }, preventDefault: () => undefined }));
        expect(saved).toEqual(['First line', 'First line']);
    });

    it('discards the note on Escape, even from inside the field', async () => {
        const cancel = vi.fn();
        const screen = await renderScreen(<TranscriptAnnotationEditor quote="The exact selected passage"
            onSave={async () => true} onCancel={cancel} />);
        await act(async () => input(screen).props.onChangeText('Typed, then abandoned'));
        await act(async () => { dispatchEscapeToLayerStack({ key: 'Escape', target: { tagName: 'TEXTAREA' } }); });
        expect(cancel).toHaveBeenCalledOnce();
    });
});

describe('transcript annotation popover', () => {
    it('keeps a typed note open when the popover is dismissed from outside, and closes an empty one', async () => {
        await withPopoverWebGlobals(async () => {
            const cancel = vi.fn();
            const screen = await renderScreen(<TranscriptAnnotationPopover quote="The exact selected passage"
                anchor={{ x: 40, y: 40, width: 120, height: 18 }} onSave={async () => true} onCancel={cancel} />);
            await act(async () => screen.findByType(Popover).props.onRequestClose?.());
            expect(cancel).toHaveBeenCalledOnce();
            cancel.mockClear();
            await act(async () => input(screen).props.onChangeText('Half-written thought'));
            await act(async () => screen.findByType(Popover).props.onRequestClose?.());
            expect(cancel).not.toHaveBeenCalled();
            expect(input(screen).props.value).toBe('Half-written thought');
        });
    });
});
