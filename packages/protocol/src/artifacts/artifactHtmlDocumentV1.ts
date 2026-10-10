import { parse as parseHtml, serialize, defaultTreeAdapter, type DefaultTreeAdapterTypes } from 'parse5';
import { parse as parseModule } from 'es-module-lexer/js';

import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { ArtifactHtmlBundleV1Schema, type ArtifactHtmlBundleV1 } from './artifactHtmlV1.js';
import type { PluginHostedWebBridgeBootstrapConfigV1 } from '../plugins/ui/hostedWebBridge.js';

export const ARTIFACT_HTML_SANDBOX_V1 = 'allow-scripts';
/** Native top-level documents need a response header; meta cannot sandbox. */
export const ARTIFACT_HTML_RESPONSE_SANDBOX_CSP_V1 = `sandbox ${ARTIFACT_HTML_SANDBOX_V1}`;
// data: connects only to opened bundle bytes. No HTTP, host-origin, worker or
// nested-frame permission is needed to execute modules or read local resources.
export const ARTIFACT_HTML_CONTENT_CSP_V1 = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; connect-src data:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const BUNDLE_ORIGIN = 'https://happier-bundle.invalid';
const JAVASCRIPT_MIMES = new Set(['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript']);
type Element = DefaultTreeAdapterTypes.Element;
type ImportMap = Readonly<Record<string, string | null>>;

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

