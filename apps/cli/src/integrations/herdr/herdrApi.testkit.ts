import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { withSocketTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

type ApiFault = 'error' | 'disconnect' | 'timeout';

/** The real client talks to this external Herdr socket boundary. No Happier logic is replaced. */
export async function withHerdrApi<T>(run: (api: Readonly<{
  socketPath: string;
  binary: string;
  faults: Map<string, ApiFault>;
  panes: Set<string>;
  tabs: Set<string>;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  beforeResponse: Map<string, () => void>;
  setEmpty(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}>) => Promise<T>, options: Readonly<{ serverVersion?: string; maxInitialRequestBytes?: number; socketPath?: string;
  response?: (method: string, params: Record<string, unknown>) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
}> = {}): Promise<T> {
  return await withSocketTempDir(async (directory) => {
    // Only the version probe crosses this executable boundary. All Herdr API
    // operations still use the real socket client and the server below.
    const binary = await writeExecutableShim({ dir: directory,
      fileName: process.platform === 'win32' ? 'herdr.cmd' : 'herdr',
      contents: process.platform === 'win32'
        ? '@echo off\r\nif "%1"=="--version" (echo herdr 0.9.2 & exit /b 0)\r\nexit /b 1\r\n'
        : '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "herdr 0.9.2"\n  exit 0\nfi\nexit 1\n',
    });
    const socketPath = options.socketPath ?? (process.platform === 'win32'
      ? `\\\\.\\pipe\\happier-herdr-test-${randomUUID()}`
      : join(directory, 'api.sock'));
    if (process.platform !== 'win32') await mkdir(dirname(socketPath), { recursive: true });
    const faults = new Map<string, ApiFault>();
    const panes = new Set<string>();
    const tabs = new Set<string>();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const beforeResponse = new Map<string, () => void>();
    const sockets = new Set<Socket>();
    let empty = false;
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', async (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (options.maxInitialRequestBytes !== undefined
          && Buffer.byteLength(newline < 0 ? buffer : buffer.slice(0, newline)) > options.maxInitialRequestBytes) {
          socket.end();
          return;
        }
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as {
          id: string; method: string; params: Record<string, unknown>;
        };
        requests.push({ method: request.method, params: request.params });
        beforeResponse.get(request.method)?.();
        const fault = faults.get(request.method);
        let result: Record<string, unknown> = {};
        if (fault !== 'error') {
          switch (request.method) {
            case 'session.snapshot':
              result = { snapshot: { version: options.serverVersion ?? '0.9.2', workspaces: empty ? [] : [{ workspace_id: 'w1', focused: true }] } };
              break;
            case 'workspace.create':
              tabs.add('bootstrap');
              result = { workspace: { workspace_id: 'w1', active_tab_id: 'bootstrap' }, tab: { tab_id: 'bootstrap' } };
              break;
            case 'layout.apply':
              panes.add('managed');
              tabs.add('managed-tab');
              result = { layout: { focused_pane_id: 'managed' } };
              break;
            case 'pane.get':
              result = { pane: { pane_id: 'managed', terminal_id: 'terminal_1', workspace_id: 'w1', tab_id: 'managed-tab' } };
              break;
            case 'pane.list':
              result = { panes: panes.has('managed') ? [{ pane_id: 'managed', terminal_id: 'terminal_1', workspace_id: 'w1', tab_id: 'managed-tab' }] : [] };
              break;
            case 'pane.process_info':
              result = { process_info: { shell_pid: 42, foreground_processes: [] } };
              break;
            case 'pane.close':
              panes.delete(String(request.params.pane_id));
              tabs.delete('managed-tab');
              break;
            case 'tab.close':
              tabs.delete(String(request.params.tab_id));
              break;
          }
        }
        if (fault === 'timeout') return;
        if (fault === 'disconnect') {
          socket.end();
          return;
        }
        result = await options.response?.(request.method, request.params) ?? result;
        socket.end(`${JSON.stringify(fault === 'error'
          ? { id: request.id, error: { code: `${request.method}_failed` } }
          : { id: request.id, result })}\n`);
      });
    });
    const start = async () => {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
    };
    const stop = async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    };
    await start();
    try {
      return await run({ socketPath, binary, faults, panes, tabs, requests, beforeResponse, setEmpty: () => { empty = true; }, start, stop });
    } finally {
      await stop();
    }
  });
}
