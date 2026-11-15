import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentUiBehaviorDeclarationV1Schema } from '@happier-dev/protocol/plugins/contributions/agentUiGrammar';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { MUSE_ACCOUNTING_SOURCE_ID } from '../agent/definition.js';
import { MUSE_UI_DESCRIPTOR } from './descriptor.js';

describe('Muse accounting presentation declaration', () => {
  it('names the native accounting source through the public Agent UI behavior declaration', () => {
    const parsed = AgentUiBehaviorDeclarationV1Schema.safeParse(MUSE_UI_DESCRIPTOR.behavior);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const source = parsed.data.accountingSourcePresentation?.find(row => row.sourceId === MUSE_ACCOUNTING_SOURCE_ID);
    expect(source).toBeDefined();
    expect(resolvePluginLocalizedStringV2Text(source?.title)).toBe('usage · Muse');
  });

  it('declares its identity mark as a packaged, theme-inked SVG, the way every bundled Agent supplies one', () => {
    const path = (MUSE_UI_DESCRIPTOR as { assets?: { svgIcon?: { path?: string } } }).assets?.svgIcon?.path;
    expect(path).toBeTruthy();
    const xml = readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
    expect(xml).toMatch(/^<svg[\s>]/u);
    // The host inks the mark from the theme (light and dark); a fixed or inherited colour would vanish on one of them.
    expect(xml).toContain('{{text.primary}}');
    expect(xml).not.toContain('currentColor');
  });
});
