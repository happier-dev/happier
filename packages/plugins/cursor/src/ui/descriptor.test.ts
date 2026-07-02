import { describe, expect, it } from 'vitest';

import { CURSOR_UI_DESCRIPTOR } from './descriptor.js';

const FORBIDDEN_NO_EXECUTE_KEYS = new Set([
  'projection',
  'importName',
  'source',
  'label',
  'uiBehaviorOverride',
  'sessionProviderBehavior',
  'messageMetaOverride',
  'providerSettings',
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

describe('CURSOR_UI_DESCRIPTOR', () => {
  it('owns Cursor UI projection facts without claiming stable MCP support', () => {
    expect(CURSOR_UI_DESCRIPTOR).toEqual(expect.objectContaining({
      kind: 'plugin.ui.v1',
      pluginId: 'cursor',
      agentId: 'cursor',
      version: 1,
      display: expect.objectContaining({
        nameKey: 'agentInput.agent.cursor',
        subtitleKey: 'profiles.aiBackend.cursorSubtitleExperimental',
        connectedService: { serviceId: null, labelKey: 'agentInput.agent.cursor', connectRoute: null },
        toolRendering: {
          hideUnknownToolsByDefault: true,
        },
        icon: { assetId: 'cursor' },
      }),
      capabilityStates: {
        mcpDelivery: 'experimental',
        modelSelection: 'experimental',
        resume: 'experimental',
      },
    }));
  });

  it('is a data-only no-execute descriptor', () => {
    expect(collectNoExecuteViolations(CURSOR_UI_DESCRIPTOR)).toEqual([]);
    expect(JSON.parse(JSON.stringify(CURSOR_UI_DESCRIPTOR))).toEqual(CURSOR_UI_DESCRIPTOR);
  });
});
