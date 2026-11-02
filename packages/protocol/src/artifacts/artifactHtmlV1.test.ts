import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../crypto/base64.js';
import { ARTIFACT_HTML_BUNDLE_MIME_V1, ArtifactHtmlBundleV1Schema, GeneratedArtifactHtmlBundleV1Schema, artifactHtmlBundleFromBodyV1,
  isArtifactHtmlHeaderV1, ArtifactHtmlPreviewResponseV1Schema } from './artifactHtmlV1.js';
import { buildArtifactHtmlContentCspV1, buildArtifactHtmlDocumentV1 } from './artifactHtmlDocumentV1.js';
import { readArtifactPublicNetworkPolicyV1 } from './artifactPublicNetworkPolicyV1.js';
import { isPortableRelativePath } from '../filesystem/portablePathSegment.js';

const bundle = { v: 1 as const, entrypoint: 'index.html', files: { 'index.html': {
  mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode('<h1>Hello</h1>')),
} } };
describe('Artifact HTML bundle V1', () => {
  it('keeps the egress ceiling on Artifact HTML and leaves trusted plugin UI its link hints and RTC', () => {
    // Owner ruling 2026-10-29: plugins are trusted; the ceiling protects users
    // from HTML by agents or other people, which is the default.
    const bundle = artifactHtmlBundleFromBodyV1('<link rel="dns-prefetch" href="https://hint.example.test/"><iframe src="about:blank"></iframe><p>Body</p>');
    const artifact = buildArtifactHtmlDocumentV1(bundle);
    const plugin = buildArtifactHtmlDocumentV1(bundle, { pluginAuthored: true });
    expect(artifact).not.toContain('hint.example.test');
    expect(artifact).toMatch(/RTCPeerConnection[\s\S]*\},true\);/u);
    expect(plugin).toContain('<link rel="dns-prefetch" href="https://hint.example.test/">');
    expect(artifact).not.toContain('<iframe');
    expect(plugin).toContain('<iframe src="about:blank"></iframe>');
    expect(plugin).not.toContain('Nested browsing contexts are unavailable');
    expect(plugin).not.toContain('Content-Security-Policy');
    expect(artifact).toContain('Content-Security-Policy');
  });

  it('keeps generated prototype-looking directories ordinary without changing prototypes or admitting inherited files', () => {
    const path = 'constructor/prototype/__proto__/asset#%.json';
    const input = { ...bundle, files: { ...bundle.files, [path]: { mime: 'application/json', contentBase64: 'e30=' } } };
    const parsed = GeneratedArtifactHtmlBundleV1Schema.parse(input);
    expect(Object.hasOwn(parsed.files, path)).toBe(true);
    expect(Object.getPrototypeOf(parsed.files)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'mime')).toBe(false);
    const unsafe: unknown = JSON.parse(JSON.stringify(input).replace('"files":{', '"files":{"__proto__":{"mime":"application/json","contentBase64":"e30="},'));
    const opened = GeneratedArtifactHtmlBundleV1Schema.parse(unsafe);
    expect(Object.hasOwn(opened.files, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(opened.files)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'mime')).toBe(false);
    const inherited = Object.assign(Object.create({ [path]: input.files[path] }), bundle.files);
    expect(Object.hasOwn(GeneratedArtifactHtmlBundleV1Schema.parse({ ...bundle, files: inherited }).files, path)).toBe(false);
  });
  it('rejects traversal and encoded separators through the generated resolver as well as unsafe physical paths', () => {
    for (const path of ['../index.html', '/index.html', 'a\\index.html', 'a//index.html', 'a/./index.html', 'https:x', 'a\u0000x']) {
      expect(GeneratedArtifactHtmlBundleV1Schema.safeParse({ ...bundle, entrypoint: path, files: { [path]: bundle.files['index.html'] } }).success).toBe(false);
    }
    for (const source of ['../index.html', '%2e%2e/index.html', 'a%2findex.html', 'a%5cindex.html']) {
      expect(() => buildArtifactHtmlDocumentV1(artifactHtmlBundleFromBodyV1(`<script src="${source}"></script>`), { generatedArtifactNonce: 'mount-nonce' })).toThrow();
    }
  });
  it('opens producer-portable generated filenames without widening caller HTML paths or aliasing encoded names', () => {
    const input = artifactHtmlBundleFromBodyV1('<script type="module" src="constructor/main%23%25.js"></script>'
      + '<link rel="stylesheet" href="constructor/style%23%25.css">');
    const file = (mime: string, text: string) => ({ mime, contentBase64: encodeBase64(new TextEncoder().encode(text)) });
    input.files['constructor/main#%.js'] = file('text/javascript', 'import "./child%23%25.js"; import("./%252e%252e/dynamic%23%25.js"); fetch("./@data%23%25.json")');
    input.files['constructor/child#%.js'] = file('text/javascript', 'export const value = 42');
    input.files['constructor/%2e%2e/dynamic#%.js'] = file('text/javascript', 'export const value = 84');
    input.files['constructor/@data#%.json'] = file('application/json', '{"value":42}');
    input.files['constructor/style#%.css'] = file('text/css', '@import "./nested%23%25.css";');
    input.files['constructor/nested#%.css'] = file('text/css', 'body { color: red }');
    input.files['unused#%.txt'] = file('text/plain', 'A declared unused producer asset must remain valid');
    expect(Object.keys(input.files).every(isPortableRelativePath)).toBe(true);
    expect(ArtifactHtmlBundleV1Schema.safeParse(input).success).toBe(false);
    const html = buildArtifactHtmlDocumentV1(input, { generatedArtifactNonce: 'mount-nonce' });
    expect(html).toContain('https://happier-bundle.invalid/constructor/main%23%25.js');
    expect(html).toContain('https://happier-bundle.invalid/constructor/%252e%252e/dynamic%23%25.js');
    expect(html).toContain('https://happier-bundle.invalid/constructor/@data%23%25.json');
    expect(html).toContain('https://happier-bundle.invalid/unused%23%25.txt');
  });
  it('rejects a generated nonce that could be empty or alter the CSP grammar', () => {
    for (const generatedArtifactNonce of ['', "nonce'; script-src *", 'nonce" data-x="injected', 'two nonces']) {
      expect(() => buildArtifactHtmlDocumentV1(bundle, { generatedArtifactNonce })).toThrow();
    }
  });
  it('authorizes only verified archive scripts and host bootstrap in the generated nonce profile', () => {
    const input = artifactHtmlBundleFromBodyV1('<script src="main.js" nonce="authored"></script>'
      + '<script nonce="mount-nonce">globalThis.injected = true</script>'
      + '<script src="data:text/javascript,globalThis.injected=true" nonce="mount-nonce"></script>'
      + '<script src="https://attacker.example/attack.js" nonce="mount-nonce"></script>'
      + '<script src="payload.json" nonce="mount-nonce"></script>'
      + '<script src="payload.html" nonce="mount-nonce"></script>'
      + '<script src="payload.css" nonce="mount-nonce"></script>'
      + '<script src="payload.txt" nonce="mount-nonce"></script>'
      + '<svg><script src="main.js" nonce="mount-nonce">globalThis.svgInjected = true</script></svg>'
      + '<p nonce="mount-nonce" onclick="globalThis.injected=true">Hello</p>');
    input.files['main.js'] = { mime: 'text/javascript', contentBase64: encodeBase64(new TextEncoder().encode('globalThis.started = true')) };
    for (const [path, mime] of [['payload.json', 'application/json'], ['payload.html', 'text/html'], ['payload.css', 'text/css'], ['payload.txt', 'text/plain']] as const) {
      input.files[path] = { mime, contentBase64: input.files['main.js'].contentBase64 };
    }
    const html = buildArtifactHtmlDocumentV1(input, {
      generatedArtifactNonce: 'mount-nonce',
      requestedCapabilities: { network: 'open' },
      guestBootstrapScript: 'globalThis.guestStarted = true;',
    });
    const csp = /content="([^"]*)"/u.exec(html)?.[1] ?? '';
    expect(csp).toContain("script-src 'nonce-mount-nonce';");
    expect(csp).toContain('style-src data:;');
    expect(csp).toContain("media-src 'none';");
    expect(csp).toContain('connect-src data:;');
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https:|blob:/u);
    const policies = [...html.matchAll(/http-equiv="Content-Security-Policy" content="([^"]*)"/gu)].map(match => match[1]);
    expect(policies).toHaveLength(2);
    expect(policies[1]).toBe(buildArtifactHtmlContentCspV1({ network: 'none' }));
    expect(policies[1]).not.toContain('nonce-');
    for (const directive of ['default-src', 'frame-src', 'worker-src', 'object-src', 'base-uri', 'form-action']) {
      expect(csp).toContain(`${directive} 'none'`);
    }
    const tags = html.match(/<script\b[^>]*>/gu) ?? [];
    expect(tags).toHaveLength(11);
    expect(tags.filter(tag => tag.includes('nonce="mount-nonce"'))).toHaveLength(3);
    expect(tags.slice(0, 3).every(tag => tag.includes('nonce="mount-nonce"'))).toBe(true);
    expect(tags[2]).toContain('src="data:text/javascript;base64,');
    expect(tags.slice(3).some(tag => tag.includes('nonce='))).toBe(false);
    expect(html).not.toContain('<p nonce=');
    expect(html).not.toContain('nonce="authored"');
  });
  it('reads retained bundle annotations without relaxing executable authoring or known paths', () => {
    const saved = { ...bundle, requestedCapabilities: { network: 'open' } };
    const retained = { ...saved, retired: true, files: { 'index.html': {
      ...saved.files['index.html'], retired: true } }, requestedCapabilities: {
      ...saved.requestedCapabilities, retired: true } };
    const encoded = JSON.stringify(retained);
    expect(artifactHtmlBundleFromBodyV1(encoded, ARTIFACT_HTML_BUNDLE_MIME_V1, 'stored')).toEqual(saved);
    expect(readArtifactPublicNetworkPolicyV1({ artifactId: 'artifact', header: { kind: 'html' }, htmlBundle: retained }))
      .toEqual({ network: 'open', networkOrigins: [] });
    expect(readArtifactPublicNetworkPolicyV1({ artifactId: 'artifact',
      header: { kind: 'html', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 }, body: encoded }))
      .toEqual({ network: 'open', networkOrigins: [] });
    expect(() => artifactHtmlBundleFromBodyV1(encoded, ARTIFACT_HTML_BUNDLE_MIME_V1)).toThrow();
    expect(() => artifactHtmlBundleFromBodyV1(JSON.stringify({ ...retained,
      entrypoint: '../index.html' }), ARTIFACT_HTML_BUNDLE_MIME_V1, 'stored')).toThrow();
    expect(() => artifactHtmlBundleFromBodyV1(JSON.stringify({ ...retained,
      requestedCapabilities: { network: '*' } }), ARTIFACT_HTML_BUNDLE_MIME_V1, 'stored')).toThrow();
  });
  it('executes a supplied guest bootstrap before author scripts without widening network policy', () => {
    const input = artifactHtmlBundleFromBodyV1('<script>globalThis.authorStarted = true</script>');
    const html = buildArtifactHtmlDocumentV1(input, { guestBootstrapScript: 'globalThis.guestStarted = "</script>";' });
    expect(html.indexOf('guestStarted')).toBeGreaterThan(0);
    expect(html.indexOf('guestStarted')).toBeLessThan(html.indexOf('authorStarted'));
    expect(html).toContain('<\\/script>');
    expect(html).toContain("script-src 'unsafe-inline' data:;");
    expect(html).toContain('connect-src data:;');
    expect(html).not.toContain('https:;');
  });
  it('persists the effective network declaration in a self-contained saved bundle and rejects malformed declarations', () => {
    for (const requestedCapabilities of [{ network: 'open' }, { network: 'none' }, { networkOrigins: ['https://cdn.example.com'] }]) {
      const saved = { ...bundle, requestedCapabilities };
      expect(ArtifactHtmlBundleV1Schema.safeParse(saved).success).toBe(true);
      expect(artifactHtmlBundleFromBodyV1(JSON.stringify(saved), ARTIFACT_HTML_BUNDLE_MIME_V1)).toEqual(saved);
    }
    for (const requestedCapabilities of [{ network: '*' }, { networkOrigins: ['https://*.example.com'] }]) {
      expect(ArtifactHtmlBundleV1Schema.safeParse({ ...bundle, requestedCapabilities }).success).toBe(false);
    }
  });
  it('fails malformed reader policy closed and lets explicit stored/share overrides narrow a saved policy', () => {
    for (const policy of [null, { network: '*' }, { network: 'open', networkOrigins: ['https://api.example.com'] }, { networkOrigins: ['https://*.example.com'] }]) {
      expect(buildArtifactHtmlContentCspV1(policy)).not.toContain('https:');
    }
    const saved = { ...bundle, requestedCapabilities: { network: 'open' as const } };
    expect(buildArtifactHtmlDocumentV1(saved)).toContain('connect-src data: https:;');
    expect(buildArtifactHtmlDocumentV1(saved, { networkOff: true })).toContain('connect-src data:;');
    expect(buildArtifactHtmlDocumentV1(saved, { requestedCapabilities: { network: 'none' } })).toContain('connect-src data:;');
  });
  it('normalizes a document and authenticates the closed bundle shape', () => {
    expect(artifactHtmlBundleFromBodyV1('<h1>Hello</h1>')).toEqual(bundle);
    expect(artifactHtmlBundleFromBodyV1('<h1>Hello</h1>', ' Text/HTML; charset=utf-8 ')).toEqual(bundle);
    expect(artifactHtmlBundleFromBodyV1(new TextEncoder().encode(JSON.stringify(bundle)), ARTIFACT_HTML_BUNDLE_MIME_V1)).toEqual(bundle);
    expect(isArtifactHtmlHeaderV1({ kind: 'html' })).toBe(true);
    expect(isArtifactHtmlHeaderV1({ kind: ' html ' })).toBe(false);
    expect(() => artifactHtmlBundleFromBodyV1(new Uint8Array([255]), 'text/html')).toThrow();
    expect(() => artifactHtmlBundleFromBodyV1('x', 'text/plain')).toThrow();
    expect(ArtifactHtmlBundleV1Schema.safeParse({ ...bundle, extra: true }).success).toBe(false);
  });
  it.each(['../index.html', '/index.html', 'a\\index.html', 'a//index.html', 'a/./index.html', 'https:x', 'a%2findex.html', '__proto__', 'a?x', 'a#x'])('rejects unsafe bundle path %s', path => {
    expect(ArtifactHtmlBundleV1Schema.safeParse({ ...bundle, entrypoint: path, files: { [path]: bundle.files['index.html'] } }).success).toBe(false);
  });
  it('accepts ordinary Unicode and space-bearing relative filenames', () => {
    expect(ArtifactHtmlBundleV1Schema.safeParse({ v: 1, entrypoint: '日本 index.html', files: {
      '日本 index.html': bundle.files['index.html'],
      'café image.svg': { mime: 'image/svg+xml', contentBase64: '' },
    } }).success).toBe(true);
  });
  it('refuses noncanonical base64 pad bits and missing asset MIME before execution', () => {
    for (const contentBase64 of ['Zh==', 'Zm9=', 'not base64']) {
      expect(ArtifactHtmlBundleV1Schema.safeParse({ ...bundle, files: {
        'index.html': { mime: 'text/html', contentBase64 },
      } }).success).toBe(false);
    }
    expect(ArtifactHtmlBundleV1Schema.safeParse({ ...bundle, files: {
      'index.html': { contentBase64: '' },
    } }).success).toBe(false);
  });
  it('admits only an isolated shell location without document bytes', () => {
    expect(ArtifactHtmlPreviewResponseV1Schema.safeParse({ url: 'https://artifact.preview.test/a/artifact' }).success).toBe(true);
    for (const url of ['not a URL', 'http://artifact.preview.test/a/artifact', 'https://user:secret@artifact.preview.test/a/artifact',
      'https://artifact.preview.test/a/artifact#d=private', 'https://artifact.preview.test/a/artifact?d=private']) {
      expect(ArtifactHtmlPreviewResponseV1Schema.safeParse({ url }).success).toBe(false);
    }
  });
});
