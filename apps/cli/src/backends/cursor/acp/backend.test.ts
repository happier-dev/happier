import { withParsedAcpExtensionHandler } from '@/agent/acp/testkit/extensionHandlerHarness';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientApp } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@/agent/core';

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

    expect(options.authentication).toEqual({ kind: 'static', methodId: 'cursor_login' });
  });

  it('negotiates Cursor model parameters for every ACP session', () => {
    process.env.PATH = '';
    process.env.HAPPIER_CURSOR_PATH = createFakeCursorAgent();

    const options = buildCursorAcpBackendOptions({ cwd: '/tmp', env: {} });
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

  it('relays generated-media extension messages through the provider backend event seam', async () => {
    process.env.PATH = '';
    process.env.HAPPIER_CURSOR_PATH = createFakeCursorAgent();
    const emitted: AgentMessage[] = [];
    const options = buildCursorAcpBackendOptions({
      cwd: '/tmp',
      env: {},
      permissionHandler: { async handleToolCall() { return { decision: 'approved' }; } },
    }, {
      emit: (message) => emitted.push(message),
    });
    const registration = options.extensionHandlers?.find(({ kind, method }) => (
      kind === 'request' && method === 'cursor/generate_image'
    ));
    if (!registration) throw new Error('missing Cursor generated-media request handler');
    let callback: ((context: Readonly<{ params: unknown; signal: AbortSignal }>) => unknown) | null = null;
    const app = {
      onRequest: (_method: string, parser: unknown, handler: typeof callback) => {
        callback = withParsedAcpExtensionHandler(parser, handler);
        return app;
      },
      onNotification: () => app,
    };
    registration.register(app as unknown as ClientApp, () => ({
      method: 'cursor/generate_image',
      sessionId: 'cursor-session-1',
      signal: new AbortController().signal,
      agentName: 'cursor',
    }));
    const invoke = callback as unknown as (context: Readonly<{ params: unknown; signal: AbortSignal }>) => Promise<unknown>;

    await invoke({
      params: { toolCallId: 'image-1', filePath: '/tmp/generated.png' },
      signal: new AbortController().signal,
    });

    expect(emitted).toMatchObject([{
      type: 'session-media',
      source: 'cursor-generate-image',
      media: [{ origin: { agentId: 'cursor', toolCallId: 'image-1' } }],
    }]);
  });
});
