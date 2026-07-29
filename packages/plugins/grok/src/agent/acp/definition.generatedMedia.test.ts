import { describe, expect, it } from 'vitest';

import { buildGrokAcpRuntimeDefinition } from './definition.js';

function readProjector() {
  return buildGrokAcpRuntimeDefinition({}).generatedMedia?.projectTerminalOutput;
}

describe('Grok ACP generated media', () => {
  it.each(['ImageGen', 'ImageEdit'])('projects an official local-file %s output', (type) => {
    const projector = readProjector();
    const outputPath = '/tmp/sessions/provider-created/images/generated-1.png';

    expect(projector?.({
      rawOutput: {
        type,
        path: outputPath,
        filename: 'generated-1.png',
        session_folder: 'images',
      },
      toolCallId: 'tool-1',
      toolName: 'image',
    })).toEqual([{
      rootPath: '/tmp/sessions/provider-created/images',
      path: outputPath,
    }]);
  });

  it.each([
    ['prose', 'generated /tmp/grok-session/image.png'],
    ['arbitrary path object', { path: '/tmp/grok-session/image.png' }],
    ['unsupported tagged output', {
      type: 'WebSearch',
      path: '/tmp/grok-session/image.png',
      filename: 'image.png',
      session_folder: 'grok-session',
    }],
    ['uploaded-only output', {
      type: 'ImageGen',
      path: '/tmp/grok-session/image.png',
      filename: 'image.png',
      session_folder: 'grok-session',
      uploaded_url: 'https://example.invalid/image.png',
    }],
    ['empty path', {
      type: 'ImageGen',
      path: '',
      filename: 'image.png',
      session_folder: 'grok-session',
    }],
    ['mismatched filename', {
      type: 'ImageGen',
      path: '/tmp/grok-session/image.png',
      filename: 'other.png',
      session_folder: 'grok-session',
    }],
    ['mismatched session folder', {
      type: 'ImageGen',
      path: '/tmp/grok-session/image.png',
      filename: 'image.png',
      session_folder: 'another-session',
    }],
    ['unsupported SVG path', {
      type: 'ImageGen',
      path: '/tmp/grok-session/image.svg',
      filename: 'image.svg',
      session_folder: 'grok-session',
    }],
    ['extra keys', {
      type: 'ImageGen',
      path: '/tmp/grok-session/image.png',
      filename: 'image.png',
      session_folder: 'grok-session',
      data: 'base64',
    }],
  ])('rejects %s', (_name, rawOutput) => {
    expect(readProjector()?.({
      rawOutput,
      toolCallId: 'tool-1',
      toolName: 'image',
    })).toBeNull();
  });
});
