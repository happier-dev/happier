import { parse as parseHtml, serialize, defaultTreeAdapter, type DefaultTreeAdapterTypes } from 'parse5';
import { parse as parseModule } from 'es-module-lexer/js';

import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { artifactHtmlFrameAdmissionScriptV1, isArtifactHtmlNetworkHintRelV1 } from './artifactHtmlFrameAdmissionV1.js';
import { ArtifactHtmlBundleV1Schema, GeneratedArtifactHtmlBundleV1Schema, type ArtifactHtmlBundleV1 } from './artifactHtmlV1.js';
import type { PluginHostedWebBridgeBootstrapConfigV1 } from '../plugins/ui/hostedWebBridge.js';
import { normalizeUiSurfaceCapabilityRequestV1, type UiSurfaceCapabilityRequestV1 } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';

export const ARTIFACT_HTML_SANDBOX_V1 = 'allow-scripts';
/** Native top-level documents need a response header; meta cannot sandbox. */
export const ARTIFACT_HTML_RESPONSE_SANDBOX_CSP_V1 = `sandbox ${ARTIFACT_HTML_SANDBOX_V1}`;
// data: connects only to opened bundle bytes. No HTTP, host-origin, worker or
// nested-frame permission is needed to execute modules or read local resources.
export function buildArtifactHtmlContentCspV1(requestedCapabilities?: unknown): string {
  const policy = normalizeUiSurfaceCapabilityRequestV1(requestedCapabilities);
  const destinations = policy?.network === 'open' ? ['https:'] : policy?.network === 'origins' ? policy.networkOrigins : [];
  const remote = destinations.length > 0 ? ' ' + destinations.join(' ') : '';
  return `default-src 'none'; script-src 'unsafe-inline' data:${remote}; style-src 'unsafe-inline' data:${remote}; img-src data:${remote}; font-src data:${remote}; media-src data:${remote}; connect-src data:${remote}; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
export const ARTIFACT_HTML_CONTENT_CSP_V1 = buildArtifactHtmlContentCspV1();
/** srcdoc inherits this ceiling and adds its own stored, narrower guest policy. */
export const ARTIFACT_HTML_SHELL_CSP_V1 = buildArtifactHtmlContentCspV1({ network: 'open' })
  .replace("script-src 'unsafe-inline' data:", "script-src 'self' 'unsafe-inline' blob: data:")
  .replace("connect-src data:", "connect-src 'self' data:")
  .replace('img-src data:', 'img-src blob: data:')
  .replace('media-src data:', 'media-src blob: data:')
  .replace("object-src 'none'", 'object-src blob:');

const BUNDLE_ORIGIN = 'https://happier-bundle.invalid';
const JAVASCRIPT_MIMES = new Set(['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript']);
type Element = DefaultTreeAdapterTypes.Element;
type ImportMap = Readonly<Record<string, string | null>>;

// These native browser bindings are used only by the serialized guest below.
// Keep their reflection-only types local so host compilers need no DOM globals.
declare const XMLHttpRequest: Readonly<{ prototype: {
  open(this: unknown, method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null): void;
} }>;


function collectFrameElements(parsed: DefaultTreeAdapterTypes.ParentNode, egressCeiling = true): Element[] {
  const elements: Element[] = [];
  const collect = (node: DefaultTreeAdapterTypes.ParentNode): void => {
    for (const child of [...node.childNodes]) {
      if (!('tagName' in child)) continue;
      if (child.tagName === 'base'
        || (egressCeiling && ['iframe', 'frame', 'frameset', 'object', 'embed'].includes(child.tagName))
        || (egressCeiling && child.tagName === 'link' && child.attrs.some(attr => attr.name === 'rel' && isArtifactHtmlNetworkHintRelV1(attr.value)))
        || (child.tagName === 'meta' && child.attrs.some(attr => attr.name === 'http-equiv'))) {
        defaultTreeAdapter.detachNode(child);
        continue;
      }
      elements.push(child);
      collect(child);
      if (child.tagName === 'template' && 'content' in child) collect(child.content);
    }
  };
  collect(parsed);
  return elements;
}
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

/** Installed before authored code; resolves bytes locally, never via a host service. */
function installBundleResources(urls: Readonly<Record<string, string>>, entrypoint: string): void {
  const resolve = (value: string, from = entrypoint): string => {
    const url = new URL(value, from);
    if (url.origin !== new URL(entrypoint).origin) return url.href;
    const key = url.origin + url.pathname;
    if (!Object.hasOwn(urls, key)) throw new TypeError('HTML bundle resource is missing: ' + url.pathname);
    return urls[key] + url.hash;
  };
  Object.defineProperty(globalThis, '__HAPPIER_HTML_BUNDLE_RESOLVE_V1__', { value: resolve, writable: false, configurable: false });
  const fetchResource = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    try {
      const source = input instanceof Request ? input.url : String(input);
      const target = resolve(source);
      return fetchResource(input instanceof Request ? new Request(target, input) : target, { ...init, credentials: 'omit' });
    } catch (error) { return Promise.reject(error); }
  };
  const openResource = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
    return Reflect.apply(openResource, this, [method, resolve(String(url)), async, username, password]);
  };
}

/**
 * The single portable bundle resolver and document/CSP owner. Parsing happens
 * without a DOM so native, authenticated and public consumers share the same
 * decisions. Module import maps use data URLs: opaque-origin browser tests
 * prove cycles work, while relative imports from a data/blob URL do not.
 */
export function buildArtifactHtmlDocumentV1(bundleInput: ArtifactHtmlBundleV1, options: Readonly<{
  bootstrapConfig?: PluginHostedWebBridgeBootstrapConfigV1;
  /** Host-owned browser client, executed under the same CSP before author code. */
  guestBootstrapScript?: string;
  externalHttpLinks?: boolean;
  requestedCapabilities?: UiSurfaceCapabilityRequestV1;
  networkOff?: boolean;
  /** Generated archive scripts are trusted only after the host verifies their bytes. */
  generatedArtifactNonce?: string;
  /**
   * Trusted plugin UI (owner ruling 2026-10-29): no egress ceiling. Artifact
   * HTML from agents or other people keeps the default ceiling.
   */
  pluginAuthored?: boolean;
}> = {}): string {
  const generatedNonce = options.generatedArtifactNonce;
  const egressCeiling = options.pluginAuthored !== true;
  if (generatedNonce !== undefined && !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(generatedNonce)) {
    throw new Error('Invalid generated Artifact nonce');
  }
  const bundle = (generatedNonce === undefined ? ArtifactHtmlBundleV1Schema : GeneratedArtifactHtmlBundleV1Schema).parse(bundleInput);
  // Local resource data URLs represent the verified archive. Script permission
  // is narrower: only the host bootstrap/import map and resolved archive srcs.
  const contentCsp = !egressCeiling && generatedNonce === undefined ? null : generatedNonce === undefined
    ? buildArtifactHtmlContentCspV1(options.networkOff === true ? { network: 'none' }
      : options.requestedCapabilities ?? bundle.requestedCapabilities)
    : `default-src 'none'; script-src 'nonce-${generatedNonce}'; style-src data:; img-src data:; font-src data:; media-src 'none'; connect-src data:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const text = (path: string): string => new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(bundle.files[path].contentBase64));
  // Physical names are not URL references. Escape URL metacharacters exactly
  // once while retaining the browser's spelling for ordinary path characters.
  const virtualUrl = (path: string): string => new URL(path.replace(/[%#?]/gu, character => encodeURIComponent(character)), BUNDLE_ORIGIN + '/').href;
  const resolvePath = (reference: string, from: string): string | null => {
    if (reference.startsWith('data:') || reference.startsWith('#')) return null;
    const url = new URL(reference, virtualUrl(from));
    if (url.origin !== BUNDLE_ORIGIN) return null;
    // URL normalizes dot segments. Check traversal before that normalization,
    // including encoded segments, so a reference cannot climb above the root.
    const pathname = reference.startsWith(BUNDLE_ORIGIN) ? reference.slice(BUNDLE_ORIGIN.length).split(/[?#]/u)[0] : reference.split(/[?#]/u)[0];
    const segments = pathname.startsWith('/') ? [] : from.split('/').slice(0, -1);
    for (const encoded of pathname.split('/')) {
      const part = decodeURIComponent(encoded);
      if (/[\\\u0000-\u001f\u007f]/u.test(part) || part.includes('/') || (part === '..' && segments.length === 0)) throw new Error('Unsafe HTML bundle resource path');
      if (part === '..') segments.pop();
      else if (part && part !== '.') segments.push(part);
    }
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!Object.hasOwn(bundle.files, path)) throw new Error('HTML bundle asset is missing: ' + path);
    return path;
  };
  const parsed = parseHtml(text(bundle.entrypoint));
  const elements = collectFrameElements(parsed, egressCeiling);
  const attr = (element: Element, name: string): string | undefined => element.attrs.find(value => value.name === name)?.value;
  const content = (element: Element): string => element.childNodes.filter((child): child is DefaultTreeAdapterTypes.TextNode => child.nodeName === '#text').map(child => child.value).join('');
  const setContent = (element: Element, value: string): void => { element.childNodes = []; defaultTreeAdapter.insertText(element, value); };
  const imports: Record<string, string | null> = Object.create(null);
  const scopes: Record<string, ImportMap> = Object.create(null);
  const readImports = (value: unknown): ImportMap => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid HTML import map');
    const result: Record<string, string | null> = Object.create(null);
    for (const [key, target] of Object.entries(value)) {
      if (target !== null && typeof target !== 'string') throw new Error('Invalid HTML import map target');
      result[key] = target;
    }
    return result;
  };
  for (const element of elements.filter(element => element.tagName === 'script' && attr(element, 'type')?.toLowerCase() === 'importmap')) {
    const value: unknown = JSON.parse(content(element));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid HTML import map');
    const map = value as Readonly<Record<string, unknown>>;
    if (map.imports !== undefined) Object.assign(imports, readImports(map.imports));
    if (map.scopes !== undefined) {
      if (!map.scopes || typeof map.scopes !== 'object' || Array.isArray(map.scopes)) throw new Error('Invalid HTML import map scopes');
      for (const [scope, values] of Object.entries(map.scopes)) scopes[new URL(scope, virtualUrl(bundle.entrypoint)).href] = readImports(values);
    }
    defaultTreeAdapter.detachNode(element);
  }
  const resolveModule = (reference: string, from: string): string => {
    if (!/^(?:\.{0,2}\/|[a-zA-Z][a-zA-Z\d+.-]*:)/u.test(reference)) {
      const source = virtualUrl(from);
      const scope = Object.keys(scopes).filter(key => source.startsWith(key)).sort((a, b) => b.length - a.length)[0];
      const mapping = scope === undefined ? imports : { ...imports, ...scopes[scope] };
      const key = Object.keys(mapping).filter(key => reference === key || (key.endsWith('/') && reference.startsWith(key))).sort((a, b) => b.length - a.length)[0];
      if (key === undefined || mapping[key] === null) throw new Error('Unresolved HTML bundle module: ' + reference);
      reference = mapping[key]! + reference.slice(key.length);
      from = bundle.entrypoint;
    }
    const path = resolvePath(reference, from);
    return path === null ? reference : virtualUrl(path);
  };
  const rewriteJavaScript = (code: string, from: string): string => {
    const [references] = parseModule(code);
    for (const reference of [...references].reverse()) {
      let replacement: string;
      if (reference.d === -2) replacement = `({url:${scriptJson(virtualUrl(from))}})`;
      else if (reference.n !== undefined) {
        const target = resolveModule(reference.n, from);
        replacement = reference.d === -1 ? target.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('"', '\\"') : scriptJson(target);
      } else {
        replacement = `globalThis.__HAPPIER_HTML_BUNDLE_RESOLVE_V1__(${code.slice(reference.s, reference.e)},${scriptJson(virtualUrl(from))})`;
      }
      code = code.slice(0, reference.s) + replacement + code.slice(reference.e);
    }
    return code;
  };
  const urls = new Map<string, string>();
  const resolving = new Set<string>();
  const assetUrl = (reference: string, from: string): string => {
    const path = resolvePath(reference, from);
    if (path === null) return reference;
    const suffix = new URL(reference, virtualUrl(from)).hash;
    const asset = bundle.files[path];
    const mime = asset.mime.toLowerCase();
    // Chromium ignores the import back to an ancestor, preserving the rest of
    // each stylesheet. An empty local stylesheet represents that ignored edge.
    if (resolving.has(path)) return `data:${asset.mime};base64,${suffix}`;
    // Imported CSS depends on its current ancestry: a.css -> b.css must not
    // cache b.css without a.css for a later independent b.css entrypoint.
    const nestedStylesheet = mime === 'text/css' && resolving.size > 0;
    const existing = urls.get(path);
    if (existing !== undefined && !nestedStylesheet) return existing + suffix;
    resolving.add(path);
    const bytes = mime === 'text/css' ? encodeBase64(new TextEncoder().encode(rewriteCss(text(path), path)))
      : JAVASCRIPT_MIMES.has(mime) ? encodeBase64(new TextEncoder().encode(rewriteJavaScript(text(path), path))) : asset.contentBase64;
    const result = `data:${asset.mime};base64,${bytes}`;
    resolving.delete(path);
    if (!nestedStylesheet) urls.set(path, result);
    return result + suffix;
  };
  const rewriteCss = (css: string, from: string): string => css
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/giu,
      (_match, double: string | undefined, single: string | undefined, bare: string | undefined) => `url("${assetUrl(double ?? single ?? bare ?? '', from)}")`)
    .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/giu,
      (_match, double: string | undefined, single: string | undefined) => `@import url("${assetUrl(double ?? single ?? '', from)}")`);
  // Materialize all files once for runtime resource reads as well as static
  // references. Module identities are virtual URLs; maps preserve cycles.
  for (const path of Object.keys(bundle.files)) assetUrl(virtualUrl(path), bundle.entrypoint);
  for (const element of elements) {
    let scriptNonce: string | undefined;
    if (generatedNonce !== undefined) {
      // Authored markup cannot supply execution authority, even if it happens
      // to contain this mount's nonce. Determine provenance before rewriting.
      element.attrs = element.attrs.filter(attribute => attribute.name !== 'nonce');
      // SVG scripts do not use HTML's src attribute, and data: classic scripts
      // lack the server response's nosniff boundary. Preserve both decisions.
      const source = element.tagName === 'script' && element.namespaceURI === 'http://www.w3.org/1999/xhtml'
        ? attr(element, 'src') : undefined;
      const path = source === undefined ? null : resolvePath(source, bundle.entrypoint);
      if (path !== null && JAVASCRIPT_MIMES.has(bundle.files[path].mime.toLowerCase())) scriptNonce = generatedNonce;
    }
    for (const attribute of element.attrs) {
      if (['src', 'poster', 'background'].includes(attribute.name)
        || (attribute.name === 'href' && ['link', 'use', 'image'].includes(element.tagName))) attribute.value = assetUrl(attribute.value, bundle.entrypoint);
      if (attribute.name === 'srcset') attribute.value = attribute.value.split(',').map(part => {
        const [path, ...descriptor] = part.trim().split(/\s+/u);
        return [assetUrl(path, bundle.entrypoint), ...descriptor].join(' ');
      }).join(', ');
      if (attribute.name === 'style') attribute.value = rewriteCss(attribute.value, bundle.entrypoint);
    }
    if (scriptNonce !== undefined) element.attrs.push({ name: 'nonce', value: scriptNonce });
    if (element.tagName === 'style') setContent(element, rewriteCss(content(element), bundle.entrypoint));
    if (element.tagName === 'script' && !attr(element, 'src') && (!attr(element, 'type') || attr(element, 'type')?.toLowerCase() === 'module')) {
      setContent(element, rewriteJavaScript(content(element), bundle.entrypoint).replace(/<\/script/giu, '<\\/script'));
    }
  }
  const html = parsed.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'html')!;
  const head = html.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'head')!;
  // Nonces authorize script requests regardless of their URL, including module
  // descendants. Intersect with the existing no-network policy: its inline
  // allowance cannot bypass the first policy's nonce requirement, while its
  // data-only script source cannot be bypassed by copying the mount nonce.
  const generatedUrlCeiling = generatedNonce === undefined ? ''
    : `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_CONTENT_CSP_V1}">`;
  // The page may follow the viewer's light or dark theme: one that styles `prefers-color-scheme` does, one that sets its
  // own colours keeps them, and the browser's default ink and controls match the theme. An author's own choice stands.
  const authoredColorScheme = head.childNodes.some(node => 'tagName' in node && node.tagName === 'meta'
    && attr(node, 'name')?.toLowerCase() === 'color-scheme');
  const colorScheme = authoredColorScheme ? '' : '<meta name="color-scheme" content="light dark">';
  const contentPolicy = contentCsp === null ? '' : `<meta http-equiv="Content-Security-Policy" content="${contentCsp}">`;
  const prefix = parseHtml(`${contentPolicy}${generatedUrlCeiling}${colorScheme}<script></script><script type="importmap"></script>`);
  const prefixHtml = prefix.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'html')!;
  const prefixHead = prefixHtml.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'head')!;
  const scripts = prefixHead.childNodes.filter((node): node is Element => 'tagName' in node && node.tagName === 'script');
  const bootstrap = scripts[0]!;
  const importMap = scripts[1]!;
  if (generatedNonce !== undefined) {
    bootstrap.attrs.push({ name: 'nonce', value: generatedNonce });
    importMap.attrs.push({ name: 'nonce', value: generatedNonce });
  }
  const urlMap = Object.fromEntries([...urls].map(([path, url]) => [virtualUrl(path), url]));
  const config = options.bootstrapConfig === undefined ? '' : `Object.defineProperty(globalThis,"__HAPPIER_UI_FRAME_BOOTSTRAP_V1__",{value:Object.freeze(${scriptJson(options.bootstrapConfig)}),writable:false,configurable:false});`;
  const links = options.externalHttpLinks === true ? 'Object.defineProperty(globalThis,"__HAPPIER_UI_FRAME_EXTERNAL_LINKS_V1__",{value:true,writable:false,configurable:false});' : '';
  const guest = options.guestBootstrapScript?.replace(/<\/script/giu, '<\\/script') ?? '';
  setContent(bootstrap, `${config}${links}${artifactHtmlFrameAdmissionScriptV1(egressCeiling)}(${installBundleResources.toString()})(${scriptJson(urlMap)},${scriptJson(virtualUrl(bundle.entrypoint))});${guest}`);
  setContent(importMap, scriptJson({ imports: urlMap }));
  for (const node of [...prefixHead.childNodes].reverse()) {
    defaultTreeAdapter.detachNode(node);
    if (head.childNodes[0]) defaultTreeAdapter.insertBefore(head, node, head.childNodes[0]);
    else defaultTreeAdapter.appendChild(head, node);
  }
  return parsed.childNodes.some(node => node.nodeName === '#documentType')
    ? serialize(parsed)
    : '<!doctype html>\n' + serialize(parsed);
}
