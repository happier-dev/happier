import { beforeEach, describe, expect, it, vi } from 'vitest';

import tweetnacl from 'tweetnacl';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import { reloadConfiguration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { encodeBase64, encrypt } from '@/api/encryption';
import { readSessionAttachFromEnv } from '@/agent/runtime/sessionAttach';
import { makeSessionFixtureRow } from '@/sessionControl/testFixtures';

import { handleResumeCommand } from './resume';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

describe('happier resume', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as any);

  beforeEach(() => {
    exitSpy.mockClear();
  });

  it('creates an attach file from dataEncryptionKey and dispatches to the session flavor command', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-resume-'));
    const directory = await mkdtemp(join(tmpdir(), 'happier-resume-dir-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevAttach = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const prevCwd = process.cwd();

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(11);
      const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
      const credentials: Credentials = {
        token: 'token-1',
        encryption: { type: 'dataKey', machineKey, publicKey },
      };

      const sessionEncryptionKey = new Uint8Array(32).fill(5);
      const envelope = sealEncryptedDataKeyEnvelopeV1({
        dataKey: sessionEncryptionKey,
        recipientPublicKey: publicKey,
        randomBytes: deterministicRandomBytesFactory(),
      });

      const rawSession = {
        ...makeSessionFixtureRow({
          id: 'sid_1',
          dataEncryptionKey: encodeBase64(envelope),
          metadata: encodeBase64(
            encrypt(sessionEncryptionKey, 'dataKey', {
              path: directory,
              host: 'test',
              flavor: 'codex',
            }),
          ),
          active: true,
          activeAt: 1,
        }),
      };

      const dispatched: { args: string[] }[] = [];
      const agentHandler = vi.fn(async (context: { args: string[] }) => {
        dispatched.push({ args: [...context.args] });
        expect(await realpath(process.cwd())).toBe(await realpath(directory));

        const attach = await readSessionAttachFromEnv();
        expect(attach).not.toBeNull();
        expect(attach?.encryptionVariant).toBe('dataKey');
        expect(Array.from(attach?.encryptionKey ?? [])).toEqual(Array.from(sessionEncryptionKey));
      });

      await handleResumeCommand(['sid_1'], {
        readCredentialsFn: async () => credentials,
        fetchSessionByIdFn: async () => rawSession,
        resolveAgentHandlerFn: async () => agentHandler as any,
        chdirFn: (next: string) => process.chdir(next),
      });

      expect(agentHandler).toHaveBeenCalledTimes(1);
      expect(dispatched[0]?.args[0]).toBe('codex');
      expect(dispatched[0]?.args).toContain('--existing-session');
      expect(dispatched[0]?.args).toContain('sid_1');
      expect(process.env.HAPPIER_SESSION_ATTACH_FILE ?? '').toBe('');
    } finally {
      try {
        process.chdir(prevCwd);
      } catch {
        // ignore
      }
      if (prevAttach === undefined) delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      else process.env.HAPPIER_SESSION_ATTACH_FILE = prevAttach;
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
