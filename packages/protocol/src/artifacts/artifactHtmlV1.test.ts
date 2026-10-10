import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../crypto/base64.js';
import { ARTIFACT_HTML_BUNDLE_MIME_V1, ArtifactHtmlBundleV1Schema, artifactHtmlBundleFromBodyV1,
  isArtifactHtmlHeaderV1, ArtifactHtmlPreviewResponseV1Schema } from './artifactHtmlV1.js';

const bundle = { v: 1 as const, entrypoint: 'index.html', files: { 'index.html': {
  mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode('<h1>Hello</h1>')),
} } };
describe('Artifact HTML bundle V1', () => {
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
