import { describe, expect, it, vi } from 'vitest';

const { readCredentialsMock, readSettingsMock } = vi.hoisted(() => ({
  readCredentialsMock: vi.fn(async () => null as { token: string } | null),
  readSettingsMock: vi.fn(async () => ({
    schemaVersion: 5,
    onboardingCompleted: false,
    activeServerId: 'cloud',
    servers: {
      cloud: {
        id: 'cloud',
        name: 'Happier Cloud',
        serverUrl: 'https://api.happier.dev?token=abc',
        publicServerUrl: 'https://api.happier.dev?token=abc',
        webappUrl: 'https://app.happier.dev?token=abc',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
      },
    },
    lastChangesCursorByServerIdByAccountId: {
      cloud: {
        acct_old: 10,
      },
    },
  })),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerId: 'stack_main__id_default',
    serverUrl: 'http://127.0.0.1:3005',
    publicServerUrl: 'http://127.0.0.1:3005',
    webappUrl: 'http://127.0.0.1:3005',
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: () => readCredentialsMock(),
  readSettings: () => readSettingsMock(),
}));

import { buildDoctorSnapshot } from './doctorSnapshot';

describe('buildDoctorSnapshot', () => {
  it('includes active server, settings server profiles, and decoded account id', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'acct_123' })).toString('base64url');
    readCredentialsMock.mockResolvedValueOnce({ token: `header.${payload}.sig` });

    const snapshot = await buildDoctorSnapshot();

    expect(snapshot.server.activeServerId).toBe('stack_main__id_default');
    expect(snapshot.server.serverUrl).toBe('http://127.0.0.1:3005');
    expect(snapshot.settings.activeServerId).toBe('cloud');
    expect(snapshot.settings.servers.map((entry) => entry.id)).toContain('cloud');
    expect(snapshot.accountId).toBe('acct_123');
    expect(JSON.stringify(snapshot)).not.toContain('?token=');
  });
});

