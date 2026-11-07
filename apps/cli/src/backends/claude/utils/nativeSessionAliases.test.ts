import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeNativeSessionAliases } from './nativeSessionAliases';

it('reads exact Claude assignment evidence from the owner-supplied sanitized 2026-10-28 registration snapshot', async () => {
  // Provenance: claude-registrations-snapshot-20261028.json supplied by the owner.
  // Copy only the required nonsecret registration fields; the temporary snapshot is not a runtime dependency.
  const registrations = [
    { name: 'happier-6e', sessionId: '8dfb9251-abaf-4592-9e5e-afa54023db0d', nameSince: 1793146034751, startedAt: 1793146034751 },
    { name: 'happier-90', sessionId: '6b39e4a0-18f4-4c94-bb09-bda0a07115b7', nameSince: 1793211062180, startedAt: 1793211062180 },
  ];
  const configDir = await mkdtemp(join(tmpdir(), 'claude-snapshot-alias-'));
  const observedAt = Date.parse('2026-10-28T21:27:00.000Z');
  try {
    await mkdir(join(configDir, 'sessions'));
    for (const [index, registration] of registrations.entries()) {
      await writeFile(join(configDir, 'sessions', `${index + 1}.json`), JSON.stringify(registration));
    }
    for (const registration of registrations) {
      expect(await readClaudeNativeSessionAliases({ configDir, sessionId: registration.sessionId, observedAt })).toEqual([{
        providerId: 'claude', providerSessionId: registration.sessionId, alias: registration.name,
        assignedAt: registration.nameSince, observedAt,
      }]);
    }
    expect(await readClaudeNativeSessionAliases({ configDir, sessionId: 'unrecoverable-eb', observedAt })).toEqual([]);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
