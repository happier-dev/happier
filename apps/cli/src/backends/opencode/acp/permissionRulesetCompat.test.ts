import { describe, expect, it } from 'vitest';

import { normalizeOpenCodeAcpPermissionRulesetActions } from './permissionRulesetCompat';

describe('OpenCode ACP permission ruleset compat', () => {
  it('coerces alias action values inside nested ruleset arrays to allow|deny|ask', () => {
    const input = JSON.stringify({
      jsonrpc: '2.0',
      method: 'requestPermission',
      params: {
        ruleset: [
          { tool: 'read', action: 'allow' },
          { tool: 'write', action: 'prompt' },
          { tool: 'edit', action: 'ASK_USER' },
        ],
      },
    });

    const out = normalizeOpenCodeAcpPermissionRulesetActions(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.params.ruleset[0].action).toBe('allow');
    expect(parsed.params.ruleset[1].action).toBe('ask');
    expect(parsed.params.ruleset[2].action).toBe('ask');
  });

  it('coerces non-string action values to ask (fail-closed)', () => {
    const input = JSON.stringify({
      jsonrpc: '2.0',
      method: 'requestPermission',
      params: {
        ruleset: [
          { tool: 'read', action: true },
          { tool: 'write', action: null },
          { tool: 'edit' },
        ],
      },
    });

    const out = normalizeOpenCodeAcpPermissionRulesetActions(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.params.ruleset[0].action).toBe('ask');
    expect(parsed.params.ruleset[1].action).toBe('ask');
    expect(parsed.params.ruleset[2].action).toBe('ask');
  });

  it('maps reject/block to deny and approve/permit to allow', () => {
    const input = JSON.stringify({
      params: {
        ruleset: [
          { action: 'reject' },
          { action: 'block' },
          { action: 'approve' },
          { action: 'permit' },
        ],
      },
    });

    const out = normalizeOpenCodeAcpPermissionRulesetActions(input);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.params.ruleset[0].action).toBe('deny');
    expect(parsed.params.ruleset[1].action).toBe('deny');
    expect(parsed.params.ruleset[2].action).toBe('allow');
    expect(parsed.params.ruleset[3].action).toBe('allow');
  });

  it('returns invalid JSON input unchanged', () => {
    expect(normalizeOpenCodeAcpPermissionRulesetActions('not-json')).toBe('not-json');
  });

  it('returns payload unchanged when ruleset is missing', () => {
    const input = JSON.stringify({ jsonrpc: '2.0', method: 'anything', params: { foo: 'bar' } });
    expect(normalizeOpenCodeAcpPermissionRulesetActions(input)).toBe(input);
  });

  it('returns payload unchanged when ruleset is not an array', () => {
    const input = JSON.stringify({ params: { ruleset: { action: 'ask' } } });
    expect(normalizeOpenCodeAcpPermissionRulesetActions(input)).toBe(input);
  });

  it('returns payload unchanged when ruleset actions are already canonical', () => {
    const input = JSON.stringify({
      params: {
        ruleset: [{ action: 'allow' }, { action: 'deny' }, { action: 'ask' }],
      },
    });
    expect(normalizeOpenCodeAcpPermissionRulesetActions(input)).toBe(input);
  });
});
