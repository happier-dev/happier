// Native bindings are used only by the serialized guest; host compilers need no DOM globals.
type NativeDomPrototype = Readonly<{ prototype: object }>;
declare const Node: NativeDomPrototype;
declare const Element: NativeDomPrototype;
declare const HTMLTemplateElement: NativeDomPrototype;
declare const Document: NativeDomPrototype;
declare const Range: NativeDomPrototype;
declare const DocumentFragment: NativeDomPrototype;
declare const CharacterData: NativeDomPrototype;
declare const DocumentType: NativeDomPrototype;
declare const ShadowRoot: NativeDomPrototype;
declare const NodeList: Readonly<{ prototype: { item(index: number): unknown } }>;
declare const DOMParser: {
  new(): object;
  readonly prototype: { parseFromString(html: string, mimeType: string): unknown };
};
declare const HTMLLinkElement: NativeDomPrototype;
declare const Attr: NativeDomPrototype;
declare const DOMTokenList: NativeDomPrototype;
declare const NamedNodeMap: NativeDomPrototype;
declare const XMLHttpRequest: NativeDomPrototype;
declare const CustomElementRegistry: NativeDomPrototype;
declare const DOMImplementation: NativeDomPrototype;

/**
 * Link hints that resolve or connect to a host without a CSP-governed fetch.
 * CSP does not refuse them or about:srcdoc, so DOM admission refuses them.
 */
export function isArtifactHtmlNetworkHintRelV1(value: string,
  match: typeof RegExp.prototype.exec = RegExp.prototype.exec,
  apply: typeof Reflect.apply = Reflect.apply): boolean {
  return apply(match, /(?:^|[\t\n\f\r ])(?:dns-prefetch|preconnect)(?:$|[\t\n\f\r ])/iu, [value]) !== null;
}

