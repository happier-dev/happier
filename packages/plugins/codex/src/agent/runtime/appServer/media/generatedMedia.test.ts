import { describe, expect, it } from 'vitest';

import { extractCodexGeneratedMediaCandidate } from './generatedMedia.js';

describe('extractCodexGeneratedMediaCandidate', () => {
  it('prefers absolute saved paths over inline base64 payloads', () => {
    expect(extractCodexGeneratedMediaCandidate('img_1', {
      result: 'iVBORw0KGgo=',
      saved_path: '/tmp/codex/generated.png',
    })).toEqual({
      itemId: 'img_1',
      origin: {
        source: 'provider-generated',
        agentEventId: 'img_1',
        generationId: 'img_1',
      },
      source: {
        kind: 'local-file',
        path: '/tmp/codex/generated.png',
        fileNameHint: 'generated.png',
        restrictedRoot: '/tmp/codex',
      },
    });
  });

  it('extracts inline base64 media from Codex result fields', () => {
    expect(extractCodexGeneratedMediaCandidate('img_2', {
      b64_json: 'iVBORw0KGgo=',
    })).toEqual({
      itemId: 'img_2',
      origin: {
        source: 'provider-generated',
        agentEventId: 'img_2',
        generationId: 'img_2',
      },
      source: {
        kind: 'base64',
        data: 'iVBORw0KGgo=',
        fileNameHint: 'img_2.png',
      },
    });
  });

  it('falls back to inline base64 when a saved path is relative', () => {
    expect(extractCodexGeneratedMediaCandidate('img_3', {
      savedPath: 'relative/generated.png',
      result: 'iVBORw0KGgo=',
    })).toEqual({
      itemId: 'img_3',
      origin: {
        source: 'provider-generated',
        agentEventId: 'img_3',
        generationId: 'img_3',
      },
      source: {
        kind: 'base64',
        data: 'iVBORw0KGgo=',
        fileNameHint: 'img_3.png',
      },
    });
  });
});
