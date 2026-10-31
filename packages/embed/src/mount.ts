import {
  EmbedConfigureV1Schema, projectEmbedCredentialV1, EmbedErrorCodeV1Schema,
  EmbedFrameToHostEnvelopeV1Schema, EmbedReadyV1Schema, EmbedStyleV1Schema, EmbedUiOverridesV1Schema, wireIdentitiesEqual,
  EmbedHostToFrameEnvelopeV1Schema, EmbedCredentialResultEnvelopeV1Schema, EmbedCredentialErrorEnvelopeV1Schema, EmbedOpenV1Schema,
  type EmbedCredentialRequestV1,
  type EmbedErrorCodeV1,
} from '@happier-dev/protocol/embed';
import type { EmbedError, EmbedHandle, EmbedOptions, EmbedUpdate } from './types.js';
import { EMBED_PLACEHOLDER_THEME } from './themeTokenIds.js';

/** The same ready deadline as the hosted-web bootstrap, not a credential lifetime. */
const READY_TIMEOUT_MS = 30_000;
const BOOTSTRAP_ERROR_MESSAGE = "This conversation isn't available here.";

function readEmbedErrorCode(error: unknown): EmbedErrorCodeV1 {
  const object = error !== null && typeof error === 'object' ? error : null;
  for (const candidate of [
    object === null ? undefined : Reflect.get(object, 'code'),
    object === null ? undefined : Reflect.get(object, 'message'),
    error,
  ]) {
    const parsed = EmbedErrorCodeV1Schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return 'credential_unavailable';
}

/** Strict embed presentation values are JSON-only; compare them before crossing the frame wire. */
function areEmbedPresentationValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => areEmbedPresentationValuesEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => Object.hasOwn(rightRecord, key)
      && areEmbedPresentationValuesEqual(leftRecord[key], rightRecord[key]));
}

