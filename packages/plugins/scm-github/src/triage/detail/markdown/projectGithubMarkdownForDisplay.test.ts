import { describe, expect, it } from 'vitest';

import { githubMarkdownDisplayText, projectGithubMarkdownForDisplay } from './projectGithubMarkdownForDisplay.js';

const ASSET = 'https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef';
const VIDEO = 'https://media.example.test/demo.mp4';
const VIDEO_SOURCE = 'https://media.example.test/demo.webm';
const VIDEO_BLOCK = `<video controls>\n  <source src="${VIDEO_SOURCE}">\n</video>`;

describe('GitHub Markdown display projection', () => {
  it('titles a GitHub alert as GitHub does instead of showing its marker, and leaves code alone', () => {
    expect(githubMarkdownDisplayText('> [!IMPORTANT]\n> Run the migration first.\n'))
      .toBe('> **Important**\n> Run the migration first.\n');
    expect(githubMarkdownDisplayText('```\n> [!NOTE]\n```\n')).toBe('```\n> [!NOTE]\n```\n');
  });

  it('preserves GitHub HTML image destinations as Markdown without executing HTML or touching code', () => {
    const source = 'https://github.com/user-attachments/assets/screenshot';
    expect(githubMarkdownDisplayText(`<img width="800" alt="image" src="${source}">`))
      .toBe(`![image](${source})`);
    expect(githubMarkdownDisplayText(`<img src="${source}" />`)).toBe(`![](${source})`);
    expect(githubMarkdownDisplayText('<img alt="image" src="javascript:alert(1)">')).toBe('image');
    expect(githubMarkdownDisplayText('`<img alt="image" src="https://example.test/a.png">`'))
      .toBe('`<img alt="image" src="https://example.test/a.png">`');
  });

  it.each([4, 8, 100])('recognizes video blocks with %i blank lines without hiding the source', (blankLines) => {
    const block = `<video controls>\n${'\n'.repeat(blankLines)}  <source src="${VIDEO_SOURCE}">\n</video>`;
    expect(projectGithubMarkdownForDisplay(block)).toEqual([
      { kind: 'attachment', media: 'video', url: VIDEO_SOURCE },
    ]);
  });

  it('keeps useful video links for malformed and unclosed blocks without swallowing later blocks or code', () => {
    const fenced = `\`\`\`html\n${VIDEO_BLOCK}\n\`\`\``;
    const input = [
      `<video src="${VIDEO}">`,
      `<video><source src="${VIDEO_SOURCE}"></video> trailing prose`,
      ...Array.from({ length: 1000 }, () => `<video src="${VIDEO}">`),
      fenced,
      VIDEO_BLOCK,
      `<video src="${VIDEO}">`,
    ].join('\n');
    const projected = projectGithubMarkdownForDisplay(input);
    const markdown = projected.filter((segment) => segment.kind === 'markdown').map((segment) => segment.value).join('');
    expect(markdown).toContain(`[${VIDEO}](${VIDEO})`);
    expect(markdown).toContain(`[${VIDEO_SOURCE}](${VIDEO_SOURCE}) trailing prose`);
    expect(markdown).toContain(fenced);
    expect(projected.filter((segment) => segment.kind === 'attachment')).toEqual([
      { kind: 'attachment', media: 'video', url: VIDEO_SOURCE },
    ]);
    expect(markdown.match(/\[https:\/\/media\.example\.test\/demo\.mp4\]/g)).toHaveLength(1002);
  });

  it('projects supported GitHub attachments only outside fenced and indented code', () => {
    const backticks = `\`\`\`md\n${ASSET}\n${VIDEO_BLOCK}\n\`\`\`\n`;
    const tildes = `~~~~html\n${VIDEO}\n${VIDEO_BLOCK}\n~~~~\n`;
    const indented = `    ${ASSET}\n\t${VIDEO_BLOCK.replaceAll('\n', '\n\t')}\n`;
    const input = [
      'Before\n',
      `${ASSET}\n`,
      `${VIDEO}\n`,
      `${VIDEO_BLOCK}\n`,
      backticks,
      tildes,
      indented,
      'After',
    ].join('');

    const projected = projectGithubMarkdownForDisplay(input);

    expect(projected.filter((segment) => segment.kind === 'attachment')).toEqual([
      { kind: 'attachment', media: 'asset', url: ASSET },
      { kind: 'attachment', media: 'video', url: VIDEO },
      { kind: 'attachment', media: 'video', url: VIDEO_SOURCE },
    ]);
    const markdown = projected
      .filter((segment) => segment.kind === 'markdown')
      .map((segment) => segment.value)
      .join('');
    expect(markdown).toContain(backticks);
    expect(markdown).toContain(tildes);
    expect(markdown).toContain(indented);
  });

  it('keeps unclosed and mismatched GitHub Markdown fences verbatim', () => {
    const input = [
      '````html',
      ASSET,
      '```',
      VIDEO_BLOCK,
      '~~~',
      VIDEO,
    ].join('\n');

    expect(projectGithubMarkdownForDisplay(input)).toEqual([
      { kind: 'markdown', value: input },
    ]);
  });

  it('never shows raw HTML: comments vanish, links and images become Markdown, code stays exact', () => {
    // Live 2026-10-16: a review bot's comment showed `<!-- … -->` and `<a href><picture>` tags literally.
    const input = [
      '<!-- auto-generated comment: summarize by bot -->',
      '<!-- review_stack_entry_start',
      'multi line note -->',
      '<a href="https://app.example.test/stack/pull/535?scope=abc"><picture><source media="(prefers-color-scheme: dark)" srcset="https://x.test/d.svg"><img src="https://x.test/l.svg" alt="Review in Change Stack" height="32"></picture></a>',
      'Line one<br>line two and <b>bold</b> plus <https://example.test/auto>.',
      'Inline code keeps `<div class="x">` exact.',
      '```html',
      '<!-- kept -->',
      '<a href="https://keep.test">kept</a>',
      '```',
      '    <!-- indented code kept -->',
      'After',
    ].join('\n');

    const text = githubMarkdownDisplayText(input);

    expect(text).not.toContain('auto-generated');
    expect(text).not.toContain('multi line note');
    expect(text).not.toContain('<picture>');
    expect(text).toContain('[![Review in Change Stack](https://x.test/l.svg)](https://app.example.test/stack/pull/535?scope=abc)');
    expect(text).toContain('Line one line two and bold plus <https://example.test/auto>.');
    expect(text).toContain('`<div class="x">`');
    expect(text).toContain('<!-- kept -->\n<a href="https://keep.test">kept</a>');
    expect(text).toContain('    <!-- indented code kept -->');
    expect(text).toContain('After');
    expect(projectGithubMarkdownForDisplay(input).every((segment) => segment.kind !== 'markdown'
      || !segment.value.includes('review_stack_entry_start'))).toBe(true);
  });
});
