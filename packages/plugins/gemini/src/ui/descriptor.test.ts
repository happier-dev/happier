import { describe, expect, it } from 'vitest';

import { GEMINI_UI_DESCRIPTOR } from './descriptor.js';

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

describe('GEMINI_UI_DESCRIPTOR', () => {
  it('is a versioned plugin UI descriptor', () => {
    expect(GEMINI_UI_DESCRIPTOR).toMatchObject({
      kind: 'plugin.ui.v1',
      pluginId: 'gemini',
      agentId: 'gemini',
      version: 1,
      display: {
        nameKey: 'agentInput.agent.gemini',
        connectedService: { serviceId: 'gemini', labelKey: 'agentInput.agent.gemini', connectRoute: null },
        icon: { assetId: 'gemini' },
      },
    });
  });

  it('is a data-only no-execute descriptor', () => {
    expect(collectNoExecuteViolations(GEMINI_UI_DESCRIPTOR)).toEqual([]);
    expect(JSON.parse(JSON.stringify(GEMINI_UI_DESCRIPTOR))).toEqual(GEMINI_UI_DESCRIPTOR);
  });
});
