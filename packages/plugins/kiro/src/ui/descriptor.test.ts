import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_NO_EXECUTE_KEYS = new Set([
  'projection',
  'importName',
  'source',
  'label',
  'uiBehaviorOverride',
  'sessionProviderBehavior',
  'messageMetaOverride',
  'agentSettings',
  'visibleMessageResolver',
  'svgIconXml',
]);

function collectNoExecuteViolations(value: unknown, path = 'descriptor'): string[] {
  if (typeof value === 'function') return [`${path}: function value`];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectNoExecuteViolations(item, `${path}[${index}]`));
  }

  return Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, child]) => {
    const violations: string[] = [];
    if (FORBIDDEN_NO_EXECUTE_KEYS.has(key)) violations.push(`${path}.${key}: executable projection key`);
    if (typeof child === 'string' && /#[0-9a-fA-F]{3,8}\b/.test(child)) {
      violations.push(`${path}.${key}: raw color literal`);
    }
    return [...violations, ...collectNoExecuteViolations(child, `${path}.${key}`)];
  });
}

describe('KIRO_UI_DESCRIPTOR', () => {
  it('owns Kiro UI projection facts as data-only plugin metadata', async () => {
    const descriptorUrl = new URL('./descriptor.ts', import.meta.url);

    expect(existsSync(descriptorUrl)).toBe(true);
    if (!existsSync(descriptorUrl)) return;

    const module = await import('./descriptor.js') as { KIRO_UI_DESCRIPTOR?: unknown };

    expect(module.KIRO_UI_DESCRIPTOR).toMatchObject({
      kind: 'plugin.ui.v1',
      pluginId: 'kiro',
      agentId: 'kiro',
      version: 1,
      display: {
        nameKey: 'agentInput.agent.kiro',
        subtitleKey: 'profiles.aiBackend.kiroSubtitleExperimental',
        connectedService: { serviceId: null, labelKey: 'agentInput.agent.kiro', connectRoute: null },
        localControl: true,
        toolRendering: {
          hideUnknownToolsByDefault: false,
        },
        icon: { assetId: 'kiro' },
      },
      capabilityStates: {
        mcpDelivery: 'supported',
        modelSelection: 'experimental',
        resume: 'experimental',
      },
    });
    expect(module.KIRO_UI_DESCRIPTOR).not.toHaveProperty('settings');
    expect(collectNoExecuteViolations(module.KIRO_UI_DESCRIPTOR)).toEqual([]);
    expect(JSON.parse(JSON.stringify(module.KIRO_UI_DESCRIPTOR))).toEqual(module.KIRO_UI_DESCRIPTOR);
  });
});