/** CSP does not refuse about:srcdoc. Admit DOM writes synchronously instead. */
function installFrameAdmission(): void {
  // Capture browser constructors before authored code can replace globals and
  // change the node checks used by the synchronous insertion guards.
  const NativeNode = Node;
  const NativeElement = Element;
  const NativeTemplate = HTMLTemplateElement;
  const NativeParser = DOMParser;
  const NativeException = DOMException;
  const apply = Reflect.apply;
  const readChildren = Object.getOwnPropertyDescriptor(NativeNode.prototype, 'childNodes')!.get!;
  const readName = Object.getOwnPropertyDescriptor(NativeElement.prototype, 'localName')!.get!;
  const readTemplate = Object.getOwnPropertyDescriptor(NativeTemplate.prototype, 'content')!.get!;
  const forbidden = new Set(['iframe', 'frame', 'frameset', 'object', 'embed']);
  const isForbidden = forbidden.has.bind(forbidden);
  const refuse = (): never => { throw new NativeException('Nested browsing contexts are unavailable', 'SecurityError'); };
  const assertNode = (node: Node): void => {
    if (node instanceof NativeElement && isForbidden(apply(readName, node, []))) refuse();
    const children: NodeListOf<ChildNode> = apply(readChildren, node, []);
    for (const child of children) assertNode(child);
    if (node instanceof NativeTemplate) assertNode(apply(readTemplate, node, []));
  };
  const parse = NativeParser.prototype.parseFromString;
  const assertHtml = (value: unknown): void => {
    assertNode(apply(parse, new NativeParser(), [String(value), 'text/html']));
  };
  // Lock the captured admission methods before authored code can obtain the
  // native variants. This is guest-local DOM policy, not a host bridge.
  const patch = (owner: object, name: string, guard: (args: unknown[]) => void): void => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (typeof descriptor?.value !== 'function') return;
    const original: (...args: unknown[]) => unknown = descriptor.value;
    Object.defineProperty(owner, name, {
      ...descriptor, configurable: false, writable: false,
      value: function(this: unknown, ...args: unknown[]) {
        guard(args);
        return apply(original, this, args);
      },
    });
  };
  const assertInputs = (args: unknown[]): void => {
    for (const value of args) if (value instanceof NativeNode) assertNode(value);
  };
  for (const [name, index] of [['createElement', 0], ['createElementNS', 1]] as const) {
    patch(Document.prototype, name, args => {
      if (isForbidden(String(args[index]).split(':').at(-1)!.toLowerCase())) refuse();
    });
  }
  for (const name of ['appendChild', 'insertBefore', 'replaceChild']) patch(Node.prototype, name, args => assertInputs(args.slice(0, 1)));
  patch(Range.prototype, 'insertNode', assertInputs);
  for (const owner of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
    for (const name of ['append', 'prepend', 'replaceChildren']) patch(owner, name, assertInputs);
  }
  for (const owner of [Element.prototype, CharacterData.prototype, DocumentType.prototype]) {
    for (const name of ['before', 'after', 'replaceWith']) patch(owner, name, assertInputs);
  }
  patch(Element.prototype, 'insertAdjacentElement', args => assertInputs(args.slice(1)));
  for (const [owner, name] of [[Element.prototype, 'innerHTML'], [Element.prototype, 'outerHTML'], [ShadowRoot.prototype, 'innerHTML']] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (!descriptor?.set) continue;
    const set = descriptor.set;
    Object.defineProperty(owner, name, {
      ...descriptor, configurable: false,
      set(this: unknown, value: unknown) { assertHtml(value); apply(set, this, [value]); },
    });
  }
  patch(Element.prototype, 'insertAdjacentHTML', args => assertHtml(args[1]));
  for (const owner of [Element.prototype, ShadowRoot.prototype]) {
    for (const name of ['setHTML', 'setHTMLUnsafe']) patch(owner, name, args => assertHtml(args[0]));
  }
  // Declarative closed shadow roots disappear from childNodes after parsing.
  // Check their inert template markup before that native transformation.
  for (const name of ['parseHTML', 'parseHTMLUnsafe']) patch(Document, name, args => assertHtml(args[0]));
  // Fragments/documents remain usable; actual insertion is checked above.
  // Parser-stream writes need the accumulated prefix to catch split tags.
  let written = '';
  for (const name of ['write', 'writeln']) patch(Document.prototype, name, args => {
    const next = written + args.map(String).join('');
    assertHtml(next);
    written = next;
  });
  patch(Document.prototype, 'open', () => { written = ''; });
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
  externalHttpLinks?: boolean;
}> = {}): string {
  const bundle = ArtifactHtmlBundleV1Schema.parse(bundleInput);
  const text = (path: string): string => new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(bundle.files[path].contentBase64));
  const virtualUrl = (path: string): string => new URL(path, BUNDLE_ORIGIN + '/').href;
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
  const elements: Element[] = [];
  const collect = (node: DefaultTreeAdapterTypes.ParentNode): void => {
    for (const child of [...node.childNodes]) {
      if (!('tagName' in child)) continue;
      if (['base', 'iframe', 'frame', 'frameset', 'object', 'embed'].includes(child.tagName)
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
    for (const attribute of element.attrs) {
      if (['src', 'poster', 'background'].includes(attribute.name)
        || (attribute.name === 'href' && ['link', 'use', 'image'].includes(element.tagName))) attribute.value = assetUrl(attribute.value, bundle.entrypoint);
      if (attribute.name === 'srcset') attribute.value = attribute.value.split(',').map(part => {
        const [path, ...descriptor] = part.trim().split(/\s+/u);
        return [assetUrl(path, bundle.entrypoint), ...descriptor].join(' ');
      }).join(', ');
      if (attribute.name === 'style') attribute.value = rewriteCss(attribute.value, bundle.entrypoint);
    }
    if (element.tagName === 'style') setContent(element, rewriteCss(content(element), bundle.entrypoint));
    if (element.tagName === 'script' && !attr(element, 'src') && (!attr(element, 'type') || attr(element, 'type')?.toLowerCase() === 'module')) {
      setContent(element, rewriteJavaScript(content(element), bundle.entrypoint).replace(/<\/script/giu, '<\\/script'));
    }
  }
  const html = parsed.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'html')!;
  const head = html.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'head')!;
  const prefix = parseHtml(`<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_CONTENT_CSP_V1}"><script></script><script type="importmap"></script>`);
  const prefixHtml = prefix.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'html')!;
  const prefixHead = prefixHtml.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'head')!;
  const bootstrap = prefixHead.childNodes[1] as Element;
  const urlMap = Object.fromEntries([...urls].map(([path, url]) => [virtualUrl(path), url]));
  const config = options.bootstrapConfig === undefined ? '' : `Object.defineProperty(globalThis,"__HAPPIER_UI_FRAME_BOOTSTRAP_V1__",{value:Object.freeze(${scriptJson(options.bootstrapConfig)}),writable:false,configurable:false});`;
  const links = options.externalHttpLinks === true ? 'Object.defineProperty(globalThis,"__HAPPIER_UI_FRAME_EXTERNAL_LINKS_V1__",{value:true,writable:false,configurable:false});' : '';
  setContent(bootstrap, `${config}${links}(${installFrameAdmission.toString()})();(${installBundleResources.toString()})(${scriptJson(urlMap)},${scriptJson(virtualUrl(bundle.entrypoint))});`);
  setContent(prefixHead.childNodes[2] as Element, scriptJson({ imports: urlMap }));
  for (const node of [...prefixHead.childNodes].reverse()) {
    defaultTreeAdapter.detachNode(node);
    if (head.childNodes[0]) defaultTreeAdapter.insertBefore(head, node, head.childNodes[0]);
    else defaultTreeAdapter.appendChild(head, node);
  }
  return parsed.childNodes.some(node => node.nodeName === '#documentType')
    ? serialize(parsed)
    : '<!doctype html>\n' + serialize(parsed);
}
