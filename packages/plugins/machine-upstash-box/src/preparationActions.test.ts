import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';

const choices = { runtime: 'node', size: 'small' } as const;
const provider = { pluginId: 'happier.machine.upstash-box', localId: 'upstash-box' };
const input = { operationId: 'build-one', input: { launch: { provider, schemaVersion: 1, choices },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/workspace/home/cli/happier',
    installScript: 'printf install', files: [{ path: 'payload.tar.gz', contentsBase64: 'AAECAw==' }] }, setupScript: 'printf setup' } };

function vendor() {
  const home = mkdtempSync(join(tmpdir(), 'upstash-prepare-'));
  const bin = join(home, 'bin'); mkdirSync(bin);
  // Native OS boundary: Upstash runs as boxuser with passwordless sudo.
  writeFileSync(join(bin, 'id'), '#!/bin/sh\nif [ "$1" = -u ]; then printf "%s\\n" "${FIXTURE_UID:-1002}"; else /usr/bin/id "$@"; fi\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] || exit 1\nshift\n[ "$1" != -- ] || shift\nexport FIXTURE_UID=0\nexec "$@"\n', { mode: 0o755 });
  let source = false, status = 'idle', snapshot = false, snapshotStatus = 'creating', env: Record<string, string> = {};
  let lostCreate = false, lostSnapshot = false, mismatch = false, lostDelete = false;
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const dto = () => ({ id: 'builder-id', name: 'happier-prepared-build-one', labels: ['happier-managed'], status });
  const services = {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { 'x-box-api-key': 'fixture-key' } }) },
    http: { request: async (request: { url: string; method: string; body?: Uint8Array }) => {
      const path = new URL(request.url).pathname, method = request.method;
      const body = request.body ? JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown> : {};
      calls.push({ method, path, body });
      const response = (code: number, value: unknown) => ({ status: code, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });
      if (path === '/v2/box/settings/env') return response(200, { env_vars: env });
      if (method === 'POST' && path === '/v2/box') { source = true; if (lostCreate) throw new Error('lost response'); return response(200, dto()); }
      if (path.endsWith('/exec')) {
        const command = body.command;
        if (!Array.isArray(command) || !command.every(value => typeof value === 'string')) throw new Error('Invalid fixture command');
        const result = spawnSync(command[0], command.slice(1), { env: { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH } });
        return response(200, { exit_code: result.status, output: result.stdout.toString(), error: result.stderr.toString() });
      }
      if (path.endsWith('/files/write')) {
        if (typeof body.path !== 'string' || typeof body.content !== 'string') throw new Error('Invalid fixture file');
        mkdirSync(join(body.path, '..'), { recursive: true }); writeFileSync(body.path, Buffer.from(body.content, 'base64'));
        return response(200, {});
      }
      if (path.endsWith('/pause')) { status = 'paused'; return response(200, {}); }
      if (path.endsWith('/snapshots') && method === 'POST') { snapshot = true; if (lostSnapshot) throw new Error('lost response'); }
      if (path.endsWith('/snapshots')) {
        const native = { id: 'snapshot-id', box_id: mismatch ? 'foreign-box' : 'builder-id', name: dto().name, status: snapshotStatus, size_bytes: 42, created_at: 1000 };
        return response(200, method === 'POST' ? native : { snapshots: snapshot ? [native] : [] });
      }
      if (path.endsWith('/snapshots/snapshot-id') && method === 'DELETE') { if (!lostDelete) snapshot = false; return response(200, {}); }
      if (method === 'DELETE') { source = false; return response(200, {}); }
      if (path === '/v2/box/builder-id' || path === '/v2/box/' + dto().name) return response(source ? 200 : 404, source ? dto() : { error: 'not found' });
      throw new Error('Unexpected path ' + method + ' ' + path);
    } },
  } as unknown as PluginTestServicesFixture;
  return { services, calls, home, cleanup() { rmSync(home, { recursive: true, force: true }); }, ready() { snapshotStatus = 'ready'; }, lostCreate() { lostCreate = true; }, lostSnapshot() { lostSnapshot = true; },
    mismatch() { mismatch = true; }, deferDelete() { lostDelete = true; }, deleted() { snapshot = false; }, env() { env = { SECRET: 'masked' }; }, present: () => ({ source, snapshot }) };
}

