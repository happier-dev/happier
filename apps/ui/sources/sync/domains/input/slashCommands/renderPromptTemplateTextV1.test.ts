import { describe, expect, it } from 'vitest';

import { renderPromptTemplateTextV1 } from './renderPromptTemplateTextV1';

describe('renderPromptTemplateTextV1', () => {
  it('replaces $ARGUMENTS', () => {
    expect(renderPromptTemplateTextV1({ templateMarkdown: 'Hello $ARGUMENTS', argsText: 'world' })).toBe('Hello world');
  });

  it('replaces $1, $2… positional args', () => {
    expect(renderPromptTemplateTextV1({ templateMarkdown: 'Hello $1', argsText: 'world there' })).toBe('Hello world');
    expect(renderPromptTemplateTextV1({ templateMarkdown: 'Hello $2', argsText: 'world there' })).toBe('Hello there');
  });

  it('appends args when no placeholders are present', () => {
    expect(renderPromptTemplateTextV1({ templateMarkdown: 'Hello', argsText: 'world' })).toBe('Hello\n\nworld');
  });
});

