import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { listActionSpecsForSurface } from './actionSpecs.js';
import { renderPluginActionReferenceMarkdown } from './pluginActionReference.js';

const actionReferencePath = fileURLToPath(
  new URL('../../../../apps/docs/content/docs/plugins/api/host-actions.mdx', import.meta.url),
);

function readRenderedActionIds(markdown: string): readonly string[] {
  return [...markdown.matchAll(/^## `([^`]+)`$/gmu)].map((match) => match[1]!);
}

describe('plugin Action reference generator', () => {
  it('renders every and only canonical Plugin-surfaced ActionSpec', () => {
    const expectedActionIds = listActionSpecsForSurface('plugin')
      .map((spec) => spec.id)
      .sort();
    const markdown = renderPluginActionReferenceMarkdown();

    expect(readRenderedActionIds(markdown)).toEqual(expectedActionIds);
    expect(markdown).toContain('context.services.actions.execute');
    expect(markdown).toContain('canonical ActionSpec registry');
  });

  it('renders each row\'s canonical caller authority and the discoverability caveat', () => {
    const markdown = renderPluginActionReferenceMarkdown();
    const actionSpecs = listActionSpecsForSurface('plugin');
    const presentUserRows = actionSpecs.filter((spec) => spec.requiredAuthority === 'present_user');
    expect(presentUserRows.length).toBeGreaterThan(0);

    for (const spec of actionSpecs) {
      const section = markdown.split(`## \`${spec.id}\``)[1] ?? '';
      const body = section.split('## `')[0] ?? '';
      expect(body).toContain(
        spec.requiredAuthority === 'present_user'
          ? '- Caller authority: `present_user`'
          : '- Caller authority: `account_automation`',
      );
    }
    expect(markdown).toContain('does not imply a plugin caller can satisfy it');
    expect(markdown).toContain('`present_user_required`');
  });

  it('keeps the published reference synchronized with the canonical registry', () => {
    expect(readFileSync(actionReferencePath, 'utf8')).toBe(
      renderPluginActionReferenceMarkdown(),
    );
  });
});
