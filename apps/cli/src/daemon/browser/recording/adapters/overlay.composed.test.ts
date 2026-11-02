/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBrowserCdpScreencastProducer } from '../../capture/cdpScreencast';
import type { BrowserSidecarContextCaptureSurface } from '../../sidecar/controlAdapter';
import { createSurfaceInputControl } from '../../../surfaces/inputControl';
import { createBrowserRecordingCdpScreencastTransport } from './cdpScreencastTransport';
import { BrowserRecordingSessionV1Schema } from '@happier-dev/protocol/browser/recording/v1';

// Chromium/CDP is the boundary: execute the actual page script against a real DOM.
function setup(options: { failCaptureStop?: boolean } = {}) {
  const commands: string[] = [];
  const scripts = new Map<string, string>();
  const control = createSurfaceInputControl();
  const contextCapture: BrowserSidecarContextCaptureSurface = {
    resolvePageHandle: () => ({ targetId: 'page', sessionId: 'cdp' }),
    subscribeCdpEvents: () => () => {},
    transport: { dispatchPageCommand: async ({ method, params }) => {
      commands.push(method);
      if (method === 'Page.stopScreencast' && options.failCaptureStop) throw new Error('capture stop refused');
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        scripts.set('overlay-script', String(params?.source));
        if (params?.runImmediately) window.eval(String(params.source));
        return { identifier: 'overlay-script' };
      }
      if (method === 'Page.removeScriptToEvaluateOnNewDocument') scripts.delete(String(params?.identifier));
      if (method === 'Runtime.evaluate') return { result: { value: window.eval(String(params?.expression)) } };
      return {};
    } },
  };
  const producer = createBrowserCdpScreencastProducer({ contextCapture, resolveInputControl: () => control });
  const transport = createBrowserRecordingCdpScreencastTransport({ producer, contextCapture, resolveInputControl: () => control });
  const recording = BrowserRecordingSessionV1Schema.parse({ v: 1, recordingId: 'overlay', browserSessionId: 'browser', viewId: 'view',
    profileId: 'profile', targetKind: 'externalUrl', adapterKind: 'chromiumSidecar', renderEngineKind: 'unavailable',
    captureKind: 'cdpScreencast', fidelity: 'cdp', startedAtMs: 1000, navigationGenerationStart: 1,
    status: 'recording', durationMs: 0, byteSize: 0, frameCount: 0, actionChapters: [], relatedReferences: [],
    fps: 12, mimeType: 'video/webm', retentionClass: 'preSend', redactionLevel: 'metadataOnly', policyState: 'allowed' });
  return { commands, scripts, control, producer, start: () => transport.start({ recording, onFrame: () => {} }) };
}
function label() {
  return document.querySelector('[data-happier-recording-overlay]')?.shadowRoot?.querySelector('[data-keystroke]');
}
function key(element: Element, value: string, extra: KeyboardEventInit = {}) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, composed: true, ...extra }));
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('recording overlay through the shared CDP capture', () => {
  it('renders cursor, click and shortcut labels without starting a second recorder, and cleans up', async () => {
    const harness = setup();
    const session = await harness.start();
    expect(document.querySelector('[data-happier-recording-overlay]')).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('pointermove', { clientX: 32, clientY: 48, bubbles: true }));
    const cursor = document.querySelector('[data-happier-recording-overlay]')?.shadowRoot?.querySelector<HTMLElement>('[data-cursor]');
    expect(cursor?.style.transform).toContain('32px, 48px');
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(cursor?.getAttribute('data-pressed')).toBe('true');
    document.body.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(cursor?.getAttribute('data-pressed')).toBe('false');
    const input = document.createElement('input'); document.body.append(input); input.focus();
    key(input, 'k', { ctrlKey: true });
    expect(label()?.textContent).toBe('Ctrl + k');
    expect(harness.commands.filter(command => command === 'Page.startScreencast')).toHaveLength(1);
    const evaluateCalls = harness.commands.filter(command => command === 'Runtime.evaluate').length;
    for (let i = 0; i < 20; i++) key(input, 'a');
    expect(harness.commands.filter(command => command === 'Runtime.evaluate')).toHaveLength(evaluateCalls);
    await session?.stop();
    expect(document.querySelector('[data-happier-recording-overlay]')).toBeNull();
    expect(harness.scripts.size).toBe(0);
    key(input, 'late'); expect(label()).toBeUndefined();
    await harness.producer.dispose();
  });

  it.each([
    '<input type="password">', '<input autocomplete="one-time-code">', '<input autocomplete="new-password">',
    '<input name="api_key">', '<input data-secret>', '<div contenteditable data-private></div>',
    '<input style="-webkit-text-security: disc">',
  ])('never paints a key from a secret field: %s', async (markup) => {
    const harness = setup(); const session = await harness.start();
    const normal = document.createElement('input'); document.body.append(normal); normal.focus(); key(normal, 'a');
    expect(label()?.textContent).toBe('a');
    const container = document.createElement('div'); container.innerHTML = markup; document.body.append(container);
    const secret = container.firstElementChild!; if (secret instanceof HTMLElement) secret.focus();
    key(secret, 'SECRET-SENTINEL', { ctrlKey: true });
    expect(label()?.textContent).toBe('');
    await session?.stop(); await harness.producer.dispose();
  });

  it.each(['open', 'closed'] as const)('hides password keys inside a %s shadow-root editor', async mode => {
    const harness = setup(); const session = await harness.start();
    const normal = document.createElement('input'); document.body.append(normal); normal.focus(); key(normal, 'a');
    expect(label()?.textContent).toBe('a');
    const host = document.createElement('div'); document.body.append(host);
    const shadow = host.attachShadow({ mode });
    const password = document.createElement('input'); password.type = 'password'; shadow.append(password); password.focus();
    key(password, 'SECRET-SENTINEL');
    expect(label()?.textContent).toBe('');
    await session?.stop(); await harness.producer.dispose();
  });

  it('keeps key labels for an inspectable ordinary shadow-root editor', async () => {
    const harness = setup(); const session = await harness.start();
    const host = document.createElement('div'); document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input'); shadow.append(input); input.focus(); key(input, 'k');
    expect(label()?.textContent).toBe('k');
    await session?.stop(); await harness.producer.dispose();
  });

  it('labels text-only input and paste without copying their payloads', async () => {
    const harness = setup(); const session = await harness.start();
    const input = document.createElement('input'); document.body.append(input); input.focus();
    input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'PUBLIC-TEXT', bubbles: true, composed: true }));
    expect(label()?.textContent).toBe('Typing');
    input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: 'CLIPBOARD-TEXT', bubbles: true, composed: true }));
    expect(label()?.textContent).toBe('Paste');
    const password = document.createElement('input'); password.type = 'password'; document.body.append(password); password.focus();
    password.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'SECRET-SENTINEL', bubbles: true, composed: true }));
    expect(label()?.textContent).toBe('');
    await session?.stop(); await harness.producer.dispose();
  });

  it('clears labels before confidential delivery, removes the navigation script, and rejects held startup', async () => {
    const harness = setup(); const session = await harness.start();
    key(document.body, 'public'); expect(label()?.textContent).toBe('public');
    await harness.control.beginConfidentialityHold();
    expect(document.querySelector('[data-happier-recording-overlay]')).toBeNull();
    expect(harness.scripts.size).toBe(0);
    key(document.body, 'SECRET-SENTINEL'); expect(label()).toBeUndefined();
    expect(await harness.start()).toBeNull();
    await session?.stop(); await harness.producer.dispose();
  });

  it('removes overlays even when stopping the screencast fails', async () => {
    const harness = setup({ failCaptureStop: true }); const session = await harness.start();
    await expect(session?.stop()).rejects.toThrow('capture stop refused');
    expect(document.querySelector('[data-happier-recording-overlay]')).toBeNull();
    expect(harness.scripts.size).toBe(0);
    await harness.producer.dispose();
  });

  it('reinstalls on navigation and removes only its own script on stop', async () => {
    const harness = setup(); const session = await harness.start();
    const source = harness.scripts.get('overlay-script'); expect(source).toBeTypeOf('string');
    document.body.replaceChildren(); window.eval(source!);
    key(document.body, 'Enter'); expect(label()?.textContent).toBe('Enter');
    await session?.stop(); expect(harness.scripts.size).toBe(0);
    expect(document.querySelector('[data-happier-recording-overlay]')).toBeNull();
    await harness.producer.dispose();
  });
});