describe('Upstash preparation through public Actions', () => {
  it('builds without credentials, pauses its source, recovers by operation only, and deletes both owned resources', async () => {
    const v = vendor(); const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const built = await kit.invokeAction('prepare-build', { ...input, input: { ...input.input,
        cli: { ...input.input.cli, binaryPath: join(v.home, 'workspace', 'cli', 'happier'),
          installScript: 'mkdir -p "$HOME/workspace/cli"; printf installed > "$HOME/workspace/cli/happier"' },
        setupScript: 'printf configured > "$HOME/configured"' } }, { surface: 'plugin' });
      expect(built).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { sourceBoxId: 'builder-id', snapshotId: 'snapshot-id' } } });
      expect(v.calls.find(call => call.method === 'POST' && call.path === '/v2/box')?.body).toEqual({ ...choices,
        name: 'happier-prepared-build-one', labels: ['happier-managed'], keep_alive: false });
      expect(v.calls.find(call => call.path.endsWith('/files/write'))?.body).toMatchObject({ content: 'AAECAw==', encoding: 'base64' });
      expect(JSON.stringify(v.calls)).not.toContain('fixture-key');
      expect(readFileSync(join(v.home, 'workspace', 'cli', 'happier'), 'utf8')).toBe('installed');
      expect(readFileSync(join(v.home, 'configured'), 'utf8')).toBe('configured');
      expect(v.calls.findIndex(call => call.path.endsWith('/pause'))).toBeLessThan(v.calls.findIndex(call => call.path.endsWith('/snapshots')));
      v.ready();
      const ready = await kit.invokeAction('prepare-inspect', { operationId: 'build-one', launch: choices }, { surface: 'plugin' });
      expect(ready).toMatchObject({ kind: 'ready', artifact: { value: { sourceBoxId: 'builder-id', snapshotId: 'snapshot-id', launch: { ...choices, snapshotId: 'snapshot-id' } } } });
      if (ready.kind !== 'ready') throw new Error('No artifact');
      expect(await kit.invokeAction('prepare-destroy', { artifact: ready.artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(v.present()).toEqual({ source: false, snapshot: false });
      expect(v.calls.filter(call => call.method === 'POST' && call.path === '/v2/box')).toHaveLength(1);
      expect(v.calls.filter(call => call.method === 'POST' && call.path.endsWith('/snapshots'))).toHaveLength(1);
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it('refuses account environment injection before creating a builder and never mutates global settings', async () => {
    const v = vendor(); v.env(); const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toEqual({ kind: 'refused', code: 'upstash_box_account_environment_present' });
      expect(v.calls).toEqual([{ method: 'GET', path: '/v2/box/settings/env', body: {} }]);
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it.each(['lostCreate', 'lostSnapshot'] as const)('recovers %s without replaying build or allocation', async failure => {
    const v = vendor(); v[failure](); const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toMatchObject({ kind: 'unknown' });
      v.ready();
      const recovered = await kit.invokeAction('prepare-inspect', { operationId: 'build-one', launch: choices }, { surface: 'plugin' });
      expect(recovered).toMatchObject({ kind: failure === 'lostSnapshot' ? 'ready' : 'failed' });
      if (!('nativeOperationRef' in recovered) && recovered.kind !== 'ready') throw new Error('Missing cleanup reference');
      const deletion = recovered.kind === 'ready' ? { artifact: recovered.artifact } : { nativeOperation: recovered.nativeOperationRef };
      expect(await kit.invokeAction('prepare-destroy', deletion, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(v.present()).toEqual({ source: false, snapshot: false });
      expect(v.calls.filter(call => call.method === 'POST' && call.path === '/v2/box')).toHaveLength(1);
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it('refuses a snapshot from another box before deleting anything', async () => {
    const v = vendor(); const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      if (result.kind !== 'pending') throw new Error('Missing operation');
      v.mismatch();
      expect(await kit.invokeAction('prepare-inspect', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toMatchObject({ kind: 'unknown', code: 'upstash_box_snapshot_identity_mismatch' });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'upstash_box_snapshot_identity_mismatch' });
      expect(v.calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it('retains the paused source while snapshot deletion remains unconfirmed', async () => {
    const v = vendor(); const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = await kit.invokeAction('prepare-build', input, { surface: 'plugin' });
      if (result.kind !== 'pending') throw new Error('Missing operation');
      v.deferDelete();
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'pending', nativeOperationRef: { value: { sourceBoxId: 'builder-id', snapshotId: 'snapshot-id' } } });
      expect(v.present()).toEqual({ source: true, snapshot: true });
      v.deleted();
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: result.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(v.present()).toEqual({ source: false, snapshot: false });
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it('preserves typed credential-boundary failures and redacts vendor response details', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect the account' });
    const services = { connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { 'x-box-api-key': 'fixture-key' } }) },
      http: { request: async () => { throw refusal; } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
    try { await expect(kit.invokeAction('prepare-build', input, { surface: 'plugin' })).rejects.toMatchObject({ data: refusal.data }); }
    finally { await kit.dispose(); }
  });

  it('retains failed setup exit status and sanitized stderr with its owned cleanup reference', async () => {
    const v = vendor(); const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      const result = await kit.invokeAction('prepare-build', { ...input, input: { ...input.input,
        setupScript: 'printf "install prerequisite failed" >&2; exit 19' } }, { surface: 'plugin' });
      expect(result).toMatchObject({ kind: 'unknown', code: 'upstash_box_preparation_exec_failed',
        nativeCause: { localCause: 'native_command_failed', exitCode: 19, stderr: 'install prerequisite failed' },
        nativeOperationRef: { value: { sourceBoxId: 'builder-id' } } });
      expect(v.calls.filter(call => call.method === 'POST' && call.path.endsWith('/snapshots'))).toHaveLength(0);
    } finally { await kit.dispose(); v.cleanup(); }
  });

  it('runs the existing root-only setup interpreter through the boxuser sudo boundary', async () => {
    const v = vendor(); const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: v.services });
    try {
      expect(await kit.invokeAction('prepare-build', { ...input, input: { ...input.input,
        cli: { ...input.input.cli, installScript: 'id -u > "$HOME/install-principal"' },
        setupScript: 'test "$(id -u)" = 0 || exit 77; printf root > "$HOME/setup-principal"' } }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'pending', nativeOperationRef: { value: { snapshotId: 'snapshot-id' } } });
      expect(readFileSync(join(v.home, 'install-principal'), 'utf8').trim()).toBe('1002');
      expect(readFileSync(join(v.home, 'setup-principal'), 'utf8')).toBe('root');
    } finally { await kit.dispose(); v.cleanup(); }
  });
});
