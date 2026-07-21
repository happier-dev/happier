import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AcpBackend } from '@/agent/acp/AcpBackend';
import { isDefinitiveSessionControlApplyError } from '@/agent/runtime/sessionControlApplyError';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

import { grokSessionModelAdapter } from './modelControls';

function writeGrokModelAgent(params: Readonly<{ dir: string; requestsPath: string }>): string {
  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-grok-model-agent.mjs',
    source: `
      import fs from 'node:fs';
      const decoder = new TextDecoder();
      let buffer = '';
      const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
      const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
      const record = (params) => fs.appendFileSync(${JSON.stringify(params.requestsPath)}, JSON.stringify(params) + '\\n');

      process.stdin.on('data', (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          if (request.method === 'initialize') {
            ok(request.id, { protocolVersion: 1, authMethods: [] });
          } else if (request.method === 'session/new' || request.method === 'session/load') {
            ok(request.id, {
              sessionId: 'grok-session',
              models: {
                currentModelId: 'grok-4.5',
                availableModels: [
                  {
                    modelId: 'grok-4.5',
                    name: 'Grok 4.5',
                    meta: {
                      supportsReasoningEffort: true,
                      reasoningEffort: 'medium',
                      reasoningEfforts: [
                        { id: 'fast', value: 'low', label: 'Fast' },
                        { id: 'balanced', value: 'medium', label: 'Balanced', description: 'Recommended' },
                        { id: 'deep', value: 'high', label: 'Deep' },
                      ],
                    },
                  },
                  { modelId: 'grok-build', name: 'Grok Build' },
                ],
              },
            });
          } else if (request.method === 'session/set_model') {
            record(request.params);
            if (request.params.modelId === 'rejected-model') {
              send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'rejected' } });
            } else {
              ok(request.id, {});
            }
          } else if (request.id !== undefined && request.id !== null) {
            ok(request.id, {});
          }
        }
      });
    `,
  });
}

async function readRequests(path: string): Promise<unknown[]> {
  const raw = await readFile(path, 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line));
}

describe('Grok ACP session model controls', () => {
  it('projects Grok effort metadata and applies effort with the exact active model', async () => {
    await withTempDir('happier-grok-model-adapter-', async (dir) => {
      const requestsPath = join(dir, 'set-model-requests.ndjson');
      const scriptPath = writeGrokModelAgent({ dir, requestsPath });
      const backend = new AcpBackend({
        agentName: 'grok',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        sessionModelAdapter: grokSessionModelAdapter,
      });

      try {
        const started = await backend.startSession();
        expect(backend.getSessionModelState()).toEqual({
          currentModelId: 'grok-4.5',
          availableModels: [
            {
              id: 'grok-4.5',
              name: 'Grok 4.5',
              modelOptions: [{
                id: 'reasoning_effort',
                name: 'Reasoning effort',
                type: 'select',
                currentValue: 'medium',
                options: [
                  { value: 'low', name: 'Fast' },
                  { value: 'medium', name: 'Balanced', description: 'Recommended' },
                  { value: 'high', name: 'Deep' },
                ],
              }],
            },
            { id: 'grok-build', name: 'Grok Build' },
          ],
        });

        await backend.setSessionConfigOption(started.sessionId, 'reasoning_effort', 'high');
        expect(await readRequests(requestsPath)).toEqual([{
          sessionId: 'grok-session',
          modelId: 'grok-4.5',
          _meta: { reasoningEffort: 'high' },
        }]);
        expect(backend.getSessionModelState()?.availableModels[0]?.modelOptions?.[0]?.currentValue).toBe('high');
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  });

  it('omits metadata for ordinary model switches and preserves acknowledged state on rejection', async () => {
    await withTempDir('happier-grok-model-switch-', async (dir) => {
      const requestsPath = join(dir, 'set-model-requests.ndjson');
      const backend = new AcpBackend({
        agentName: 'grok',
        cwd: dir,
        command: process.execPath,
        args: [writeGrokModelAgent({ dir, requestsPath })],
        sessionModelAdapter: grokSessionModelAdapter,
      });

      try {
        const started = await backend.startSession();
        await backend.setSessionModel(started.sessionId, 'grok-build');
        const rejection = await backend.setSessionModel(started.sessionId, 'rejected-model').catch((error) => error);
        expect(isDefinitiveSessionControlApplyError(rejection)).toBe(true);

        expect(await readRequests(requestsPath)).toEqual([
          { sessionId: 'grok-session', modelId: 'grok-build' },
          { sessionId: 'grok-session', modelId: 'rejected-model' },
        ]);
        expect(backend.getSessionModelState()?.currentModelId).toBe('grok-build');
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  });

  it('classifies deterministic adapter validation as definitive without sending a request', async () => {
    await withTempDir('happier-grok-effort-rejection-', async (dir) => {
      const requestsPath = join(dir, 'set-model-requests.ndjson');
      const backend = new AcpBackend({
        agentName: 'grok',
        cwd: dir,
        command: process.execPath,
        args: [writeGrokModelAgent({ dir, requestsPath })],
        sessionModelAdapter: grokSessionModelAdapter,
      });

      try {
        const started = await backend.startSession();
        const rejection = await backend
          .setSessionConfigOption(started.sessionId, 'reasoning_effort', 'unsupported')
          .catch((error) => error);
        expect(isDefinitiveSessionControlApplyError(rejection)).toBe(true);
        await expect(readFile(requestsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  });

  it('restores provider-reported model and effort state when loading a session', async () => {
    await withTempDir('happier-grok-model-resume-', async (dir) => {
      const requestsPath = join(dir, 'set-model-requests.ndjson');
      const backend = new AcpBackend({
        agentName: 'grok',
        cwd: dir,
        command: process.execPath,
        args: [writeGrokModelAgent({ dir, requestsPath })],
        sessionModelAdapter: grokSessionModelAdapter,
      });

      try {
        await backend.loadSession('grok-session');
        const restored = backend.getSessionModelState();
        expect(restored?.currentModelId).toBe('grok-4.5');
        expect(restored?.availableModels.find((model) => model.id === 'grok-4.5')).toMatchObject({
          id: 'grok-4.5',
          modelOptions: [expect.objectContaining({
            id: 'reasoning_effort',
            currentValue: 'medium',
          })],
        });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  });
});
