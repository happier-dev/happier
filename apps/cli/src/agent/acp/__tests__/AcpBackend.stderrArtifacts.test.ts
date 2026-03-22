import { describe, expect, it } from 'vitest';

import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import {
  createAcpSubprocessEnvScope,
  createAcpTestTransportHandler,
  waitForAcpArtifactsFile,
  waitForFileToContain,
  writeAcpTestAgentScript,
} from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakeAcpAgentScript(params: { dir: string; stderrAfterPromptText: string }): string {
  const stderrAfterPromptText = JSON.stringify(params.stderrAfterPromptText);
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;
        const id = req.id;
        const method = req.method;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, { sessionId: 'test-session' });
          continue;
        }

        if (method === 'session/prompt') {
          ok(id, {});
          process.stderr.write(String(${stderrAfterPromptText}) + '\\n');
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'ok' },
              },
            },
          });
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent-stderr-artifacts.mjs',
    source: src,
  });
}

describe('AcpBackend subprocess stderr artifacts', () => {
  it('writes stderr to a bounded artifacts file', async () => {
    await withTempDir('happier-acp-stderr-artifacts-', async (dir) => {
      await withTempDir('happier-debug-artifacts-', async (artifactsRoot) => {
        const envScope = createAcpSubprocessEnvScope();
        envScope.patch({
          HAPPIER_DEBUG_ARTIFACTS_DIR: artifactsRoot,
          HAPPIER_SUBPROCESS_STDERR_MAX_BYTES: '10000',
        });

        const scriptPath = writeFakeAcpAgentScript({ dir, stderrAfterPromptText: 'boom on stderr' });

        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({ idleTimeoutMs: 1 }),
        });

        try {
          const started = await backend.startSession();
          await backend.sendPrompt(started.sessionId, 'hi');

          const expectedDir = join(artifactsRoot, 'subprocess', 'test');
          const filePath = await waitForAcpArtifactsFile(expectedDir, { timeoutMs: 2_000 });
          await waitForFileToContain(filePath, 'boom on stderr', { timeoutMs: 2_000 });
        } finally {
          envScope.restore();
          await backend.dispose().catch(() => {});
        }
      });
    });
  }, 20_000);
});
