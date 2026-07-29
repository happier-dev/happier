import { describe, expect, it } from 'vitest';

import { extractCodexGeneratedMediaCandidate } from './generatedMedia.js';

describe('extractCodexGeneratedMediaCandidate', () => {
  it('projects the strict completed app-server image-generation item saved path', () => {
    expect(extractCodexGeneratedMediaCandidate('img_1', {
      type: 'imageGeneration',
      id: 'img_1',
      status: 'completed',
      result: 'iVBORw0KGgo=',
      revisedPrompt: null,
      savedPath: '/tmp/codex/generated.png',
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

  it.each([
    ['prose', 'saved /tmp/codex/generated.png'],
    ['base64-only official item', {
      type: 'imageGeneration',
      id: 'img_2',
      status: 'completed',
      result: 'iVBORw0KGgo=',
      revisedPrompt: null,
    }],
    ['snake-case aliases', {
      type: 'image_generation_call',
      id: 'img_2',
      status: 'completed',
      result: 'iVBORw0KGgo=',
      revised_prompt: null,
      saved_path: '/tmp/codex/generated.png',
    }],
    ['relative saved path', {
      type: 'imageGeneration',
      id: 'img_2',
      status: 'completed',
      result: 'iVBORw0KGgo=',
      revisedPrompt: null,
      savedPath: 'relative/generated.png',
    }],
    ['unsupported SVG path', {
      type: 'imageGeneration',
      id: 'img_2',
      status: 'completed',
      result: 'PHN2Zz4=',
      revisedPrompt: null,
      savedPath: '/tmp/codex/generated.svg',
    }],
    ['nonterminal item', {
      type: 'imageGeneration',
      id: 'img_2',
      status: 'generating',
      result: 'iVBORw0KGgo=',
      revisedPrompt: null,
      savedPath: '/tmp/codex/generated.png',
    }],
    ['mismatched item id', {
      type: 'imageGeneration',
      id: 'another-item',
      status: 'completed',
      result: 'iVBORw0KGgo=',
      revisedPrompt: null,
      savedPath: '/tmp/codex/generated.png',
    }],
    ['extra untrusted path alias', {
      type: 'imageGeneration',
      id: 'img_2',
      status: 'completed',
      result: 'iVBORw0KGgo=',
      revisedPrompt: null,
      savedPath: '/tmp/codex/generated.png',
      path: '/tmp/other/guessed.png',
    }],
  ])('rejects %s', (_name, item) => {
    expect(extractCodexGeneratedMediaCandidate('img_2', item as Record<string, unknown>))
      .toBeNull();
  });
});
