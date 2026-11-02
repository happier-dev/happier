import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { buildDesktopBrowserKeyboardScript, buildCooperativeNavigationRuntimeScript } from '@happier-dev/peer-mediation/browser/collector/build';
import { buildCooperativeKeyboardConfiguration, parseCooperativeKeyboardEvent } from '@happier-dev/peer-mediation/browser/collector/cooperative';
import { parseBrowserGuestKeyboardEvent } from '@/sync/domains/browser/adapters/guestKeyboard';

const address = 'l|shift=false|ctrl=false|meta=true|alt=false';
const config = { browserSessionId: 'browser', viewId: 'view', navigationGeneration: 1,
    collector: { collectorId: 'collector', nonce: 'nonce', version: '1.0.0' }, webPostMessageTargetOrigin: 'https://host.test' };

describe('browser guest keyboard transport', () => {
    it('sends only configured desktop chords, replaces bindings and leaves composition with the page', () => {
        const dom = new JSDOM('<input value="private page text">', { url: 'https://page.test', runScripts: 'outside-only' });
        try {
            const messages: string[] = [];
            Reflect.set(dom.window, 'ipc', { postMessage: (message: string) => messages.push(message) });
            dom.window.eval(buildDesktopBrowserKeyboardScript([address]));
            const input = dom.window.document.querySelector('input')!;
            const key = (value: string, composing = false) => {
                const event = new dom.window.KeyboardEvent('keydown', { key: value, code: `Key${value.toUpperCase()}`, metaKey: true,
                    bubbles: true, cancelable: true, isComposing: composing });
                input.dispatchEvent(event);
                return event.defaultPrevented;
            };
            for (let index = 0; index < 10; index += 1) expect(key('x')).toBe(false);
            expect(key('l', true)).toBe(false);
            expect(messages).toHaveLength(0);
            expect(key('l')).toBe(true);
            expect(messages.map(message => JSON.parse(message))).toEqual([{ kind: 'happier:browser-key', event: {
                key: 'l', code: 'KeyL', repeat: false, isEditableTarget: true,
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
            } }]);
            dom.window.eval(buildDesktopBrowserKeyboardScript([]));
            expect(key('l')).toBe(false);
            expect(messages).toHaveLength(1);
        } finally { dom.window.close(); }
    });

    it('forwards a bound cooperative preview chord while rejecting other parents and document identities', () => {
        const dom = new JSDOM('<input>', { url: 'https://preview.test', runScripts: 'outside-only' });
        try {
            const messages: unknown[] = [];
            // postMessage is the browser boundary; the complete guest reporter remains real.
            dom.window.postMessage = (message: unknown) => { messages.push(typeof message === 'string' ? JSON.parse(message) : message); };
            dom.window.eval(buildCooperativeNavigationRuntimeScript(JSON.stringify(config)));
            const configure = (origin: string) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
                source: dom.window, origin, data: buildCooperativeKeyboardConfiguration(config, [address]),
            }));
            const press = () => dom.window.document.querySelector('input')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
                key: 'l', code: 'KeyL', metaKey: true, bubbles: true, cancelable: true,
            }));
            configure('https://other.test');
            expect(press()).toBe(true);
            configure(config.webPostMessageTargetOrigin);
            expect(press()).toBe(false);
            const event = messages.map(message => parseCooperativeKeyboardEvent(message, config)).find(Boolean);
            expect(parseBrowserGuestKeyboardEvent(event)).toMatchObject({ key: 'l', isEditableTarget: true });
            expect(parseCooperativeKeyboardEvent(messages.at(-1), { ...config, navigationGeneration: 2 })).toBeNull();
        } finally { dom.window.close(); }
    });
});
