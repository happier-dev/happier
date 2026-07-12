import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { buildInitializeRequest } from '@/agent/acp/AcpBackend';

import { buildCursorAcpBackendOptions } from './backend';
import { cursorTransport } from './transport';

const envKeys = ['PATH', 'HAPPIER_CURSOR_PATH', 'HAPPIER_CURSOR_API_ENDPOINT'] as const;
const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

function createFakeCursorAgent(): string {
  const dir = createTempDirSync('happier-cursor-backend-');
  tempDirs.add(dir);
  return writeExecutableShimSync({
    dir,
    fileName: process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent',
    contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
  });
}

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of tempDirs) removeTempDirSync(dir);
  tempDirs.clear();
});

describe('buildCursorAcpBackendOptions', () => {
  it('authenticates ACP sessions with the Cursor login method advertised by the real CLI', () => {
    process.env.PATH = '';
    process.env.HAPPIER_CURSOR_PATH = createFakeCursorAgent();

    const options = buildCursorAcpBackendOptions({ cwd: '/tmp', env: {} });

    expect(options.authentication).toEqual({
      kind: 'static',
      methodId: 'cursor_login',
    });
  });

  it('does not negotiate the Cursor parameterized model picker for normal runtime sessions', () => {
    process.env.PATH = '';
    process.env.HAPPIER_CURSOR_PATH = createFakeCursorAgent();

    const options = buildCursorAcpBackendOptions({ cwd: '/tmp', env: {} });
    const request = buildInitializeRequest({
      clientName: 'happier',
      clientVersion: '0.0.0',
      initializeClientCapabilitiesMeta: options.initializeClientCapabilitiesMeta,
    });

    expect(request.clientCapabilities?._meta).toBeUndefined();
  });

  it('can opt into the Cursor parameterized model picker for discovery probes', () => {
    process.env.PATH = '';
    process.env.HAPPIER_CURSOR_PATH = createFakeCursorAgent();

    const options = buildCursorAcpBackendOptions({
      cwd: '/tmp',
      env: {},
      parameterizedModelPicker: true,
    });
    const request = buildInitializeRequest({
      clientName: 'happier',
      clientVersion: '0.0.0',
      initializeClientCapabilitiesMeta: options.initializeClientCapabilitiesMeta,
    });

    expect(request.clientCapabilities?._meta).toEqual({
      parameterizedModelPicker: true,
    });
  });

  it('passes a configured Cursor API endpoint before the ACP subcommand', () => {
    process.env.PATH = '';
    process.env.HAPPIER_CURSOR_PATH = createFakeCursorAgent();

    const options = buildCursorAcpBackendOptions({
      cwd: '/tmp',
      env: { HAPPIER_CURSOR_API_ENDPOINT: '  https://cursor.example.test  ' },
    });

    expect((options.args ?? []).slice(-3)).toEqual(['-e', 'https://cursor.example.test', 'acp']);
  });

  it('passes Cursor full-access permission modes as the ACP-honored force launch flag', () => {
    process.env.PATH = '';
    process.env.HAPPIER_CURSOR_PATH = createFakeCursorAgent();

    const yoloOptions = buildCursorAcpBackendOptions({
      cwd: '/tmp',
      env: { HAPPIER_CURSOR_API_ENDPOINT: 'https://cursor.example.test' },
      permissionMode: 'yolo',
    });
    const bypassOptions = buildCursorAcpBackendOptions({
      cwd: '/tmp',
      env: { HAPPIER_CURSOR_API_ENDPOINT: 'https://cursor.example.test' },
      permissionMode: 'bypassPermissions',
    });

    expect(yoloOptions.args).toEqual(['-e', 'https://cursor.example.test', '--force', 'acp']);
    expect(bypassOptions.args).toEqual(['-e', 'https://cursor.example.test', '--force', 'acp']);
  });

  it('passes safe-yolo as force with Cursor sandbox enabled before the ACP subcommand', () => {
    process.env.PATH = '';
    process.env.HAPPIER_CURSOR_PATH = createFakeCursorAgent();

    const options = buildCursorAcpBackendOptions({
      cwd: '/tmp',
      env: { HAPPIER_CURSOR_API_ENDPOINT: 'https://cursor.example.test' },
      permissionMode: 'safe-yolo',
    });

    expect(options.args).toEqual(['-e', 'https://cursor.example.test', '--force', '--sandbox', 'enabled', 'acp']);
  });

  it('does not synthesize tool-call timeouts for Cursor ACP turns', () => {
    expect(cursorTransport.getToolCallTimeout('tool-call-1', 'execute')).toBeNull();
  });
});
