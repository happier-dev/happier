import { describe, expect, it } from 'vitest';
import { projectActionDefinitionSummaryForExternalDiscovery, searchSerializedActionSpecsForSurface } from './actionCatalog.js';
import { getActionSpec } from './actionSpecs.js';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1 } from './settings/settingsDeclarations.js';

describe('settings discovery', () => {
  it('finds settings discovery from a displayed page name and publishes the exact page operands', () => {
    const results = searchSerializedActionSpecsForSurface({ surface: 'voice', query: 'voice settings', limit: 5 })
      .map(projectActionDefinitionSummaryForExternalDiscovery);
    expect(results.map(result => result.id)).toContain('settings.list');
    const pages = getActionSpec('settings.list').inputHints?.fields.find(field => field.path === 'pageId')?.description;
    for (const pageId of new Set(BUILT_IN_SETTINGS_DECLARATIONS_V1.map(setting => setting.pageId))) {
      expect(pages).toContain(pageId);
    }
  });
});
