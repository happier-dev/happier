/** Guest key interception consumes configured host signatures; the host owns command decisions. */
export const INJECTED_BROWSER_KEYBOARD_RUNTIME = `
  function installBrowserKeyboard(signatures, publish) {
    var previous = window.__happierBrowserKeyboard;
    if (previous) window.removeEventListener('keydown', previous, true);
    var listener = function (event) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      var key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      var signature = key + '|shift=' + event.shiftKey + '|ctrl=' + event.ctrlKey + '|meta=' + event.metaKey + '|alt=' + event.altKey;
      if (signatures.indexOf(signature) === -1) return;
      var target = event.target;
      var editable = Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
        || (target.closest && target.closest('[contenteditable="true"], [role="textbox"]'))));
      publish({ key: event.key, code: event.code, repeat: event.repeat,
        isEditableTarget: editable, modifiers: { shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey } });
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.__happierBrowserKeyboard = listener;
    if (signatures.length) window.addEventListener('keydown', listener, true);
  }
`;

/** Trusted desktop injection; IPC carries keyboard metadata only, never page input values. */
export function buildDesktopBrowserKeyboardScript(signatures: readonly string[]): string {
    return `(function () {${INJECTED_BROWSER_KEYBOARD_RUNTIME}\ninstallBrowserKeyboard(${JSON.stringify(signatures).replace(/</g, '\\u003c')}, function (event) {
      window.ipc.postMessage(JSON.stringify({ kind: 'happier:browser-key', event: event }));
    });})(); true;`;
}
