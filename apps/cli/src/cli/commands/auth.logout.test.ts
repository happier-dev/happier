import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const terminal = vi.hoisted(() => ({ answer: 'y' }));
// The terminal is a system boundary; logout and the SkillStore stay real.
vi.mock('node:readline', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    createInterface: () => Object.assign(new EventEmitter(), {
      question: (_prompt: string, cb: (answer: string) => void) => cb(terminal.answer),
      close: () => {},
    }),
  };
});

import { reloadConfiguration } from '@/configuration';
import { readAccountChangesCursors, readSettings } from '@/persistence';
import { spawnStoppableHttpDaemon, withConfiguredDaemonTestHome, writeDaemonStateFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { reserveEphemeralPort, waitForHttpReady } from '@/testkit/http/portUtils';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { createSkillStore } from '@/prompts/skills/store/skillStore';

import { handleAuthCommand } from './auth';

async function materializeLogoutSkill(homeDir: string) {
  const store = createSkillStore({ happyHomeDir: homeDir });
  const files = [
    { path: 'SKILL.md', contentKind: 'utf8' as const, contentBase64: Buffer.from('Logout fixture skill').toString('base64') },
    { path: 'scripts/run.sh', contentKind: 'utf8' as const, contentBase64: Buffer.from('#!/bin/sh\ntrue\n').toString('base64'), unixMode: 0o755 },
  ];
  const digest = computePromptBundleDigestV1({ v: 1, entries: files, createdAtMs: 0, updatedAtMs: 0 });
  const materialized = await store.ensureSkillSessionDir({ ownerKey: 'logout-session', nativeDisables: [],
    items: [{ skillId: 'logout-skill', name: 'logout-skill', files, digest }] });
  expect(materialized.failed).toEqual([]);
  return { store, cachePath: join(homeDir, 'skills', 'cache', digest.slice(7)) };
}

describe('happier auth logout', () => {
  beforeEach(() => { terminal.answer = 'y'; });

  it.each([{ answer: 'y', removed: true }, { answer: 'n', removed: false }])(
    'retires immutable SkillStore data only after logout-all consent ($answer), without following outside links',
    async ({ answer, removed }) => {
      const outside = await mkdtemp(join(tmpdir(), 'happier-logout-outside-'));
      const sentinel = join(outside, 'keep.txt');
      await writeFile(sentinel, 'outside the selected profile');
      try {
        await withConfiguredDaemonTestHome({ prefix: 'auth-logout-immutable-' }, async ({ homeDir }) => {
          const { store, cachePath } = await materializeLogoutSkill(homeDir);
          await symlink(outside, join(homeDir, 'skills', 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
          if (process.platform !== 'win32') expect((await stat(cachePath)).mode & 0o222).toBe(0);
          terminal.answer = answer;
          try {
            await handleAuthCommand(['logout', '--all']);
            expect(existsSync(homeDir)).toBe(!removed);
            expect(existsSync(cachePath)).toBe(!removed);
            expect(await readFile(sentinel, 'utf8')).toBe('outside the selected profile');
          } finally {
            // Existing store retirement paths also clean up an intentional RED.
            await store.releaseSkillSessionDirs('logout-session');
            await store.collectSkillCache({ libraryDigests: [] });
          }
        });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it('keeps the home and credentials when logout-all cannot confirm daemon shutdown', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'auth-logout-incomplete-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 500, { controlToken: 'logout-fixture-token' });
      const statePath = await writeDaemonStateFixture(homeDir, 'removed', { pid: child.pid, httpPort: port, controlToken: 'logout-fixture-token' });
      const credentialsPath = join(homeDir, 'servers', 'removed', 'access.key');
      await writeFile(credentialsPath, 'preserve-me');
      const { store, cachePath } = await materializeLogoutSkill(homeDir);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        await expect(handleAuthCommand(['logout', '--all'])).rejects.toThrow(/daemon stop is incomplete/i);
        expect(existsSync(statePath)).toBe(true);
        expect(await readFile(credentialsPath, 'utf8')).toBe('preserve-me');
        expect(existsSync(cachePath)).toBe(true);
        expect(process.kill(child.pid, 0)).toBe(true);
      } finally {
        await child.kill();
        await store.releaseSkillSessionDirs('logout-session');
        await store.collectSkillCache({ libraryDigests: [] });
      }
    });
  });

  it('logs out only from the active server by default', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-auth-logout-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const prevActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;

      mkdirSync(join(home, 'servers', 'cloud'), { recursive: true });
      mkdirSync(join(home, 'servers', 'company'), { recursive: true });

      await writeFile(
        join(home, 'servers', 'cloud', 'access.key'),
        JSON.stringify({ token: 'tok_cloud', secret: Buffer.from('x').toString('base64') }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(home, 'servers', 'company', 'access.key'),
        JSON.stringify({ token: 'tok_company', secret: Buffer.from('y').toString('base64') }, null, 2),
        'utf-8',
      );

      const settings = {
        schemaVersion: 5,
        onboardingCompleted: false,
        activeServerId: 'cloud',
        servers: {
          cloud: {
            id: 'cloud',
            name: 'Happier Cloud',
            serverUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
          company: {
            id: 'company',
            name: 'Company',
            serverUrl: 'https://company.example.test',
            webappUrl: 'https://company.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
        machineIdByServerId: { cloud: 'mid_cloud', company: 'mid_company' },
        machineIdConfirmedByServerByServerId: { cloud: true, company: true },
        lastChangesCursorByServerIdByAccountId: { cloud: { a: 1 }, company: { a: 2 } },
      };
      await writeFile(join(home, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');

      reloadConfiguration();
      await handleAuthCommand(['logout']);

      expect(existsSync(join(home, 'servers', 'cloud', 'access.key'))).toBe(false);
      expect(existsSync(join(home, 'servers', 'company', 'access.key'))).toBe(true);

      const next = await readSettings();
      expect(next.machineIdByServerId?.cloud).toBeUndefined();
      expect(next.machineIdByServerId?.company).toBe('mid_company');
      const cursors = await readAccountChangesCursors();
      expect(cursors.cloud).toBeUndefined();
      expect(cursors.company?.a).toBe(2);

      // Company credentials file content is preserved.
      const companyRaw = JSON.parse(await readFile(join(home, 'servers', 'company', 'access.key'), 'utf-8'));
      expect(companyRaw.token).toBe('tok_company');
    } finally {
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      if (prevActiveServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      else process.env.HAPPIER_ACTIVE_SERVER_ID = prevActiveServerId;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });
});
