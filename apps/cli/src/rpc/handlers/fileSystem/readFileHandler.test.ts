import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FilesystemReadFileOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { registerReadFileHandler } from './readFileHandler';
import { createFilesystemEffectAdmission } from './accessPolicy/filesystemEffectAdmission';
import { registerFileSystemHandlers } from './registerFileSystemHandlers';
import { bindProcessLogger, Logger } from '@/ui/logger';

const filesystemBoundary = vi.hoisted(() => ({ truncateOnReadPath: null as string | null,
  afterReadPath: null as string | null, afterRead: null as (() => void) | null }));
// The OS read boundary truncates a real file after the owner's stat. All path
// admission, range handling, EOF decisions and returned schemas remain real.
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const bytes = await actual.readFile(...args);
    if (args[0] === filesystemBoundary.afterReadPath) filesystemBoundary.afterRead?.();
    return bytes;
  }, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    if (args[0] !== filesystemBoundary.truncateOnReadPath) return file;
    return new Proxy(file, { get(target, key) {
      if (key === 'read') return async (...readArgs: unknown[]) => {
        await actual.truncate(args[0], 1);
        return Reflect.apply(target.read, target, readArgs);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});

describe('readFile ranged RPC', () => {
  it('records only a closed admission phase for a refused member without disclosing or changing private bytes', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-refusal-'));
    const path = join(rootPath, 'private-fixture-name.txt');
    const logPath = join(rootPath, 'refusal.log');
    await writeFile(path, 'private-fixture-contents');
    await writeFile(logPath, '');
    const fileLogger = new Logger({ logFilePath: logPath, allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
    const restoreLogger = bindProcessLogger(fileLogger);
    const handlers = new Map<string, RpcHandler>();
    registerReadFileHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
      workingDirectory: rootPath, accessPolicy: { kind: 'osUser' }, getAdditionalAllowedReadDirs: () => [],
      effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
    });
    try {
      const response = await handlers.get('daemon.filesystem.readFile')!({ rootPath, path }, {
        signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'private-member-account', custodianAccountId: 'private-owner-account',
          machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true,
      });
      expect(response).toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
      expect(response).not.toHaveProperty('content');
      fileLogger.flushSync();
      const log = await readFile(logPath, 'utf8');
      expect(log).toContain('"phase":"filesystem_effect_admission"');
      expect(log).toContain('"reason":"requester_identity_unavailable"');
      expect(log).toContain('"code":"filesystem_identity_custody_unavailable"');
      for (const privateValue of [rootPath, 'private-fixture-name', 'private-fixture-contents', 'private-member-account', 'private-owner-account']) {
        expect(log).not.toContain(privateValue);
      }
      expect(await readFile(path, 'utf8')).toBe('private-fixture-contents');
    } finally { restoreLogger(); await rm(rootPath, { recursive: true, force: true }); }
  });
  it.each(['present_user', 'account_automation'] as const)('finishes an admitted %s read without re-verifying Home', async callerAuthority => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-read-currentness-'));
    const handlers = new Map<string, RpcHandler>();
    registerReadFileHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
      workingDirectory: rootPath, accessPolicy: { kind: 'osUser' }, getAdditionalAllowedReadDirs: () => [],
      effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
    });
    let checks = 0;
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority,
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation',
        role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => { checks++; return false; } };
    try {
      const path = join(rootPath, 'ordinary.txt');
      await writeFile(path, 'ordinary fixture');
      filesystemBoundary.afterReadPath = path;
      const response = await handlers.get('daemon.filesystem.readFile')!({ rootPath, path }, context);
      expect(response).toMatchObject({ success: true, content: Buffer.from('ordinary fixture').toString('base64') });
      expect(checks).toBe(0);
    } finally {
      filesystemBoundary.afterReadPath = null; filesystemBoundary.afterRead = null;
      await rm(rootPath, { recursive: true, force: true });
    }
  });
  it('returns no bytes when the local signal is cancelled during the OS read', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-read-cancel-'));
    const handlers = new Map<string, RpcHandler>();
    registerReadFileHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
      workingDirectory: rootPath, accessPolicy: { kind: 'osUser' }, getAdditionalAllowedReadDirs: () => [],
      effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
    });
    const controller = new AbortController();
    try {
      const path = join(rootPath, 'ordinary.txt');
      await writeFile(path, 'cancelled fixture');
      filesystemBoundary.afterReadPath = path;
      filesystemBoundary.afterRead = () => { controller.abort(); };
      const response = await handlers.get('daemon.filesystem.readFile')!({ rootPath, path }, {
        signal: controller.signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
          installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true,
      });
      expect(response).toMatchObject({ success: false });
      expect(response).not.toHaveProperty('content');
    } finally {
      filesystemBoundary.afterReadPath = null; filesystemBoundary.afterRead = null;
      await rm(rootPath, { recursive: true, force: true });
    }
  });
  it('refuses a member through every inline filesystem alias before effects', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-aliases-'));
    const handlers = new Map<string, RpcHandler>();
    const registration = registerFileSystemHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, rootPath, {
      accessPolicy: { kind: 'osUser' },
      effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
    });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const candidates = [
      ['daemon.filesystem.readFile', { rootPath, path: 'fixture.txt' }],
      ['daemon.filesystem.writeFile', { rootPath, path: 'fixture.txt', content: Buffer.from('replacement').toString('base64') }],
      ['daemon.filesystem.listDirectory', { rootPath, path: '.' }],
      ['daemon.filesystem.getDirectoryTree', { rootPath, path: '.', maxDepth: 1 }],
      ['daemon.filesystem.createDirectory', { rootPath, path: 'new-directory' }],
      ['daemon.filesystem.rename', { rootPath, from: 'fixture.txt', to: 'renamed.txt', overwrite: false }],
      ['daemon.filesystem.delete', { rootPath, path: 'fixture.txt', recursive: false }],
      ['daemon.filesystem.copy', { rootPath, from: 'fixture.txt', to: 'copied.txt', overwrite: false, recursive: false }],
    ] as const;
    try {
      await writeFile(join(rootPath, 'fixture.txt'), 'ordinary fixture');
      for (const [actionId, input] of candidates) {
        const spec = getActionSpec(actionId);
        for (const method of [spec.bindings?.rpcMethod, ...(spec.bindings?.rpcMethodAliases ?? [])]) {
          if (!method) continue;
          const handler = handlers.get(method);
          if (!handler) throw new Error(`Missing filesystem registration: ${method}`);
          const response = await handler(input, context);
          expect({ success: response.success, errorCode: response.errorCode }).toEqual({
            success: false, errorCode: 'filesystem_identity_custody_unavailable',
          });
          expect(spec.outputSchema?.safeParse(response).success).toBe(true);
        }
      }
      const stat = handlers.get(RPC_METHODS.STAT_FILE);
      if (!stat) throw new Error('Missing filesystem stat registration');
      expect(await stat({ path: join(rootPath, 'fixture.txt'), includeContentHash: true }, context))
        .toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
      expect((await readFile(join(rootPath, 'fixture.txt'), 'utf8')) === 'ordinary fixture').toBe(true);
    } finally { await registration.dispose(); await rm(rootPath, { recursive: true, force: true }); }
  });
  it.each(['daemon.filesystem.readFile', RPC_METHODS.READ_FILE])('refuses a member and copied owner Agent context before private file IO through %s', async method => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-identity-'));
    const handlers = new Map<string, RpcHandler>();
    registerReadFileHandler({ registerHandler: (name, handler) => { handlers.set(name, handler); } }, {
      workingDirectory: rootPath, accessPolicy: { kind: 'osUser' }, getAdditionalAllowedReadDirs: () => [rootPath],
      effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
    });
    const read = handlers.get(method);
    if (!read) throw new Error('Missing file read handler');
    const owner: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    try {
      await writeFile(join(rootPath, 'private.txt'), 'fixture-private-bytes', { mode: 0o600 });
      for (const context of [
        { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'member' } },
        { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'member', role: 'manage' as const } },
        { ...owner, callerAuthority: 'account_automation' as const,
          machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'member', role: 'manage' as const } },
        { ...owner, callerAuthority: 'account_automation' as const, localActionContext: { actionCaller: {
          kind: 'session' as const, sessionId: 'owner-agent-session', starterDepth: 0, turnDepth: 0 } } },
        { ...owner, sessionActionOrigin: { v: 1 as const,
          caller: { kind: 'session' as const, sessionId: 'copied-owner-session', starterDepth: 0, turnDepth: 0 },
          sourceTurnId: 'agent-turn', callerPermissionMode: null, requestId: 'copied-owner-read' } },
      ]) {
        for (const input of [{ rootPath, path: 'private.txt' }, { path: join(rootPath, 'private.txt') }, { path: 'private.txt' }]) {
          const response = await read(input, context);
          expect({ success: response.success, errorCode: response.errorCode }).toMatchObject({
            success: false, errorCode: 'filesystem_identity_custody_unavailable',
          });
        }
      }
      expect(await read({ rootPath, path: 'private.txt' }, owner)).toMatchObject({ success: true });
      for (const input of [{ rootPath, path: 'private.txt' }, { path: join(rootPath, 'private.txt') }, { path: 'private.txt' }]) {
        expect(await read(input, { ...owner, callerAuthority: 'account_automation' })).toMatchObject({ success: true });
      }
      expect(await read({ rootPath, path: 'private.txt' }, { ...owner, verifyMachineAdmissionCurrent: undefined }))
        .toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });
  it('refuses bytes from a file truncated during the range read instead of reporting stale EOF metadata', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-ranged-read-truncate-'));
    const handlers = new Map<string, RpcHandler>();
    registerReadFileHandler({ registerHandler: (name, handler) => { handlers.set(name, handler); } }, {
      workingDirectory: rootPath, accessPolicy: { kind: 'osUser' }, getAdditionalAllowedReadDirs: () => [],
    });
    const read = handlers.get('daemon.filesystem.readFile');
    if (!read) throw new Error('Missing file read handler');
    try {
      await writeFile(join(rootPath, 'changing.bin'), Buffer.from('abcdef'));
      filesystemBoundary.truncateOnReadPath = join(rootPath, 'changing.bin');
      expect(await read({ rootPath, path: 'changing.bin', offset: 2, length: 3 })).toMatchObject({
        success: false, error: 'File changed during download. Try again',
      });
    } finally {
      filesystemBoundary.truncateOnReadPath = null;
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.each(['daemon.filesystem.readFile', RPC_METHODS.READ_FILE])('reads bounded slices through %s including a file above the whole-read cap', async method => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-ranged-read-'));
    const handlers = new Map<string, RpcHandler>();
    registerReadFileHandler({ registerHandler: (name, handler) => { handlers.set(name, handler); } }, {
      workingDirectory: rootPath, accessPolicy: { kind: 'osUser' }, getAdditionalAllowedReadDirs: () => [],
    });
    const read = handlers.get(method);
    if (!read) throw new Error(`Missing read handler ${method}`);
    const bytes = Buffer.alloc(configuration.filesReadMaxBytes + 8, 0x61);
    Buffer.from([0x00, 0xff, 0x80, 0x41]).copy(bytes, 3);
    try {
      await writeFile(join(rootPath, 'large.bin'), bytes);
      const input = method === RPC_METHODS.READ_FILE ? { path: 'large.bin' } : { rootPath, path: 'large.bin' };
      expect(await read(input)).toMatchObject({ success: false });
      const slice = FilesystemReadFileOutputSchema.parse(await read({ ...input, offset: 3, length: 4 }));
      expect(slice).toEqual({ success: true, content: bytes.subarray(3, 7).toString('base64'), sizeBytes: bytes.length, eof: false });
      expect(await read({ ...input, offset: bytes.length - 2, length: 4 })).toEqual({
        success: true, content: bytes.subarray(-2).toString('base64'), sizeBytes: bytes.length, eof: true,
      });
      expect(await read({ ...input, offset: bytes.length + 9, length: 4 })).toEqual({
        success: true, content: '', sizeBytes: bytes.length, eof: true,
      });
      expect(await read({ ...input, offset: 0, length: configuration.filesReadMaxBytes + 1 })).toMatchObject({ success: false });
      const atCap = FilesystemReadFileOutputSchema.parse(await read({ ...input, length: configuration.filesReadMaxBytes }));
      expect(atCap).toMatchObject({ success: true, sizeBytes: bytes.length, eof: false });
      if (!atCap.success) throw new Error(atCap.error);
      expect(Buffer.from(atCap.content, 'base64').equals(bytes.subarray(0, configuration.filesReadMaxBytes))).toBe(true);
      expect(await read({ ...input, length: 4 })).toEqual({
        success: true, content: bytes.subarray(0, 4).toString('base64'), sizeBytes: bytes.length, eof: false,
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
