import { withSavedSecretMaterializer } from '@/settings/secrets/savedSecretCatalog.testkit';
import { createServer, type IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ensureAcpLaunchForSession, getAcpManagedInstallId, resolveAcpLaunch } from './resolveAcpLaunch';
import { resolveConfiguredAcpBackendFromAccountSettings } from './resolveBackend';
import { materializeConfiguredAcpEnvironment } from './materializeEnvironment';
import { normalizeConfiguredAcpDefinition } from '@/agent/acp/runtime/definition/configured';
import { resolveAcpRuntimeLaunch } from '@/agent/acp/runtime/definition/launch';

const transport = vi.hoisted(() => ({ origin: '' }));
// Route the registry's HTTPS download to a local HTTP fixture. The downloader,
// checksum, staging, adapter dispatch and promotion remain real internal logic.
vi.mock('node:https', async () => {
  const actual = await vi.importActual<typeof import('node:https')>('node:https');
  const http = await vi.importActual<typeof import('node:http')>('node:http');
  return { ...actual, request(url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) {
    return url.hostname === 'fixture-agent.invalid'
      ? http.request(new URL(url.pathname, transport.origin), options, callback)
      : actual.request(url, options, callback);
  } };
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const capabilities = { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' };

describe('admitted configured ACP launch on first use', () => {
  it.skipIf(process.platform === 'win32')('keeps the running old version on pin change and isolates the same definition across Accounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-acp-account-version-')); roots.push(root);
    const server = createServer((_request, response) => response.end('#!/bin/sh\nif [ "$1" = hold ]; then read value; fi\nprintf "ready"\n'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    let running: ReturnType<typeof spawn> | undefined;
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      transport.origin = `http://127.0.0.1:${address.port}`;
      const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
        id: 'same-agent', name: 'same-agent', title: 'Same agent', createdAt: 1, updatedAt: 1,
        launch: { kind: 'archive', version: '1.0', assetsByPlatform: {
          [`${process.platform}-${process.arch}`]: { archiveUrl: 'https://fixture-agent.invalid/agent', executableSubpath: 'agent', kind: 'executable' },
        } },
      }] });
      const definition = record.definitions[0]!;
      const params = { accountId: 'alice', definition, platform: process.platform, arch: process.arch,
        env: { ...process.env, HAPPIER_HOME_DIR: root }, settings: accountSettingsParse({}), machineId: 'fixture-machine' };
      const old = await ensureAcpLaunchForSession(params);
      running = spawn(old.command, ['hold'], { stdio: ['pipe', 'pipe', 'pipe'] });
      await once(running, 'spawn');
      if (definition.launch.kind !== 'archive') throw new Error('Expected archive');
      const next = await ensureAcpLaunchForSession({ ...params, definition: { ...definition, launch: { ...definition.launch, version: '2.0' } } });
      expect.soft(next.command).not.toBe(old.command);
      await expect(access(old.command)).resolves.toBeUndefined();
      expect(running.exitCode).toBeNull();
      expect.soft(await resolveAcpLaunch(params)).toMatchObject({ kind: 'ready', command: old.command });
      const foreign = await ensureAcpLaunchForSession({ ...params, accountId: 'bob' });
      expect.soft(foreign.command).not.toBe(old.command);
      await expect(access(old.command)).resolves.toBeUndefined();
      await expect(access(next.command)).resolves.toBeUndefined();
    } finally {
      if (running) { const ended = once(running, 'exit'); running.stdin?.end('stop\n'); await ended; }
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it.skipIf(process.platform === 'win32')('installs an archive absent from the global registry and executes its managed command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-acp-first-use-')); roots.push(root);
    const server = createServer((_request, response) => { response.end('#!/bin/sh\nprintf "archive-ready:%s:%s:%s" "$1" "$VT_ACP_ENABLED" "$VT_ACP_ZED_ENABLED"\n'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      transport.origin = `http://127.0.0.1:${address.port}`;
      const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
        id: 'first-use-archive', name: 'first-use-archive', title: 'First use archive',
        env: { VT_ACP_ENABLED: { t: 'literal', v: '0' } }, capabilities, createdAt: 1, updatedAt: 1,
        launch: { kind: 'archive', version: '1.2.3', args: ['--acp'], assetsByPlatform: {
          [`${process.platform}-${process.arch}`]: { archiveUrl: 'https://fixture-agent.invalid/agent', executableSubpath: 'agent', kind: 'executable' },
        }, envByPlatform: { [`${process.platform}-${process.arch}`]: { VT_ACP_ENABLED: '1', VT_ACP_ZED_ENABLED: '1' } } },
      }] });
      const params = { accountId: 'alice', definition: record.definitions[0]!, platform: process.platform, arch: process.arch, env: { ...process.env, HAPPIER_HOME_DIR: root }, settings: accountSettingsParse({}), machineId: 'fixture-machine' };
      expect(await resolveAcpLaunch(params)).toMatchObject({ kind: 'needs_install' });
      const launch = await ensureAcpLaunchForSession(params);
      expect(launch.command).toContain(join(root, 'tools', `dep.${getAcpManagedInstallId(params.definition, 'alice')}`, 'current'));
      const backend = resolveConfiguredAcpBackendFromAccountSettings({}, params.definition.id,
        { status: 'ready', revision: 1, record });
      if (!backend) throw new Error('Missing configured backend');
      const resolved = await resolveAcpRuntimeLaunch({ cwd: root, definition: normalizeConfiguredAcpDefinition({
        backend, launch, launchEnv: materializeConfiguredAcpEnvironment(withSavedSecretMaterializer({ backend, accountSettings: {}, processEnv: params.env })),
      }) });
      const result = await promisify(execFile)(resolved.command, [...resolved.args], { env: { ...params.env, ...resolved.env } });
      expect(result.stdout).toBe('archive-ready:--acp:0:1');
      expect(await ensureAcpLaunchForSession(params)).toEqual(launch);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it.skipIf(process.platform === 'win32')('installs pinned npm through the existing managed installer and executes the declared bin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-acp-npm-first-use-')); roots.push(root);
    const pnpm = join(root, 'pnpm'); await writeFile(pnpm, '#!/bin/sh\nexit 0\n'); await chmod(pnpm, 0o755);
    const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
      id: 'first-use-npm', name: 'first-use-npm', title: 'First use npm', env: {}, capabilities, createdAt: 1, updatedAt: 1,
      launch: { kind: 'npm', package: '@fixture/agent', version: '1.2.3', args: ['--acp'] },
    }] });
    const params = { accountId: 'alice', definition: record.definitions[0]!, platform: process.platform, arch: process.arch,
      env: { ...process.env, HAPPIER_HOME_DIR: join(root, "home's $literal"), HAPPIER_PNPM_BIN: pnpm, HAPPIER_JS_RUNTIME_PATH: process.execPath }, settings: accountSettingsParse({}), machineId: 'fixture-machine' };
    const launch = await ensureAcpLaunchForSession(params, { installerDeps: {
      // Fake only the external package-manager process; real installer writes
      // and promotes its launcher and workspace around this package output.
      execFileWithDeadline: async (_command, args) => {
        expect(args[3]).toBe('@fixture/agent@1.2.3');
        const workspace = args[1]!;
        const packageRoot = join(workspace, 'node_modules', '@fixture', 'agent');
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@fixture/agent', version: '1.2.3', bin: { 'actual-agent': 'agent.js' } }));
        const bin = join(workspace, 'node_modules', '.bin', 'actual-agent');
        await mkdir(join(workspace, 'node_modules', '.bin'), { recursive: true });
        await writeFile(bin, '#!/bin/sh\nprintf "npm-ready:%s" "$1"\n'); await chmod(bin, 0o755);
        return { stdout: '', stderr: '' };
      },
    } });
    const result = await promisify(execFile)(launch.command, [...launch.args], { env: params.env });
    expect(result.stdout).toBe('npm-ready:--acp');
    expect(await ensureAcpLaunchForSession(params)).toEqual(launch);
  });
});
