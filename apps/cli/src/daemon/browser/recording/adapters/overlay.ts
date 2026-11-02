import type { BrowserSidecarCdpPageHandle, BrowserSidecarContextCaptureSurface } from '../../sidecar/controlAdapter';

/** Raw key events stay in Chromium; only existing captured pixels carry visible labels. */
function overlayExpression(recordingId: string): string {
  const key = JSON.stringify(`happier.recording.overlay.${recordingId}`);
  return `(() => {
    const key = ${key};
    globalThis[key]?.();
    let root;
    const listeners = [];
    const listen = (type, fn) => {
      window.addEventListener(type, fn, true);
      listeners.push([type, fn]);
    };
    globalThis[key] = () => {
      for (const [type, fn] of listeners) window.removeEventListener(type, fn, true);
      root?.remove();
      delete globalThis[key];
    };
    const mount = () => {
      root = document.createElement('div');
      root.setAttribute('data-happier-recording-overlay', '');
      root.setAttribute('aria-hidden', 'true');
      // A fixed, noninteractive layer leaves layout, focus and input targeting untouched.
      root.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      const shadow = root.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<style>:host{pointer-events:none} [data-cursor]{position:absolute;left:0;top:0;display:none;color:CanvasText;filter:drop-shadow(0 0 1px Canvas)} [data-cursor][data-pressed="true"]{color:Highlight} [data-keystroke]{position:absolute;bottom:1em;left:50%;transform:translateX(-50%);font:caption;color:CanvasText;background:Canvas;border:1px solid CanvasText;border-radius:.4em;padding:.3em .6em;white-space:pre} [data-keystroke]:empty{display:none}</style><svg data-cursor data-pressed="false" width="20" height="24" viewBox="0 0 20 24"><path d="M2 2 L2 20 L7 15 L11 23 L15 21 L11 13 L18 13 Z" fill="currentColor" stroke="Canvas"/></svg><span data-keystroke></span>';
      const cursor = shadow.querySelector('[data-cursor]');
      const label = shadow.querySelector('[data-keystroke]');
      const clearLabel = () => { label.textContent = ''; };
      // Inspect the real composed target, including shadow editors and private ancestors.
      // Never read a field value, composition data or clipboard content.
      const isSecret = event => {
        let element = event.composedPath().find(node => node instanceof Element);
        const active = document.activeElement;
        // Closed shadow roots retarget password events to an opaque host. Without an
        // inspectable editor, omit the label rather than treating it as public input.
        if (active && active !== document.body && active !== document.documentElement
          && !element?.closest('input,textarea,select,button,a[href],[contenteditable]')) return true;
        while (element) {
          const type = (element.getAttribute('type') || '').toLowerCase();
          const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
          const identity = [element.getAttribute('name'), element.id, element.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
          const security = getComputedStyle(element).getPropertyValue('-webkit-text-security');
          if (type === 'password' || element.hasAttribute('data-secret') || element.hasAttribute('data-private')
            || autocomplete.some(value => ['current-password', 'new-password', 'one-time-code'].includes(value) || value.startsWith('cc-'))
            || /password|passwd|secret|token|api[ _-]?key|passcode|\\bpin\\b|\\botp\\b/.test(identity)
            || (security && security !== 'none')) return true;
          element = element.parentElement || element.getRootNode().host;
        }
        return false;
      };
      listen('pointermove', event => {
        cursor.style.display = 'block';
        cursor.style.transform = 'translate(' + event.clientX + 'px, ' + event.clientY + 'px)';
      });
      listen('pointerdown', event => {
        cursor.style.display = 'block';
        cursor.style.transform = 'translate(' + event.clientX + 'px, ' + event.clientY + 'px)';
        cursor.setAttribute('data-pressed', 'true');
        clearLabel();
      });
      listen('pointerup', () => { cursor.setAttribute('data-pressed', 'false'); });
      listen('pointerout', event => { if (!event.relatedTarget) cursor.style.display = 'none'; });
      listen('keydown', event => {
        clearLabel();
        if (event.isComposing || event.key === 'Dead' || event.key === 'Unidentified' || isSecret(event)) return;
        const parts = [];
        if (event.ctrlKey && event.key !== 'Control') parts.push('Ctrl');
        if (event.altKey && event.key !== 'Alt') parts.push('Alt');
        if (event.shiftKey && event.key !== 'Shift') parts.push('Shift');
        if (event.metaKey && event.key !== 'Meta') parts.push('Meta');
        parts.push(event.key === ' ' ? 'Space' : event.key);
        label.textContent = parts.join(' + ');
      });
      // Input.insertText (agent/mobile) has no keydown. Give feedback without reading data.
      listen('beforeinput', event => {
        if (event.isComposing || isSecret(event)) { clearLabel(); return; }
        if (event.inputType === 'insertFromPaste') label.textContent = 'Paste';
        else if (event.inputType === 'insertText') label.textContent = 'Typing';
      });
      listen('focusin', clearLabel);
      listen('focusout', clearLabel);
      listen('blur', clearLabel);
      document.documentElement.append(root);
    };
    if (document.documentElement) mount();
    else listen('DOMContentLoaded', mount);
    return true;
  })()`;
}

function resultField(value: unknown, field: string): unknown {
  return value && typeof value === 'object' ? Reflect.get(value, field) : undefined;
}

/** Paint into the existing JPEG source, including child frames and later navigations. */
export async function startBrowserRecordingOverlay(input: Readonly<{
  contextCapture: BrowserSidecarContextCaptureSurface;
  handle: BrowserSidecarCdpPageHandle;
  recordingId: string;
}>): Promise<Readonly<{ stop(): Promise<void> }>> {
  const { contextCapture, handle, recordingId } = input;
  const worldName = `happier.recording.overlay.${recordingId}`;
  const dispatch = (method: string, params?: Record<string, unknown>) =>
    contextCapture.transport.dispatchPageCommand({ ...handle, method, ...(params ? { params } : {}) });
  const installed = await dispatch('Page.addScriptToEvaluateOnNewDocument', {
    source: overlayExpression(recordingId), worldName, runImmediately: true,
  });
  const identifier = resultField(installed, 'identifier');
  if (typeof identifier !== 'string') throw new Error('Browser recording overlay installation was not acknowledged.');

  return {
    async stop() {
      await dispatch('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      // Removing the future-document hook does not dispose existing frame worlds.
      // Visit only this page's current frames, using the same isolated world name.
      const tree = resultField(await dispatch('Page.getFrameTree'), 'frameTree');
      async function clearFrame(node: unknown): Promise<void> {
        const frameId = resultField(resultField(node, 'frame'), 'id');
        if (typeof frameId !== 'string') throw new Error('Browser recording overlay frame is unavailable.');
        const context = await dispatch('Page.createIsolatedWorld', { frameId, worldName });
        const contextId = resultField(context, 'executionContextId');
        if (typeof contextId !== 'number') throw new Error('Browser recording overlay context is unavailable.');
        await dispatch('Runtime.evaluate', {
          expression: `globalThis[${JSON.stringify(worldName)}]?.()`, contextId, returnByValue: true,
        });
        const children = resultField(node, 'childFrames');
        if (Array.isArray(children)) await Promise.all(children.map(clearFrame));
      }
      await clearFrame(tree);
    },
  };
}
