import { describe, expect, it } from 'vitest';

import { renderPromptTemplateTextV1 } from './renderPromptTemplateTextV1';

describe('renderPromptTemplateTextV1', () => {
  it('places the first empty argument after rendered positional placeholders using UTF-16 offsets', () => {
    expect(renderPromptTemplateTextV1({ templateMarkdown: '😀 $1 then $ARGUMENTS / $ARGUMENTS', argsText: '' }))
      .toEqual({ text: '😀  then  / ', argumentRange: [9, 9] });
  });
  it('replaces $ARGUMENTS', () => {
    expect(renderPromptTemplateTextV1({ templateMarkdown: 'Hello $ARGUMENTS', argsText: 'world' })).toEqual({ text: 'Hello world' });
  });

  it('replaces $1, $2… positional args', () => {
    expect(renderPromptTemplateTextV1({ templateMarkdown: 'Hello $1', argsText: 'world there' })).toEqual({ text: 'Hello world' });
    expect(renderPromptTemplateTextV1({ templateMarkdown: 'Hello $2', argsText: 'world there' })).toEqual({ text: 'Hello there' });
  });

  it('appends args when no placeholders are present', () => {
    expect(renderPromptTemplateTextV1({ templateMarkdown: 'Hello', argsText: 'world' })).toEqual({ text: 'Hello\n\nworld' });
  });
});
