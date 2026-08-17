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

  it('keeps the published reference synchronized with the canonical registry', () => {
    expect(readFileSync(actionReferencePath, 'utf8')).toBe(
      renderPluginActionReferenceMarkdown(),
    );
  });
});
