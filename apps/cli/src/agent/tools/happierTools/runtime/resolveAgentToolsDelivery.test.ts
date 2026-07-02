import { describe, expect, it } from 'vitest';

import { resolveAgentToolsDelivery } from './resolveAgentToolsDelivery';

describe('resolveAgentToolsDelivery', () => {
  it('resolves canonical providers normally', () => {
    expect(resolveAgentToolsDelivery('claude')).toBe('native_mcp');
    expect(resolveAgentToolsDelivery('gemini')).toBe('native_mcp');
  });

  it('fails closed for legacy customAcp carriers', () => {
    expect(resolveAgentToolsDelivery('customAcp')).toBe('unsupported');
    expect(resolveAgentToolsDelivery('custom-acp')).toBe('unsupported');
    expect(resolveAgentToolsDelivery('acp:review-bot')).toBe('unsupported');
  });
});
