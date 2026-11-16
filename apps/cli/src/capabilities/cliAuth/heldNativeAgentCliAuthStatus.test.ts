import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, utimes, writeFile } from 'node:fs/promises';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { readHeldNativeAgentCliAuthStatus } from './heldNativeAgentCliAuthStatus';
import type { CliAuthSpec } from './types';

// The Agent's cliAuth hook declares where its sign-in is observable, and on which platforms.
const declared = { paths: ['~/.agent/credentials.json'], platforms: [process.platform] };

describe('held native Agent sign-in fact', () => {
  it('holds only the signed-in state, never the probe account label or identity', async () => {
    const dir = await createTempDir('happier-held-auth-', tmpdir());
    try {
      const cli = join(dir, 'agent-cli');
      await writeFile(cli, '#!/bin/sh\n');
      let probes = 0;
      // The Agent's own probe callback is the external boundary; it reports an identity.
      const authSpec: CliAuthSpec = { binaryNames: ['agent-cli'], isSafeForBackgroundChecks: true,
        detectAuthStatus: async () => {
          probes += 1;
          return { state: 'logged_in', source: 'command', accountLabel: 'person@example.com' };
        } };
      const read = async () => await readHeldNativeAgentCliAuthStatus({ agentId: 'held-auth-fixture', resolvedPath: cli,
        authSpec, processEnv: { HOME: dir }, authEnvironmentVariables: [] });

      await read();
      const held = await read();
      expect(probes).toBe(1);
      expect(held?.state).toBe('logged_in');
      expect(JSON.stringify(held)).not.toContain('person@example.com');
      expect(held).not.toHaveProperty('accountLabel');
    } finally {
      await removeTempDir(dir);
    }
  });

  it('remembers a signed-out answer until the Agent\'s declared sign-in state changes on disk', async () => {
    const dir = await createTempDir('happier-held-auth-', tmpdir());
    try {
      const cli = join(dir, 'agent-cli');
      await writeFile(cli, '#!/bin/sh\n');
      await mkdir(join(dir, '.agent'), { recursive: true });
      let probes = 0;
      let signedIn = false;
      const authSpec: CliAuthSpec = { binaryNames: ['agent-cli'], isSafeForBackgroundChecks: true, signInState: declared,
        detectAuthStatus: async () => {
          probes += 1;
          return signedIn ? { state: 'logged_in', source: 'command' } : { state: 'logged_out', reason: 'missing_credentials' };
        } };
      const read = async (fresh = false) => await readHeldNativeAgentCliAuthStatus({ agentId: 'held-auth-signed-out', resolvedPath: cli,
        authSpec, processEnv: { HOME: dir }, authEnvironmentVariables: [], fresh });

      for (let open = 0; open < 3; open++) expect((await read())?.state).toBe('logged_out');
      expect(probes).toBe(1);
      // A terminal sign-in writes the declared credential file: exactly one more check.
      signedIn = true;
      await writeFile(join(dir, '.agent', 'credentials.json'), '{}');
      expect((await read())?.state).toBe('logged_in');
      expect((await read())?.state).toBe('logged_in');
      expect(probes).toBe(2);
      // A sign-out that rewrites it is observed at once too.
      signedIn = false;
      const later = new Date(Date.now() + 60_000);
      await utimes(join(dir, '.agent', 'credentials.json'), later, later);
      expect((await read())?.state).toBe('logged_out');
      expect(probes).toBe(3);
      // An explicit refresh always checks.
      await read(true);
      expect(probes).toBe(4);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('remembers an unanswered status probe until the declared sign-in state changes', async () => {
    const dir = await createTempDir('happier-held-auth-', tmpdir());
    try {
      const cli = join(dir, 'agent-cli');
      await writeFile(cli, '#!/bin/sh\n');
      await mkdir(join(dir, '.agent'), { recursive: true });
      let probes = 0;
      const authSpec: CliAuthSpec = { binaryNames: ['agent-cli'], isSafeForBackgroundChecks: true, signInState: declared,
        detectAuthStatus: async () => { probes += 1; return { state: 'unknown', reason: 'probe_failed' }; } };
      const read = async () => await readHeldNativeAgentCliAuthStatus({ agentId: 'held-auth-unknown', resolvedPath: cli,
        authSpec, processEnv: { HOME: dir }, authEnvironmentVariables: [] });
      for (let open = 0; open < 3; open++) expect((await read())?.state).toBe('unknown');
      expect(probes).toBe(1);
      await writeFile(join(dir, '.agent', 'credentials.json'), '{}');
      await read(); await read();
      expect(probes).toBe(2);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('keeps checking where the Agent declares its sign-in unobservable on this platform (OS credential store)', async () => {
    const dir = await createTempDir('happier-held-auth-', tmpdir());
    try {
      const cli = join(dir, 'agent-cli');
      await writeFile(cli, '#!/bin/sh\n');
      let probes = 0;
      const otherPlatforms = (['darwin', 'linux', 'win32'] as const).filter((platform) => platform !== process.platform);
      const authSpec: CliAuthSpec = { binaryNames: ['agent-cli'], isSafeForBackgroundChecks: true,
        signInState: { paths: ['~/.agent/credentials.json'], platforms: otherPlatforms },
        detectAuthStatus: async () => { probes += 1; return { state: 'logged_out' }; } };
      const read = async () => await readHeldNativeAgentCliAuthStatus({ agentId: 'held-auth-keychain-platform', resolvedPath: cli,
        authSpec, processEnv: { HOME: dir }, authEnvironmentVariables: [] });
      for (let open = 0; open < 3; open++) await read();
      expect(probes).toBe(3);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('keeps checking a signed-out Agent whose sign-in writes nothing it declares on disk', async () => {
    const dir = await createTempDir('happier-held-auth-', tmpdir());
    try {
      const cli = join(dir, 'agent-cli');
      await writeFile(cli, '#!/bin/sh\n');
      let probes = 0;
      const authSpec: CliAuthSpec = { binaryNames: ['agent-cli'], isSafeForBackgroundChecks: true,
        detectAuthStatus: async () => { probes += 1; return { state: 'logged_out' }; } };
      const read = async () => await readHeldNativeAgentCliAuthStatus({ agentId: 'held-auth-keychain', resolvedPath: cli,
        authSpec, processEnv: { HOME: dir }, authEnvironmentVariables: [] });
      await read(); await read();
      expect(probes).toBe(2);
    } finally {
      await removeTempDir(dir);
    }
  });
});
