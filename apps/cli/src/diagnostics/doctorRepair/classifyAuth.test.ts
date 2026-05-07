import { describe, expect, it } from 'vitest';

import { classifyAuth, type AuthSignalsForProfile } from './classifyAuth';

function makeSignal(overrides: Partial<AuthSignalsForProfile>): AuthSignalsForProfile {
  return {
    serverId: 'default',
    serverName: 'Happier Cloud',
    serverUrl: 'https://api.happier.dev',
    hasCredentials: true,
    isExpired: false,
    machineRegistered: true,
    isActive: true,
    reachability: 'verified',
    ...overrides,
  };
}

describe('classifyAuth', () => {
  it('fires no_servers_configured when no profiles are configured', () => {
    const findings = classifyAuth({ hasAnyServerProfile: false, signals: [] });
    expect(findings.map((f) => f.kind)).toEqual(['no_servers_configured']);
  });

  it('returns empty when all signals are healthy', () => {
    const findings = classifyAuth({
      hasAnyServerProfile: true,
      signals: [makeSignal({ isActive: true, hasCredentials: true, machineRegistered: true })],
    });
    expect(findings).toEqual([]);
  });

  it('fires auth_missing_for_profile for the active profile when credentials are missing', () => {
    const findings = classifyAuth({
      hasAnyServerProfile: true,
      signals: [makeSignal({ isActive: true, hasCredentials: false })],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('auth_missing_for_profile');
    expect(findings[0].severity).toBe('warning');
  });

  it('fires auth_expired_for_active_profile when the active profile\u2019s session has expired', () => {
    const findings = classifyAuth({
      hasAnyServerProfile: true,
      signals: [makeSignal({ isActive: true, hasCredentials: true, isExpired: true })],
    });
    expect(findings.map((f) => f.kind)).toEqual(['auth_expired_for_active_profile']);
  });

  it('fires machine_not_registered_for_profile when active profile has credentials but no machine id', () => {
    const findings = classifyAuth({
      hasAnyServerProfile: true,
      signals: [makeSignal({ isActive: true, hasCredentials: true, machineRegistered: false })],
    });
    expect(findings.map((f) => f.kind)).toEqual(['machine_not_registered_for_profile']);
  });

  it('also surfaces missing credentials for non-active profiles (lower severity)', () => {
    const findings = classifyAuth({
      hasAnyServerProfile: true,
      signals: [
        makeSignal({ serverId: 'active', isActive: true, hasCredentials: true, machineRegistered: true }),
        makeSignal({ serverId: 'company', isActive: false, hasCredentials: false, serverName: 'Company' }),
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('auth_missing_for_profile');
    expect(findings[0].severity).toBe('info'); // lower severity for non-active
  });

  it('only emits the active-profile finding even when multiple non-active profiles are also missing', () => {
    const findings = classifyAuth({
      hasAnyServerProfile: true,
      signals: [
        makeSignal({ serverId: 'active', isActive: true, hasCredentials: false }),
        makeSignal({ serverId: 'company', isActive: false, hasCredentials: false }),
        makeSignal({ serverId: 'self-hosted', isActive: false, hasCredentials: false }),
      ],
    });
    const activeFindings = findings.filter((f) =>
      f.kind === 'auth_missing_for_profile' && f.serverId === 'active',
    );
    expect(activeFindings).toHaveLength(1);
    expect(activeFindings[0].severity).toBe('warning');
    // Other two profiles still flagged separately
    expect(findings.filter((f) => f.kind === 'auth_missing_for_profile')).toHaveLength(3);
  });

  it('falls back gracefully when there are no signals but profiles are configured', () => {
    // A user has configured servers but no signals resolved — unusual. We
    // emit nothing (can't flag anything concrete without signals).
    const findings = classifyAuth({ hasAnyServerProfile: true, signals: [] });
    expect(findings).toEqual([]);
  });
});
