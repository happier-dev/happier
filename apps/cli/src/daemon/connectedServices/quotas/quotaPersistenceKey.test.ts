import { describe, expect, it } from 'vitest';

describe('quotaPersistenceKey', () => {
  function createJwtWithSub(sub: string, marker: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub, marker })).toString('base64url');
    return `${header}.${payload}.signature`;
  }

  it('builds stable server/account-scoped keys without raw secret material', async () => {
    const mod = await import('./quotaPersistenceKey').catch(() => null);
    expect(mod?.buildQuotaPersistenceKey).toBeTypeOf('function');
    expect(mod?.hashQuotaPersistenceScope).toBeTypeOf('function');
    if (!mod) return;

    const key = mod.buildQuotaPersistenceKey({
      serverScope: 'https://local.example.test',
      accountScope: mod.hashQuotaPersistenceScope('raw-account-or-token-secret'),
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(key).toBe(mod.buildQuotaPersistenceKey({
      serverScope: 'https://local.example.test',
      accountScope: mod.hashQuotaPersistenceScope('raw-account-or-token-secret'),
      serviceId: 'openai-codex',
      profileId: 'work',
    }));
    expect(key).not.toContain('raw-account-or-token-secret');
    expect(key).not.toContain('https://local.example.test');
  });

  it('does not merge quota work across server or account scopes', async () => {
    const mod = await import('./quotaPersistenceKey').catch(() => null);
    expect(mod?.buildQuotaPersistenceKey).toBeTypeOf('function');
    expect(mod?.hashQuotaPersistenceScope).toBeTypeOf('function');
    if (!mod) return;

    const base = {
      serverScope: 'server-a',
      accountScope: mod.hashQuotaPersistenceScope('account-a'),
      serviceId: 'openai-codex' as const,
      profileId: 'work',
    };

    expect(mod.buildQuotaPersistenceKey(base)).not.toBe(mod.buildQuotaPersistenceKey({
      ...base,
      serverScope: 'server-b',
    }));
    expect(mod.buildQuotaPersistenceKey(base)).not.toBe(mod.buildQuotaPersistenceKey({
      ...base,
      accountScope: mod.hashQuotaPersistenceScope('account-b'),
    }));
  });

  it('resolves quota account scope from JWT subject instead of token body', async () => {
    const mod = await import('./quotaPersistenceKey').catch(() => null);
    expect(mod?.resolveQuotaPersistenceAccountScope).toBeTypeOf('function');
    if (!mod?.resolveQuotaPersistenceAccountScope) return;

    const firstScope = mod.resolveQuotaPersistenceAccountScope({
      token: createJwtWithSub('account-1', 'first-token'),
    });
    const refreshedScope = mod.resolveQuotaPersistenceAccountScope({
      token: createJwtWithSub('account-1', 'refreshed-token'),
    });
    const differentAccountScope = mod.resolveQuotaPersistenceAccountScope({
      token: createJwtWithSub('account-2', 'first-token'),
    });

    expect(firstScope).toEqual(refreshedScope);
    expect(firstScope).not.toEqual(differentAccountScope);
    expect(firstScope).toMatchObject({ kind: 'known' });
  });
});
