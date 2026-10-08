import { describe, expect, it } from 'vitest';

import { parseConnectArgs } from './parseConnectArgs';

describe('parseConnectArgs', () => {
  it('parses --device and --profile and a subcommand', () => {
    const res = parseConnectArgs(['codex', '--device', '--profile', 'work']);
    expect(res.subcommand).toBe('codex');
    expect(res.options.profileId).toBe('work');
    expect(res.options.device).toBe(true);
  });

  it('parses fixed import sources and project selection', () => {
    const res = parseConnectArgs(['agy', '--import', '--import-source', 'cli', '--project', 'verified-project']);
    expect(res.options).toMatchObject({ importExisting: true, importSource: 'cli', projectId: 'verified-project' });
  });

  it('defaults profile to default', () => {
    const res = parseConnectArgs(['codex']);
    expect(res.options.profileId).toBe('default');
  });

  it('parses --oauth', () => {
    const res = parseConnectArgs(['claude', '--oauth']);
    expect(res.options.oauth).toBe(true);
  });

  it('parses --api-key', () => {
    const res = parseConnectArgs(['claude', '--api-key']);
    expect(res.options.apiKey).toBe(true);
  });

  it('parses --token', () => {
    const res = parseConnectArgs(['github', '--token']);
    expect(res.options.token).toBe(true);
  });
});
