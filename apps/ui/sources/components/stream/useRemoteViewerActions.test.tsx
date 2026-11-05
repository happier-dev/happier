import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import type { LiveStreamInputGesture } from '@/sync/domains/machines/peer/mediation/stream/inputGesture';
import { useRemoteViewerActions } from '@happier-dev/plugin-ui/presentation';

describe('remote viewer actions', () => {
    it('combines one-shot and locked modifiers on the next key or click without consuming them on movement', async () => {
        const sent: LiveStreamInputGesture[] = [];
        let actions!: ReturnType<typeof useRemoteViewerActions>;
        function Host() { actions = useRemoteViewerActions({ enabled: true, sendGesture: gesture => sent.push(gesture) }); return null; }
        let root!: ReturnType<typeof create>;
        await act(async () => { root = create(<Host />); });
        try {
            await act(async () => { actions.tapModifier('shift'); actions.tapModifier('control', { clickCount: 2 }); });
            const geometry = { orientation: 'portrait', viewport: { width: 100, height: 100 }, content: { x: 0, y: 0, width: 100, height: 100 } } as const;
            actions.prepareGesture({ kind: 'move', point: { x: 0.5, y: 0.5 }, ...geometry });
            await act(async () => { actions.sendKey('Tab'); });
            expect(sent).toEqual([{ kind: 'keyboard_key', key: 'Tab', modifiers: ['control', 'shift'] }]);
            expect(actions.modifiers.shift).toBe('off');
            expect(actions.modifiers.control).toBe('locked');
            await act(async () => { actions.tapModifier('alt'); });
            let click: LiveStreamInputGesture | null = null;
            await act(async () => { click = actions.prepareGesture({ kind: 'tap', point: { x: 0.5, y: 0.5 }, ...geometry }); });
            expect(click).toMatchObject({ kind: 'tap', modifiers: ['alt', 'control'] });
            expect(actions.modifiers.alt).toBe('off');
            await act(async () => { actions.tapModifier('control'); actions.sendKey('Enter'); });
            expect(sent.at(-1)).toEqual({ kind: 'keyboard_key', key: 'Enter' });
            await act(async () => { actions.tapModifier('meta'); actions.tapModifier('meta'); });
            expect(actions.modifiers.meta).toBe('off');
        } finally { await act(async () => root.unmount()); }
    });

    it('maps clipboard directions onto the existing relay and reports unavailable clipboard without sending input', async () => {
        const clipboard: string[] = [];
        let actions!: ReturnType<typeof useRemoteViewerActions>;
        function Host(props: { supported: boolean; driverUnavailable?: boolean }) { actions = useRemoteViewerActions({ enabled: true, sendGesture: () => {},
            clipboardShortcut: props.supported ? async action => { clipboard.push(action);
                return props.driverUnavailable ? { ok: false, reason: 'clipboard_not_supported' } : { ok: true }; } : undefined }); return null; }
        let root!: ReturnType<typeof create>;
        await act(async () => { root = create(<Host supported />); });
        try {
            expect(await actions.sendClipboard()).toEqual({ ok: true });
            expect(await actions.receiveClipboard()).toEqual({ ok: true });
            expect(clipboard).toEqual(['paste', 'copy']);
            await act(async () => { root.update(<Host supported driverUnavailable />); });
            expect(await actions.receiveClipboard()).toEqual({ ok: false, reason: 'clipboard_not_supported' });
            await act(async () => { root.update(<Host supported={false} />); });
            expect(await actions.sendClipboard()).toEqual({ ok: false, reason: 'clipboard_not_supported' });
            expect(actions.clipboard).toEqual({ available: false, reason: 'clipboard_not_supported' });
        } finally { await act(async () => root.unmount()); }
    });
});
