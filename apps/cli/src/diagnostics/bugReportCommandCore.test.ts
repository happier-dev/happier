import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runBugReportCommand } from './bugReportCommandCore';

describe('runBugReportCommand export mode', () => {
  it.each([['--export'], ['--dry-run', '--output']])('keeps report text local with %s in an interactive terminal', async (...exportFlags) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ issues: [] }));
    });
    const directory = await mkdtemp(join(tmpdir(), 'bug-report-export-'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      const providerUrl = `http://127.0.0.1:${address.port}`;
      const outputPath = join(directory, 'diagnostics.json');
      const summary = 'Private report description for local inspection';

      const result = await runBugReportCommand([
        '--title', 'Local diagnostics preview',
        '--summary', summary,
        '--session-id', 'private-selected-session',
        '--no-include-diagnostics',
        ...exportFlags,
        outputPath,
      ], {
        getActiveServerProfile: async () => ({
          id: 'test', name: 'Test', serverUrl: providerUrl, webappUrl: providerUrl,
        }),
        fetchBugReportsFeature: async () => ({
          enabled: true,
          providerUrl,
          defaultIncludeDiagnostics: true,
          acceptedArtifactKinds: [],
          maxArtifactBytes: 10_000,
          contextWindowMs: 60_000,
          uploadTimeoutMs: 1_000,
        }),
        isInteractiveTerminal: () => true,
        promptInput: async () => { throw new Error('No prompt expected'); },
      });

      expect(result.mode).toBe('exported');
      expect(JSON.parse(await readFile(outputPath, 'utf8')).form.summary).toBe(summary);
      expect(requests).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes a local bundle without invoking the submission service', async () => {
    let writtenPath = '';
    let writtenContents = '';
    let submitted = false;

    const result = await runBugReportCommand([
      '--title', 'Export diagnostics',
      '--summary', 'Capture diagnostics locally',
      '--include-diagnostics',
      '--accept-privacy-notice',
      '--dry-run',
      '--output', '/tmp/diagnostics.json',
    ], {
      getActiveServerProfile: async () => ({
        id: 'server-1',
        name: 'Test server',
        serverUrl: 'https://server.example',
        webappUrl: 'https://server.example',
      }),
      fetchBugReportsFeature: async () => ({
        enabled: false,
        providerUrl: null,
        defaultIncludeDiagnostics: true,
        acceptedArtifactKinds: [],
        maxArtifactBytes: 10_000,
        contextWindowMs: 60_000,
        uploadTimeoutMs: 1_000,
      } as any),
      collectDiagnosticsArtifacts: async () => ({
        artifacts: [{
          filename: 'diagnostics.txt',
          sourceKind: 'cli',
          contentType: 'text/plain',
          content: 'diagnostic text',
        }],
        environment: {
          appVersion: '0.2.13',
          platform: 'darwin',
          deploymentType: 'cloud',
          serverUrl: 'https://server.example',
        },
      }),
      submitBugReport: async () => {
        submitted = true;
        throw new Error('submission should not run');
      },
      searchSimilarIssues: async () => ({ issues: [] }),
      isInteractiveTerminal: () => false,
      promptInput: async () => '',
      writeExportFile: async (path, contents) => {
        writtenPath = path;
        writtenContents = contents;
      },
    });

    expect(result).toMatchObject({
      mode: 'exported',
      outputPath: '/tmp/diagnostics.json',
      artifactCount: 1,
    });
    expect(JSON.parse(writtenContents).artifacts[0].content).toBe('diagnostic text');
    expect(writtenPath).toBe('/tmp/diagnostics.json');
    expect(submitted).toBe(false);
  });
});