export function mountHappierSession(container: HTMLElement, options: EmbedOptions): EmbedHandle {
  const document = container.ownerDocument;
  const realm = document.defaultView;
  if (!realm) throw new Error('Happier embeds require a browser document');
  const baseUrl = new URL(options.happierUrl);
  if (!['https:', 'http:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error('happierUrl must be an HTTP(S) URL without credentials');
  }
  if (options.ui !== undefined) EmbedUiOverridesV1Schema.parse(options.ui);
  if (options.style !== undefined) EmbedStyleV1Schema.parse({ ...options.style, v: 1 });
  const identity = { instanceId: realm.crypto.randomUUID(), mountNonce: realm.crypto.randomUUID() };
  let currentId = options.sessionId ?? null;
  EmbedOpenV1Schema.parse({ kind: 'open', sessionId: currentId });
  let presentation: EmbedUpdate = { title: options.title, ui: options.ui, style: options.style };
  let disposed = false;
  let port: MessagePort | null = null;
  let readyPublicKey: string | null = null;
  let latestRequest: object | null = null;
  let sequence = 0;
  let lastFrameSequence = -1;
  let pendingCreatedSessionId: string | null = null;
  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;background:Canvas;color:CanvasText;container-type:inline-size';
  root.style.containerName = `happier-embed-${identity.instanceId}`;
  const frame = document.createElement('iframe');
  frame.title = options.title || 'Chat';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'strict-origin');
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0;opacity:0';
  // The supplied UI URL carries the selected Home. Replacing it with an
  // origin-relative URL silently sent the credential to the device default
  // Home instead, so change only the route and retain the selection query.
  const url = new URL(baseUrl.href);
  url.pathname = currentId === null ? '/embed/new' : `/embed/session/${encodeURIComponent(currentId)}`;
  url.hash = '';
  url.searchParams.set('i', identity.instanceId);
  url.searchParams.set('n', identity.mountNonce);
  frame.src = url.href;
  const placeholder = document.createElement('div');
  placeholder.setAttribute('role', 'status');
  placeholder.setAttribute('aria-label', `Loading ${frame.title}`);
  placeholder.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  const skeleton = document.createElement('div');
  skeleton.setAttribute('aria-hidden', 'true');
  skeleton.className = 'happier-embed-placeholder-composer';
  skeleton.style.cssText = `position:absolute;left:50%;transform:translateX(-50%);bottom:${EMBED_PLACEHOLDER_THEME.bottom}px;height:${EMBED_PLACEHOLDER_THEME.height}px;max-width:${EMBED_PLACEHOLDER_THEME.maxWidth}px;width:calc(100% - ${EMBED_PLACEHOLDER_THEME.horizontalPadding.narrow * 2}px)`;
  const responsiveStyle = document.createElement('style');
  responsiveStyle.textContent = `@container ${root.style.containerName} (width > ${EMBED_PLACEHOLDER_THEME.horizontalPadding.breakpoint}px){.happier-embed-placeholder-composer{width:calc(100% - ${EMBED_PLACEHOLDER_THEME.horizontalPadding.wide * 2}px)!important}}`;
  const failure = document.createElement('p');
  failure.hidden = true;
  failure.textContent = BOOTSTRAP_ERROR_MESSAGE;
  failure.style.cssText = 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center';
  placeholder.append(responsiveStyle, skeleton, failure);
  root.append(frame, placeholder);
  container.append(root);
  function showLoading() {
    if (placeholder.parentNode !== root) return;
    placeholder.setAttribute('role', 'status');
    placeholder.setAttribute('aria-label', `Loading ${frame.title}`);
    failure.removeAttribute('role');
    skeleton.hidden = false;
    failure.hidden = true;
    failure.style.display = 'none';
  }
  function surfaceBootstrapError(code: EmbedError) {
    if (placeholder.parentNode === root) {
      placeholder.removeAttribute('role');
      placeholder.removeAttribute('aria-label');
      skeleton.hidden = true;
      failure.hidden = false;
      failure.style.display = 'flex';
      failure.setAttribute('role', 'alert');
      frame.style.opacity = '0';
    }
    if (code !== 'frame_unreachable' && currentId !== null) {
      options.onStateChange?.({ sessionId: currentId, phase: 'error', error: code });
    }
    options.onError?.(code);
  }
  function applyPlaceholderStyle() {
    const style = presentation.style;
    const dark = style?.mode === 'dark' || (style?.mode !== 'light' && realm?.matchMedia?.('(prefers-color-scheme: dark)').matches);
    const canvas = style?.colors?.[dark ? 'dark' : 'light']?.['background.canvas'];
    root.style.backgroundColor = canvas ?? EMBED_PLACEHOLDER_THEME[dark ? 'dark' : 'light'].canvas;
    skeleton.style.backgroundColor = style?.colors?.[dark ? 'dark' : 'light']?.['surface.inset'] ?? EMBED_PLACEHOLDER_THEME[dark ? 'dark' : 'light'].skeleton;
    skeleton.style.borderRadius = `${EMBED_PLACEHOLDER_THEME.radiusScales[style?.radius ?? 'soft'][style?.parts?.composer?.radius ?? EMBED_PLACEHOLDER_THEME.composerRadiusStep]}px`;
  }
  applyPlaceholderStyle();
  const timeout = realm.setTimeout(() => { if (!disposed) surfaceBootstrapError('frame_unreachable'); }, READY_TIMEOUT_MS);
  function send(payload: unknown) {
    port?.postMessage(EmbedHostToFrameEnvelopeV1Schema.parse({ version: 1, identity, sequence: sequence++, direction: 'hostToFrame', payload }));
  }
  async function requestCredential(request: EmbedCredentialRequestV1, requestSequence: number) {
    const requestPort = port;
    const ticket = {};
    latestRequest = ticket;
    const { kind: _kind, ...input } = request;
    try {
      const credential = projectEmbedCredentialV1(await options.getCredential(input));
      if (disposed || latestRequest !== ticket || port !== requestPort) return;
      port?.postMessage(EmbedCredentialResultEnvelopeV1Schema.parse({ version: 1, identity, sequence: sequence++, requestSequence, kind: 'result', payload: credential }));
    } catch (error) {
      if (disposed || latestRequest !== ticket || port !== requestPort) return;
      const code = readEmbedErrorCode(error);
      options.onError?.(code);
      port?.postMessage(EmbedCredentialErrorEnvelopeV1Schema.parse({ version: 1, identity, sequence: sequence++, requestSequence, kind: 'error', payload: { code } }));
    }
  }
  function onPortMessage(event: MessageEvent<unknown>) {
    const parsed = EmbedFrameToHostEnvelopeV1Schema.safeParse(event.data);
    if (!parsed.success || !wireIdentitiesEqual(parsed.data.identity, identity) || parsed.data.sequence <= lastFrameSequence) return;
    lastFrameSequence = parsed.data.sequence;
    const payload = parsed.data.payload;
    if (payload.kind === 'credential.request') {
      if (currentId !== null && payload.sessionId !== currentId) return;
      void requestCredential(payload, parsed.data.sequence);
    } else if (payload.kind === 'session.created') {
      if (currentId === null) pendingCreatedSessionId = payload.sessionId;
      options.onSessionCreated?.({ sessionId: payload.sessionId });
    } else {
      if (currentId !== null && payload.sessionId !== currentId) return;
      if (payload.phase === 'ready' || payload.phase === 'error') {
        if (currentId === null && payload.phase === 'ready') currentId = payload.sessionId;
        if (payload.phase === 'ready') pendingCreatedSessionId = null;
        frame.style.transition = realm?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'none' : `opacity ${EMBED_PLACEHOLDER_THEME.fadeMs}ms ${EMBED_PLACEHOLDER_THEME.easingCss}`;
        frame.style.opacity = '1';
        placeholder.remove();
      }
      const { kind: _kind, ...state } = payload;
      options.onStateChange?.(state);
      if (payload.error) options.onError?.(payload.error);
    }
  }
  function onWindowMessage(event: MessageEvent<unknown>) {
    if (disposed || event.source !== frame.contentWindow || event.origin !== baseUrl.origin) return;
    const parsed = EmbedReadyV1Schema.safeParse(event.data);
    if (!parsed.success || !wireIdentitiesEqual(parsed.data.identity, identity)) return;
    realm!.clearTimeout(timeout);
    showLoading();
    latestRequest = null;
    if (port) { port.onmessage = null; port.close(); }
    port = null;
    readyPublicKey = parsed.data.embedPublicKey;
    void initialise(readyPublicKey);
  }
  async function initialise(embedPublicKey: string) {
    const ticket = {};
    latestRequest = ticket;
    let channel: MessageChannel | null = null;
    try {
      const credential = projectEmbedCredentialV1(await options.getCredential({ ...(currentId === null ? {} : { sessionId: currentId }), embedPublicKey, reason: 'initial' }));
      if (disposed || latestRequest !== ticket) return;
      const activeChannel = new realm!.MessageChannel();
      channel = activeChannel;
      port = activeChannel.port1;
      lastFrameSequence = -1;
      port.onmessage = (event) => { if (!disposed && port === activeChannel.port1) onPortMessage(event); };
      port.start();
      frame.contentWindow?.postMessage(EmbedHostToFrameEnvelopeV1Schema.parse({ version: 1, identity, sequence: sequence++, direction: 'hostToFrame', payload: {
        kind: 'init', identity, ...(currentId === null ? {} : { sessionId: currentId }), credential,
        ...(presentation.ui === undefined ? {} : { ui: presentation.ui }),
        ...(presentation.style === undefined ? {} : { style: { ...presentation.style, v: 1 } }),
      } }), baseUrl.origin, [activeChannel.port2]);
    } catch (error) {
      if (channel) {
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
        if (port === channel.port1) port = null;
      }
      if (!disposed && latestRequest === ticket) {
        surfaceBootstrapError(readEmbedErrorCode(error));
      }
    }
  }
  realm.addEventListener('message', onWindowMessage);
  return {
    open(sessionId) {
      if (disposed) return;
      const payload = EmbedOpenV1Schema.parse({ kind: 'open', sessionId });
      if (payload.sessionId === currentId) return;
      if (currentId === null && payload.sessionId !== null && payload.sessionId === pendingCreatedSessionId) {
        // React may feed the authoritative creation fact straight back as sessionId.
        // Adopt it without canceling the frame's credential exchange/first-turn custody.
        currentId = payload.sessionId;
        pendingCreatedSessionId = null;
        return;
      }
      currentId = payload.sessionId;
      pendingCreatedSessionId = null;
      latestRequest = null;
      if (port) send(payload);
      else if (readyPublicKey) void initialise(readyPublicKey);
    },
    update(update) {
      if (disposed) return;
      const parsed = EmbedConfigureV1Schema.safeParse({ kind: 'configure', ...(update.ui === undefined ? {} : { ui: update.ui }), ...(update.style === undefined ? {} : { style: { ...update.style, v: 1 } }) });
      if (!parsed.success) return;
      const titleChanged = update.title !== undefined && update.title !== presentation.title;
      const uiChanged = parsed.data.ui !== undefined
        && !areEmbedPresentationValuesEqual(parsed.data.ui, presentation.ui);
      const styleChanged = parsed.data.style !== undefined
        && !areEmbedPresentationValuesEqual(parsed.data.style,
          presentation.style === undefined ? undefined : { ...presentation.style, v: 1 });
      if (!titleChanged && !uiChanged && !styleChanged) return;
      presentation = { ...presentation, ...update };
      if (titleChanged) {
        frame.title = update.title || 'Chat';
        if (placeholder.getAttribute('role') === 'status') {
          placeholder.setAttribute('aria-label', `Loading ${frame.title}`);
        }
      }
      if (styleChanged) applyPlaceholderStyle();
      if (uiChanged || styleChanged) send({
        kind: 'configure',
        ...(uiChanged ? { ui: parsed.data.ui } : {}),
        ...(styleChanged ? { style: parsed.data.style } : {}),
      });
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      latestRequest = null;
      realm!.clearTimeout(timeout);
      realm!.removeEventListener('message', onWindowMessage);
      if (port) { port.onmessage = null; port.close(); port = null; }
      root.remove();
    },
  };
}