function installFrameAdmission(hasNetworkHintRel: typeof isArtifactHtmlNetworkHintRelV1, egressCeiling: boolean): void {
  // Fetch CSP does not govern ICE. Retain no callable native entry point.
  if (egressCeiling) for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
  }
  // Capture native DOM operations before authored code can replace globals or
  // detach a node's JavaScript prototype without changing its browser brand.
  const NativeNode = Node;
  const NativeElement = Element;
  const NativeTemplate = HTMLTemplateElement;
  const NativeParser = DOMParser;
  const NativeException = DOMException;
  const NativeTypeError = TypeError;
  const string = String;
  const domString = (value: unknown): string => {
    if (typeof value === 'symbol') throw new NativeTypeError('Cannot convert a Symbol value to a string');
    return string(value);
  };
  const apply = Reflect.apply;
  const hasInstance = Function.prototype[Symbol.hasInstance];
  const readType = Object.getOwnPropertyDescriptor(NativeNode.prototype, 'nodeType')!.get!;
  const isNode = (value: unknown): boolean => {
    try { apply(readType, value, []); return true; }
    catch (error) {
      if (apply(hasInstance, NativeTypeError, [error])) return false;
      throw error;
    }
  };
  const readChildren = Object.getOwnPropertyDescriptor(NativeNode.prototype, 'childNodes')!.get!;
  const readName = Object.getOwnPropertyDescriptor(NativeElement.prototype, 'localName')!.get!;
  const readTemplate = Object.getOwnPropertyDescriptor(NativeTemplate.prototype, 'content')!.get!;
  const readLength = Object.getOwnPropertyDescriptor(NodeList.prototype, 'length')!.get!;
  const readItem = NodeList.prototype.item;
  const forbidden = new Set(['iframe', 'frame', 'frameset', 'object', 'embed']);
  const isForbidden = forbidden.has.bind(forbidden);
  const refuse = (): never => { throw new NativeException('Nested browsing contexts are unavailable', 'SecurityError'); };
  const assertNode = (node: unknown): void => {
    const isElement = apply(readType, node, []) === 1;
    const name = isElement ? apply(readName, node, []) : null;
    if (isElement && isForbidden(name)) refuse();
    if (egressCeiling && name === 'link' && isLink(node)) assertRel(apply(readRel, node, []));
    const children: unknown = apply(readChildren, node, []);
    for (let index = 0; index < apply(readLength, children, []); index++) {
      const child = apply(readItem, children, [index]);
      if (child !== null) assertNode(child);
    }
    if (name === 'template') {
      let content: unknown;
      try { content = apply(readTemplate, node, []); }
      catch (error) {
        // A non-HTML element named template has no native template content.
        if (apply(hasInstance, NativeTypeError, [error])) return;
        throw error;
      }
      assertNode(content);
    }
  };
  // Manual DNS/connection hints ignore both fetch CSP and DNS-prefetch opt-out.
  // Check links synchronously, including mutations after insertion and native
  // Attr / token-list APIs. Capture the intrinsic matcher before authored code runs.
  const readRel = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'rel')!.get!;
  const readRelList = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'relList')!.get!;
  const readAttrName = Object.getOwnPropertyDescriptor(Attr.prototype, 'name')!.get!;
  const readAttrValue = Object.getOwnPropertyDescriptor(Attr.prototype, 'value')!.get!;
  const readAttrOwner = Object.getOwnPropertyDescriptor(Attr.prototype, 'ownerElement')!.get!;
  const readAttributes = Object.getOwnPropertyDescriptor(NativeElement.prototype, 'attributes')!.get!;
  const lower = String.prototype.toLowerCase;
  const match = RegExp.prototype.exec;
  const isLink = (value: unknown): boolean => {
    try {
      // Ordinary DOM writes must not allocate a caught brand exception.
      if (apply(readName, value, []) !== 'link') return false;
      apply(readRel, value, []);
      return true;
    }
    catch (error) {
      if (apply(hasInstance, NativeTypeError, [error])) return false;
      throw error;
    }
  };
  const assertRel = (value: unknown): string => {
    const text = domString(value);
    if (hasNetworkHintRel(text, match, apply)) throw new NativeException('Network hints are unavailable', 'SecurityError');
    return text;
  };
  const isRel = (value: unknown): boolean => apply(lower, domString(value), []) === 'rel';
  const assertAttr = (target: unknown, attribute: unknown): void => {
    if (isLink(target) && isRel(apply(readAttrName, attribute, []))) assertRel(apply(readAttrValue, attribute, []));
  };
  const parse = NativeParser.prototype.parseFromString;
  const assertHtml = (value: unknown): string => {
    const html = domString(value);
    assertNode(apply(parse, new NativeParser(), [html, 'text/html']));
    return html;
  };
  // Refused elements never exist in this realm: every markup-to-node producer
  // is admitted before guest code receives its nodes. Insertion routes that no
  // method patch reaches (body/table/option setters, ranges, editing commands)
  // then have nothing refused to connect, and no nested realm can regain RTC.
  const readResponseType = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseType')!.get!;
  const admitResult = (owner: object, name: string, when?: (receiver: unknown) => boolean): void => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    const native: unknown = descriptor?.get ?? descriptor?.value;
    if (!descriptor || typeof native !== 'function') return;
    const admit = function(this: unknown, ...args: unknown[]): unknown {
      const result: unknown = apply(native as (...values: unknown[]) => unknown, this, args);
      if (result !== null && typeof result === 'object' && (when === undefined || when(this)) && isNode(result)) assertNode(result);
      return result;
    };
    Object.defineProperty(owner, name, descriptor.get
      ? { ...descriptor, configurable: false, get: admit }
      : { ...descriptor, configurable: false, writable: false, value: admit });
  };
  if (egressCeiling) {
    admitResult(NativeParser.prototype, 'parseFromString');
    admitResult(Range.prototype, 'createContextualFragment');
    admitResult(XMLHttpRequest.prototype, 'responseXML');
    admitResult(XMLHttpRequest.prototype, 'response', receiver => apply(readResponseType, receiver, []) === 'document');
    const xslt = (globalThis as { XSLTProcessor?: NativeDomPrototype }).XSLTProcessor;
    if (xslt) for (const name of ['transformToFragment', 'transformToDocument']) admitResult(xslt.prototype, name);
  }
  // Lock the captured admission methods before authored code can obtain the
  // native variants. This is guest-local DOM policy, not a host bridge.
  const patch = (owner: object, name: string, guard: (args: unknown[], receiver: unknown) => void): void => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (typeof descriptor?.value !== 'function') return;
    const original: (...args: unknown[]) => unknown = descriptor.value;
    Object.defineProperty(owner, name, {
      ...descriptor, configurable: false, writable: false,
      value: function(this: unknown, ...args: unknown[]) {
        guard(args, this);
        return apply(original, this, args);
      },
    });
  };

  // Link hints: only the egress ceiling refuses them.
  if (egressCeiling) {
    const lists = new WeakSet<object>();
    const hasList = lists.has.bind(lists);
    const addList = lists.add.bind(lists);
    const maps = new WeakMap<object, unknown>();
    const readMap = maps.get.bind(maps);
    const addMap = maps.set.bind(maps);
    const relListDescriptor = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'relList')!;
    Object.defineProperty(HTMLLinkElement.prototype, 'relList', {
      ...relListDescriptor, configurable: false,
      get(this: object) { const list: object = apply(readRelList, this, []); addList(list); return list; },
      ...(relListDescriptor.set ? { set(this: unknown, value: unknown) { apply(relListDescriptor.set!, this, [assertRel(value)]); } } : {}),
    });
    const attributesDescriptor = Object.getOwnPropertyDescriptor(NativeElement.prototype, 'attributes')!;
    Object.defineProperty(NativeElement.prototype, 'attributes', {
      ...attributesDescriptor, configurable: false,
      get(this: object) { const attributes: object = apply(readAttributes, this, []); addMap(attributes, this); return attributes; },
    });
    const relDescriptor = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'rel')!;
    const setRel = relDescriptor.set!;
    Object.defineProperty(HTMLLinkElement.prototype, 'rel', {
      ...relDescriptor, configurable: false,
      set(this: unknown, value: unknown) { apply(setRel, this, [assertRel(value)]); },
    });
    patch(NativeElement.prototype, 'setAttribute', (args, target) => {
      if (args.length >= 2 && isLink(target)) {
        args[0] = domString(args[0]);
        if (isRel(args[0])) args[1] = assertRel(args[1]);
      }
    });
    patch(NativeElement.prototype, 'setAttributeNS', (args, target) => {
      if (args.length >= 3 && isLink(target)) {
        args[1] = domString(args[1]);
        if (isRel(args[1])) args[2] = assertRel(args[2]);
      }
    });
    for (const name of ['setAttributeNode', 'setAttributeNodeNS']) {
      patch(NativeElement.prototype, name, (args, target) => { if (args.length > 0) assertAttr(target, args[0]); });
    }
    for (const name of ['setNamedItem', 'setNamedItemNS']) {
      patch(NamedNodeMap.prototype, name, (args, map) => {
        if (args.length > 0 && typeof map === 'object' && map !== null) assertAttr(readMap(map), args[0]);
      });
    }
    for (const name of ['add', 'toggle', 'replace']) {
      patch(DOMTokenList.prototype, name, (args, list) => {
        if (typeof list !== 'object' || list === null || !hasList(list)) return;
        const start = name === 'replace' ? 1 : 0;
        const end = name === 'add' ? args.length : (args.length > start ? start + 1 : args.length);
        for (let index = start; index < end; index++) args[index] = assertRel(args[index]);
      });
    }
    const tokenDescriptor = Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'value')!;
    const setTokenValue = tokenDescriptor.set!;
    Object.defineProperty(DOMTokenList.prototype, 'value', {
      ...tokenDescriptor, configurable: false,
      set(this: object, value: unknown) { apply(setTokenValue, this, [hasList(this) ? assertRel(value) : value]); },
    });
    for (const [owner, name] of [[Attr.prototype, 'value'], [NativeNode.prototype, 'nodeValue'], [NativeNode.prototype, 'textContent']] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)!;
      const set = descriptor.set!;
      Object.defineProperty(owner, name, {
        ...descriptor, configurable: false,
        set(this: unknown, value: unknown) {
          let next = value;
          if (isNode(this) && apply(readType, this, []) === 2) {
            const target: unknown = apply(readAttrOwner, this, []);
            if (isLink(target) && isRel(apply(readAttrName, this, []))) {
              next = assertRel(name !== 'value' && value === null ? '' : value);
            }
          }
          apply(set, this, [next]);
        },
      });
    }
  }

  const assertInputs = (args: unknown[]): void => {
    for (let index = 0; index < args.length; index++) {
      const value = args[index];
      if (isNode(value)) assertNode(value);
    }
  };
  // Captured intrinsics: authored code may replace String/Array methods.
  const admitElementName = (value: unknown): string => {
    const name = domString(value);
    if (isForbidden(apply(lower, apply(match, /[^:]*$/u, [name])![0], []))) refuse();
    return name;
  };
  for (const [name, index] of [['createElement', 0], ['createElementNS', 1]] as const) {
    patch(Document.prototype, name, args => {
      if (args.length <= index) return;
      args[index] = admitElementName(args[index]);
    });
  }
  // Customized built-ins and XML document elements are constructed natively.
  if (egressCeiling) {
    patch(CustomElementRegistry.prototype, 'define', args => {
      const options = args[2];
      if (options === null || (typeof options !== 'object' && typeof options !== 'function')) return;
      const base: unknown = (options as { extends?: unknown }).extends;
      args[2] = base === undefined ? {} : { extends: admitElementName(base) };
    });
    patch(DOMImplementation.prototype, 'createDocument', args => {
      if (args.length > 1 && args[1] !== null) args[1] = admitElementName(args[1]);
    });
    patch(Document.prototype, 'execCommand', args => {
      if (args.length > 0) args[0] = domString(args[0]);
      if (args.length > 2 && apply(lower, args[0], []) === 'inserthtml') args[2] = assertHtml(args[2]);
    });
  }
  for (const name of ['appendChild', 'insertBefore', 'replaceChild']) patch(Node.prototype, name, args => assertInputs([args[0]]));
  patch(Range.prototype, 'insertNode', assertInputs);
  for (const owner of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
    for (const name of ['append', 'prepend', 'replaceChildren']) patch(owner, name, assertInputs);
  }
  for (const owner of [Element.prototype, CharacterData.prototype, DocumentType.prototype]) {
    for (const name of ['before', 'after', 'replaceWith']) patch(owner, name, assertInputs);
  }
  patch(Element.prototype, 'insertAdjacentElement', args => assertInputs([args[1]]));
  for (const [owner, name] of [[Element.prototype, 'innerHTML'], [Element.prototype, 'outerHTML'], [ShadowRoot.prototype, 'innerHTML']] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (!descriptor?.set) continue;
    const set = descriptor.set;
    Object.defineProperty(owner, name, {
      ...descriptor, configurable: false,
      set(this: unknown, value: unknown) { apply(set, this, [assertHtml(value === null ? '' : value)]); },
    });
  }
  patch(Element.prototype, 'insertAdjacentHTML', args => { if (args.length > 1) args[1] = assertHtml(args[1]); });
  for (const owner of [Element.prototype, ShadowRoot.prototype]) {
    for (const name of ['setHTML', 'setHTMLUnsafe']) patch(owner, name, args => { if (args.length > 0) args[0] = assertHtml(args[0]); });
  }
  // Declarative closed shadow roots disappear from childNodes after parsing.
  // Check their inert template markup before that native transformation.
  for (const name of ['parseHTML', 'parseHTMLUnsafe']) patch(Document, name, args => { if (args.length > 0) args[0] = assertHtml(args[0]); });
  // Parser-stream writes need the accumulated prefix to catch split tags.
  let written = '';
  for (const name of ['write', 'writeln']) patch(Document.prototype, name, args => {
    let next = written;
    for (let index = 0; index < args.length; index++) {
      args[index] = domString(args[index]);
      next += args[index];
    }
    assertHtml(next);
    written = next;
  });
  patch(Document.prototype, 'open', () => { written = ''; });
}


/**
 * Guest DOM admission for untrusted srcdoc frames. The egress ceiling (no RTC,
 * no DNS/preconnect hints, and every nested-frame producer) applies to Artifact HTML from agents or other people,
 * not to trusted plugin-authored pages (owner ruling 2026-10-29).
 */
export function artifactHtmlFrameAdmissionScriptV1(egressCeiling: boolean): string {
  if (!egressCeiling) return '';
  return `(${installFrameAdmission.toString()})(${isArtifactHtmlNetworkHintRelV1.toString()},${egressCeiling});`;
}
