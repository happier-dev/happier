#!/usr/bin/env node
/**
 * Source/browser QA for the incumbent hosted-web bridge and static-server path.
 *
 * The bytes are served by the production `startHostedWebStaticAssetServer`; the
 * guest runs the SDK client bootstrap; the host runs the production hosted-web
 * bridge and inbound validator. Chromium enforces the CSP, sandbox, origin, and
 * postMessage rules that source-only tests cannot prove.
 *
 * This is bridge/static-server regression coverage only. It does not establish
 * an Artifact-backed packaged-frame adapter feasibility cell or platform
 * admission, which remains unavailable unless independently proven.
 *
 * Usage: node packages/tests/scripts/plugin-platform/run-hosted-web-bridge-browser-qa.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    process.stdout.write(`PASS ${label}\n`);
    return;
  }
  failures.push(`${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
  process.stdout.write(`FAIL ${label} ${detail === undefined ? '' : JSON.stringify(detail)}\n`);
}

const IDENTITY = {
  instanceId: 'opaque-live-1',
  mountNonce: 'nonce-live-1',
};
const AUTHOR_PLUGIN = { id: 'acme.preview', version: '1.2.3' };
const VIEW_ID = 'preview-pane';
const CONTRIBUTION_ID = 'preview-web';
const SURFACE_ID = 'appSurface:acme.preview:preview-pane';

function surfaceSnapshot(overrides = {}) {
  return {
    mount: {
      kind: 'destination',
      destination: { pluginId: AUTHOR_PLUGIN.id, localId: VIEW_ID },
      container: 'appPage',
    },
    target: { kind: 'app' },
    accountEncryptionMode: 'plain',
    platform: 'web',
    locale: 'en',
    direction: 'ltr',
    colorScheme: 'dark',
    contrast: 'normal',
    textScale: 1,
    reducedMotion: false,
    screenReaderEnabled: false,
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    theme: {
      version: 1,
      colors: {
        canvas: '#101014', surface: '#17171c', elevatedSurface: '#1e1e24', text: '#f5f5f7',
        secondaryText: '#b9b9c2', mutedText: '#8a8a95', border: '#2c2c34', divider: '#24242b',
        focus: '#6f8cff', accent: '#6f8cff', onAccent: '#0b0b0f', success: '#57c98a',
        warning: '#e0b341', attention: '#e0b65a', danger: '#e2606b', info: '#5fb6e5', control: '#22222a',
        controlDisabled: '#1a1a20', overlay: '#00000099',
      },
      spacing: { xsmall: 4, small: 8, medium: 12, large: 16, xlarge: 24 },
      radii: { small: 4, control: 6, panel: 10, pill: 999 },
      typography: {
        body: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
        reading: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
        label: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
        title: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
        caption: { fontSize: 11, lineHeight: 14, fontWeight: '400' },
        code: { fontSize: 13, lineHeight: 18, fontFamily: 'monospace' },
      },
    },
    translations: { 'preview.title': 'Preview' },
    targetedContributions: {
      target: {
        pluginId: AUTHOR_PLUGIN.id,
        immutableGenerationId: 'target-generation-live',
      },
      points: [],
    },
    ...overrides,
  };
}

async function bundle(entry, outfile, options = {}) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    // Generated entries live under the temporary workspace; give esbuild the
    // repository's workspace dependency root without moving those entries back
    // into the shared checkout.
    nodePaths: [join(repoRoot, 'node_modules')],
    absWorkingDir: repoRoot,
    logLevel: 'silent',
    ...options,
    // This source QA follows the moving SDK and wire owners, not a stale dist.
    alias: {
      '@happier-dev/plugin-sdk/ui/client': join(repoRoot, 'packages/plugin-sdk/src/ui/client/index.ts'),
      '@happier-dev/protocol/plugins/ui/client': join(repoRoot, 'packages/protocol/src/plugins/ui/client.ts'),
      '@happier-dev/protocol/plugins/ui/targetedContributions': join(repoRoot, 'packages/protocol/src/plugins/ui/targetedContributions.ts'),
      '@happier-dev/protocol/plugins/ui': join(repoRoot, 'packages/protocol/src/plugins/ui/index.ts'),
      '@happier-dev/protocol/plugins/contribution-identity': join(repoRoot, 'packages/protocol/src/plugins/contributionIdentity.ts'),
      ...options.alias,
    },
  });
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-hosted-web-bridge-qa-'));
  const assetRoot = join(workspace, 'hosted-web', CONTRIBUTION_ID);
  await mkdir(assetRoot, { recursive: true });

  // Keep generated bundle entries in this invocation's private workspace. The
  // runner may execute beside other QA lanes, so source entries cannot occupy
  // shared paths in the checkout.
  const guestEntry = join(workspace, 'guest-entry.mjs');
  const hostEntry = join(workspace, 'host-entry.mjs');
  const nodeEntry = join(workspace, 'node-entry.mjs');

  await writeFile(guestEntry, `
import { applyPluginUiThemeCssVariables, createPluginUiRenderContext } from '@happier-dev/plugin-sdk/ui/client';

const out = (key, value) => { document.body.dataset[key] = typeof value === 'string' ? value : JSON.stringify(value); };
async function main() {
  const context = await createPluginUiRenderContext();
  context.signal.addEventListener('abort', () => out('retired', 'yes'), { once: true });
  applyPluginUiThemeCssVariables(context.surface.theme, document.documentElement);
  out('negotiated', 'yes');
  out('mountcontainer', context.surface.mount.kind === 'destination'
    ? context.surface.mount.container
    : context.surface.mount.presentation);
  out('subpath', context.subPath ?? '');
  out('launchinput', context.launchInput ?? null);
  out('methods', context.hostApi.version().methods.join(','));
  try { void parent.document; out('parentaccess', 'readable'); } catch { out('parentaccess', 'blocked'); }
  try { localStorage.setItem('inline-probe', 'value'); localStorage.removeItem('inline-probe'); out('storageaccess', 'readable'); } catch { out('storageaccess', 'blocked'); }
  let cancellation;
  window.startSlowRead = () => {
    cancellation = new AbortController();
    void context.hostApi.readResource('slow', { signal: cancellation.signal })
      .then(() => out('readresult', 'unexpected-success'), (error) => { out('readresult', 'cancelled'); out('readerror', String(error.message)); });
  };
  window.cancelSlowRead = () => cancellation.abort();
  if (context.hostApi.version().methods.includes('watchContext')) {
    await context.hostApi.watchContext((surface) => { out('pushedlocale', surface.locale); });
    out('watching', 'yes');
  }
}
void main().catch((error) => { out('error', String(error && error.message ? error.message : error)); });
`, 'utf8');
  await bundle(guestEntry, join(assetRoot, 'guest.js'));
  const inlineGuestPath = join(workspace, 'inline-guest.js');
  await bundle(guestEntry, inlineGuestPath, { format: 'iife', minify: true });
  const inlineGuest = await readFile(inlineGuestPath, 'utf8');
  const inlineHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Inline guest</title></head>'
    + '<body><main>Self-contained SDK guest</main><script>' + inlineGuest + '</script></body></html>';
  await writeFile(join(assetRoot, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>EU-8 guest</title></head>
<body><main id="root"></main><script type="module" src="./guest.js"></script></body></html>
`, 'utf8');

  await writeFile(hostEntry, `
import { createPluginHostedWebHostApiBridgeHandler } from '${repoRoot}/apps/ui/sources/components/plugins/hostApi/hostedWebAdapter.ts';
import { validatePluginHostedWebBridgeMessage } from '${repoRoot}/apps/ui/sources/components/plugins/hostedWeb/bridge.ts';
import { buildHostedHtmlDocument } from '${repoRoot}/apps/ui/sources/components/plugins/hostedWeb/buildHostedHtmlDocument.ts';
import { PluginUiSurfaceContextV1Schema } from '@happier-dev/protocol/plugins/ui';
globalThis.__EU8__ = { createPluginHostedWebHostApiBridgeHandler, validatePluginHostedWebBridgeMessage, buildHostedHtmlDocument, PluginUiSurfaceContextV1Schema };
`, 'utf8');
  const hostBundlePath = join(workspace, 'host-bridge.js');
  await bundle(hostEntry, hostBundlePath, {
    tsconfig: join(repoRoot, 'apps/ui/tsconfig.json'),
    alias: { '@': join(repoRoot, 'apps/ui/sources') },
  });

  await writeFile(nodeEntry, `
export { startHostedWebStaticAssetServer } from '${repoRoot}/apps/cli/src/daemon/local/services/plugins/staticAssets/server.ts';
export { PluginHostedWebSecurityPolicyV1Schema } from '${repoRoot}/packages/protocol/src/plugins/ui/index.ts';
export { PluginHostedHtmlSourceV1Schema, MAX_PLUGIN_HOSTED_HTML_SOURCE_UTF8_BYTES_V1 } from '${repoRoot}/packages/protocol/src/plugins/ui/index.ts';
export { PluginUiHostApiSurfaceContextV1Schema } from '${repoRoot}/packages/protocol/src/plugins/ui/index.ts';
export { definePlugin } from '${repoRoot}/packages/plugin-sdk/src/definePlugin.ts';
export { defineUiSurfaceDefinition } from '${repoRoot}/packages/plugin-sdk/src/ui/surface.ts';
export { createPluginCompatibilityProjectionV1, MAX_PLUGIN_COMPATIBILITY_PROJECTION_BYTES } from '${repoRoot}/packages/protocol/src/plugins/availability/v1.ts';
export { createCanonicalJsonSigningInput } from '${repoRoot}/packages/protocol/src/crypto/canonicalJson.ts';
export { resolveHostedPluginWebSandboxPolicy } from '${repoRoot}/apps/ui/sources/components/browser/adapters/HostedPluginTargetSecurity.ts';
`, 'utf8');
  const nodeBundlePath = join(workspace, 'node-owners.mjs');
  await bundle(nodeEntry, nodeBundlePath, {
    platform: 'node',
    target: 'node20',
    alias: { '@': join(repoRoot, 'apps/cli/src') },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  const {
    startHostedWebStaticAssetServer,
    PluginHostedWebSecurityPolicyV1Schema,
    resolveHostedPluginWebSandboxPolicy,
    PluginHostedHtmlSourceV1Schema,
    MAX_PLUGIN_HOSTED_HTML_SOURCE_UTF8_BYTES_V1,
    PluginUiHostApiSurfaceContextV1Schema,
    definePlugin,
    defineUiSurfaceDefinition,
    createPluginCompatibilityProjectionV1,
    MAX_PLUGIN_COMPATIBILITY_PROJECTION_BYTES,
    createCanonicalJsonSigningInput,
  } = await import(nodeBundlePath);
  const inlineSource = PluginHostedHtmlSourceV1Schema.parse({ kind: 'html', html: inlineHtml });
  const admittedSurface = PluginUiHostApiSurfaceContextV1Schema.parse(surfaceSnapshot());
  check('complete self-contained SDK document fits the supported UTF-8 budget',
    Buffer.byteLength(inlineSource.html) <= MAX_PLUGIN_HOSTED_HTML_SOURCE_UTF8_BYTES_V1,
    { documentBytes: Buffer.byteLength(inlineSource.html), maximumBytes: MAX_PLUGIN_HOSTED_HTML_SOURCE_UTF8_BYTES_V1 });
  const createInlinePlugin = (source) => definePlugin({
    id: AUTHOR_PLUGIN.id,
    version: AUTHOR_PLUGIN.version,
    ui: { surfaces: [defineUiSurfaceDefinition({
      id: VIEW_ID, placement: 'appPage',
      renderer: { kind: 'hostedHtml', source },
    })] },
  });
  const plugin = createInlinePlugin(inlineSource);
  const projection = createPluginCompatibilityProjectionV1({
    manifest: plugin.manifest,
    uiArtifacts: { version: 1, entries: [] },
  });
  const projectionBytes = Buffer.byteLength(createCanonicalJsonSigningInput(projection));
  check('SDK-authored inline plugin passes the canonical compatibility projection',
    projectionBytes <= MAX_PLUGIN_COMPATIBILITY_PROJECTION_BYTES);
  const nearBoundSource = PluginHostedHtmlSourceV1Schema.parse({
    kind: 'html', html: 'x'.repeat(MAX_PLUGIN_HOSTED_HTML_SOURCE_UTF8_BYTES_V1),
  });
  let nearBoundRejected = false;
  try {
    createPluginCompatibilityProjectionV1({
      manifest: createInlinePlugin(nearBoundSource).manifest,
      uiArtifacts: { version: 1, entries: [] },
    });
  } catch (error) {
    nearBoundRejected = Array.isArray(error.issues) && error.issues.some((issue) =>
      issue.message === 'Compatibility projection exceeds the bounded canonical payload size.');
  }
  check('near-bound source still obeys the enclosing compatibility projection budget', nearBoundRejected);
  process.stdout.write(`Inline budget evidence: ${JSON.stringify({
    documentBytes: Buffer.byteLength(inlineSource.html), projectionBytes,
    sourceMaximumBytes: MAX_PLUGIN_HOSTED_HTML_SOURCE_UTF8_BYTES_V1,
    projectionMaximumBytes: MAX_PLUGIN_COMPATIBILITY_PROJECTION_BYTES,
    nearBoundSourceBytes: Buffer.byteLength(nearBoundSource.html), nearBoundRejected,
  })}\n`);

  const assetServer = await startHostedWebStaticAssetServer({
    installedRoot: workspace,
    assetRootId: `hosted-web/${CONTRIBUTION_ID}`,
    entryPath: `hosted-web/${CONTRIBUTION_ID}/index.html`,
    files: [`hosted-web/${CONTRIBUTION_ID}/index.html`, `hosted-web/${CONTRIBUTION_ID}/guest.js`],
    digest: `sha256:${'b'.repeat(64)}`,
    routeMode: 'pathFallback',
    security: PluginHostedWebSecurityPolicyV1Schema.parse({}),
    sourceMaps: { enabled: false },
    verifyArtifact: () => ({ ok: true }),
    preview: {
      pluginId: AUTHOR_PLUGIN.id,
      contributionId: CONTRIBUTION_ID,
      sessionId: 'session-live',
      machineId: 'machine-live',
      title: 'EU-8 hosted web',
    },
  });

  const ancestorToken = new URLSearchParams(assetServer.previewResource.initialPath.search)
    .get('happierAncestorToken');
  check('daemon issues a frame-ancestor capability', typeof ancestorToken === 'string' && ancestorToken.length >= 32);

  const hostBundle = await import('node:fs/promises').then((fs) => fs.readFile(hostBundlePath, 'utf8'));
  const hostServer = createServer((request, response) => {
    if (request.url?.startsWith('/host-bridge.js')) {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(hostBundle);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(HOST_PAGE);
  });
  await new Promise((done) => hostServer.listen(0, '127.0.0.1', done));
  const hostOrigin = `http://127.0.0.1:${hostServer.address().port}`;
  const assetOrigin = assetServer.baseUrl;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  try {
    await page.goto(`${hostOrigin}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async (input) => {
      await window.startEu8Host(input);
    }, {
      assetOrigin,
      token: ancestorToken,
      identity: IDENTITY,
      authorPlugin: AUTHOR_PLUGIN,
      contributionId: CONTRIBUTION_ID,
      surfaceId: SURFACE_ID,
      surface: admittedSurface,
    });

    const frame = page.frameLocator('#plugin-frame');
    await frame.locator('body[data-negotiated="yes"]').waitFor({ state: 'attached', timeout: 20_000 });
    check('served asset loads inside the real host iframe under its response CSP', true);

    const guestFrame = page.frames().find((candidate) => candidate.url().startsWith(assetOrigin));
    const guestUrl = new URL(guestFrame.url());
    const observed = await guestFrame.evaluate(() => ({
      ...document.body.dataset,
      canvasVariable: document.documentElement.style.getPropertyValue('--happier-plugin-color-canvas'),
    }));
    check('canonical negotiation crosses the real origin boundary', observed.mountcontainer === 'appPage', observed);
    check('watchContext is advertised over the hosted-web transport',
      String(observed.methods).split(',').includes('watchContext'), observed.methods);
    check('subPath reaches the guest realm in-frame', observed.subpath === 'work/ideas.md', observed.subpath);
    check('launchInput reaches the guest realm in-frame',
      observed.launchinput === JSON.stringify({ noteId: 'note-7' }), observed.launchinput);
    const leakedFrameQueryFacts = [
      'happierPluginVersion',
      'happierPluginId',
      'happierContributionId',
      'happierSurfaceId',
      'happierViewId',
      'happierGeneration',
      'happierSubPath',
      'happierLaunchInput',
    ].filter((key) => guestUrl.searchParams.has(key));
    check('launch and runtime facts are absent from the frame URL',
      leakedFrameQueryFacts.length === 0,
      { href: guestUrl.href, leakedFrameQueryFacts });
    check('semantic theme is applied as --happier-plugin-* custom properties',
      observed.canvasVariable === '#101014', observed.canvasVariable);

    await page.evaluate(() => window.pushLocale('fr'));
    await frame.locator('body[data-pushedlocale="fr"]').waitFor({ state: 'attached', timeout: 20_000 });
    check('a HOST-INITIATED message reaches a watchContext subscriber in the frame', true);

    const unexpectedConsoleErrors = consoleErrors.filter(
      (text) => !text.includes("Unrecognized Content-Security-Policy directive 'navigate-to'"),
    );
    check('no unexpected guest console error', unexpectedConsoleErrors.length === 0, unexpectedConsoleErrors);

    await page.evaluate(async (origin) => { await window.probeForgedAncestor(origin); }, assetOrigin);
    let forgedRan = false;
    try {
      await page.frameLocator('#probe-frame').locator('body[data-negotiated="yes"]').waitFor({ state: 'attached', timeout: 4_000 });
      forgedRan = true;
    } catch {
      forgedRan = false;
    }
    check('an ancestor without the daemon-issued token is refused by the browser', forgedRan === false);

    const productionSandbox = resolveHostedPluginWebSandboxPolicy({
      sandbox: { scripts: true, sameOrigin: true, popups: false, topNavigation: false, mixedContent: false },
      security: PluginHostedWebSecurityPolicyV1Schema.parse({}),
      url: `${assetOrigin}/`,
    });
    check('production sandbox gives the daemon-served guest an addressable origin',
      productionSandbox.sameOrigin === true, productionSandbox);

    await page.goto(`${hostOrigin}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async (input) => window.startEu8Host(input), {
      identity: { instanceId: 'opaque-inline-1', mountNonce: 'nonce-inline-1' },
      authorPlugin: AUTHOR_PLUGIN,
      contributionId: CONTRIBUTION_ID,
      surfaceId: SURFACE_ID,
      surface: admittedSurface,
      inlineHtml: inlineSource.html,
    });
    const inlineFrame = page.frameLocator('#plugin-frame');
    await inlineFrame.locator('body[data-negotiated="yes"]').waitFor({ state: 'attached', timeout: 20_000 });
    const inlineObserved = await inlineFrame.locator('body').evaluate((body) => ({ ...body.dataset }));
    check('opaque inline document negotiates the existing SDK Host API', inlineObserved.mountcontainer === 'appPage', inlineObserved);
    check('opaque inline document cannot read host DOM or origin storage',
      inlineObserved.parentaccess === 'blocked' && inlineObserved.storageaccess === 'blocked', inlineObserved);
    await page.evaluate(() => window.copyOpaqueFrame());
    await page.waitForTimeout(250);
    const copiedNegotiated = await page.frameLocator('#copied-frame').locator('body').getAttribute('data-negotiated');
    check('copied opaque identity cannot negotiate from a different frame window', copiedNegotiated === null, copiedNegotiated);
    await inlineFrame.locator('body').evaluate(() => window.startSlowRead());
    await page.locator('body[data-readpending="yes"]').waitFor({ state: 'attached', timeout: 5_000 });
    await inlineFrame.locator('body').evaluate(() => window.cancelSlowRead());
    await page.locator('body[data-readcancelled="yes"]').waitFor({ state: 'attached', timeout: 5_000 });
    check('inline SDK cancellation reaches the existing mounted request signal', true);
    await page.evaluate(() => window.pushLocale('de'));
    await inlineFrame.locator('body[data-pushedlocale="de"]').waitFor({ state: 'attached', timeout: 5_000 });
    check('inline context updates reuse the existing subscription transport', true);
    await page.evaluate(() => window.retireHost());
    await inlineFrame.locator('body[data-retired="yes"]').waitFor({ state: 'attached', timeout: 5_000 });
    check('host retirement aborts the real inline SDK RenderContext', true);
  } catch (error) {
    const frames = await Promise.all(page.frames().map(async (frame) => ({
      source: frame.url().split('?')[0],
      state: await frame.evaluate(() => ({ ...document.body?.dataset })).catch(() => null),
    })));
    process.stdout.write(`Browser QA failure context: ${JSON.stringify({ frames, consoleErrors })}\n`);
    throw error;
  } finally {
    await browser.close();
    await new Promise((done) => hostServer.close(done));
    await assetServer.stop();
    await rm(workspace, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stdout.write(`\nHosted-web bridge browser QA FAILED (${failures.length}):\n${failures.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\nHosted-web bridge browser QA PASSED\n');
}

const HOST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>EU-8 host</title></head>
<body>
<script type="module">
import '/host-bridge.js';
const { createPluginHostedWebHostApiBridgeHandler, validatePluginHostedWebBridgeMessage, buildHostedHtmlDocument } = globalThis.__EU8__;
let handler;
let frameWindow;
let assetOriginGlobal;
let surfaceGlobal;

window.startEu8Host = async ({ assetOrigin, token, identity, authorPlugin, contributionId, surfaceId, surface, inlineHtml }) => {
  assetOriginGlobal = assetOrigin;
  surfaceGlobal = surface;
  const frameOrigin = inlineHtml === undefined ? assetOrigin : 'null';
  const targetOrigin = inlineHtml === undefined ? assetOrigin : '*';
  const legacySurface = window.__EU8__.PluginUiSurfaceContextV1Schema.parse({
    pluginId: authorPlugin.id,
    contributionId,
    surfaceId,
    placement: 'appSurface',
    platform: 'web',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
  });
  const allowed = new Set(['hostApi', 'ready']);
  let sink = null;
  handler = createPluginHostedWebHostApiBridgeHandler({
    surface: legacySurface,
    requestIdPrefix: 'live',
    identity,
    canonicalHostApi: { identity, authorPlugin, surface, methods: ['context', 'readResource'] },
    handleRequest: (request, options) => {
      if (request.method !== 'readResource') throw new Error('Unexpected QA host operation');
      document.body.dataset.readpending = 'yes';
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          document.body.dataset.readcancelled = 'yes';
          reject(new Error('QA resource boundary cancelled'));
        }, { once: true });
      });
    },
    postToFrame: (envelope) => { sink?.(envelope); },
    bootstrap: {
      frameOrigin,
      subPath: 'work/ideas.md',
      launchInput: { noteId: 'note-7' },
    },
  });
  sink = (envelope) => { frameWindow?.postMessage(envelope, targetOrigin); };

  window.addEventListener('message', (event) => {
    if (event.source !== frameWindow) return;
    const result = validatePluginHostedWebBridgeMessage({
      message: event.data,
      origin: event.origin,
      expectedOrigin: frameOrigin,
      identity,
      allowedMessageKinds: allowed,
    });
    if (!result.ok) { document.body.dataset.rejected = result.code; return; }
    void Promise.resolve(handler(result.envelope)).then((response) => {
      if (response) frameWindow.postMessage(response, targetOrigin);
    });
  });

  const frame = document.createElement('iframe');
  frame.id = 'plugin-frame';
  frame.setAttribute('sandbox', inlineHtml === undefined ? 'allow-scripts allow-same-origin' : 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  if (inlineHtml === undefined) {
    const url = new URL(assetOrigin + '/');
    url.searchParams.set('happierAncestorToken', token);
    url.searchParams.set('happierHostOrigin', window.location.origin);
    url.searchParams.set('happierBridgeNonce', identity.mountNonce);
    url.searchParams.set('happierInstanceId', identity.instanceId);
    frame.src = url.toString();
  } else {
    frame.srcdoc = buildHostedHtmlDocument(inlineHtml, { identity, frameOrigin, hostOrigin: window.location.origin });
  }
  document.body.appendChild(frame);
  frameWindow = frame.contentWindow;
  await new Promise((done) => { frame.addEventListener('load', done, { once: true }); });
  frameWindow = frame.contentWindow;
};

window.pushLocale = (locale) => {
  handler.pushSurfaceContext({ ...surfaceGlobal, locale });
};

window.retireHost = () => handler.dispose();
window.copyOpaqueFrame = async () => {
  const copy = document.createElement('iframe');
  copy.id = 'copied-frame';
  copy.setAttribute('sandbox', 'allow-scripts');
  copy.srcdoc = document.getElementById('plugin-frame').srcdoc;
  const loaded = new Promise((resolve) => copy.addEventListener('load', resolve, { once: true }));
  document.body.appendChild(copy);
  await loaded;
};

window.probeForgedAncestor = async (assetOrigin) => {
  const url = new URL(assetOrigin + '/');
  url.searchParams.set('happierHostOrigin', window.location.origin);
  const probe = document.createElement('iframe');
  probe.id = 'probe-frame';
  probe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  probe.src = url.toString();
  document.body.appendChild(probe);
  await new Promise((done) => { setTimeout(done, 500); });
  return { appended: true };
};
</script>
</body></html>`;

await main();
