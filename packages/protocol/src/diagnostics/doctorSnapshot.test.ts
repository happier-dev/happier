import { describe, expect, it } from 'vitest';

import { DoctorSnapshotSchema, parseDoctorSnapshotSafe } from './doctorSnapshot.js';

describe('DoctorSnapshotSchema', () => {
  it('accepts a valid snapshot and parseDoctorSnapshotSafe redacts userinfo/query/hash', () => {
    const raw = JSON.stringify({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
        publicServerUrl: 'https://api.happier.dev/path?token=abc',
        webappUrl: 'https://app.happier.dev/?token=abc',
      },
      accountId: 'acct_123',
      settings: {
        activeServerId: 'cloud',
        servers: [
          {
            id: 'cloud',
            name: 'Happier Cloud',
            serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc',
            webappUrl: 'https://app.happier.dev/?token=abc',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        ],
        knownAccountIds: ['acct_123'],
      },
    });

    const parsed = parseDoctorSnapshotSafe(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');

    expect(DoctorSnapshotSchema.safeParse(parsed.snapshot).success).toBe(true);
    const serialized = JSON.stringify(parsed.snapshot);
    expect(serialized).not.toContain('admin:secret');
    expect(serialized).not.toContain('?token=');
    expect(serialized).not.toContain('#frag');
  });

  it('returns a stable error for invalid JSON', () => {
    const parsed = parseDoctorSnapshotSafe('{not json}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected error');
    expect(parsed.error).toMatch(/invalid json/i);
  });
});
