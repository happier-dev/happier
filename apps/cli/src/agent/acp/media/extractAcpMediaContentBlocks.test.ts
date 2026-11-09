import { describe, expect, it } from 'vitest';
import { extractAcpMediaContentBlocks } from './extractAcpMediaContentBlocks';

describe('standard ACP replay media', () => {
  it('preserves standard textual resources as tool output rather than unavailable images', () => {
    const content = [{ type: 'content', content: { type: 'resource', resource: {
      uri: 'file:///workspace/README.md', mimeType: 'text/plain', text: 'project notes',
    } } }];
    const result = extractAcpMediaContentBlocks(content, { originSource: 'tool-output' });
    expect(result.media).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.contentWithoutMedia).toEqual(content);
  });

  it('extracts inline image and embedded resource content from standard tool-content wrappers', () => {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII=';
    const result = extractAcpMediaContentBlocks([
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data } },
      { type: 'content', content: { type: 'resource', resource: { mimeType: 'image/png', blob: data } } },
    ], { originSource: 'tool-output', toolCallId: 'read-image' });
    expect(result.diagnostics).toEqual([]);
    expect(result.media.map(item => item.source)).toEqual([
      { kind: 'base64', data, mimeType: 'image/png' },
      { kind: 'base64', data, mimeType: 'image/png' },
    ]);
    expect(result.contentWithoutMedia).toEqual([]);
  });
});
