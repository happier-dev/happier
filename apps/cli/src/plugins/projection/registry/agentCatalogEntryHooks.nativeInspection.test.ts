import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from '../../../../../../packages/plugins/kilo/src/activate';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/kilo/src/manifest';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import { projectAgentPreflightSessionControlsCatalogEntry } from './agentCatalogEntryHooks';

describe('native resume inspection from an ACP catalog declaration', () => {
  it('loads the exact Kilo session in its prepared environment, refuses a missing session, and permits recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-kilo-resume-'));
    const script = join(root, 'native.cjs');
    const calls = join(root, 'calls.jsonl');
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      // The native executable is the system boundary; registration, projection,
      // command admission, transport and Kilo's resume correlation remain real.
      await writeFile(script, `
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ method: request.method, params: request.params, marker: process.env.KILO_RESUME_FIXTURE }) + '\\n');
  const response = request.method === 'session/load' && request.params.sessionId !== 'ses_reachable'
    ? { error: { code: -32000, message: 'Session not found' } }
    : { result: request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } } : {} };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\\n');
});
`);
      const executable = writeExecutableShimSync({
        dir: root,
        fileName: process.platform === 'win32' ? 'kilo-fixture.cmd' : 'kilo-fixture',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${script.replace(/'/g, `'\\''`)}' "$@"\n`,
      });
      const registration = activation.registration('agents', 'kilo');
      const controls = registration?.preflightSessionControls;
      const verify = registration?.connectedAccountLaunch?.continuity?.verifyResumeReachable;
      if (!controls || !verify) throw new Error('Kilo resume declarations unavailable');
      const projected = projectAgentPreflightSessionControlsCatalogEntry({
        agentId: 'kilo',
        systemTools: [{ id: 'kilo-cli', title: 'Kilo fixture', executableNames: [executable] }],
        preflightSessionControls: controls,
        retirementSignal: new AbortController().signal,
        isCurrent: () => true,
      });
      const adapter = await projected.getPreflightSessionControlsProbeAdapter!();
      const inspect = (vendorResumeId: string) => adapter!.withNativeInspection
        ? adapter!.withNativeInspection({ cwd: root, env: { KILO_RESUME_FIXTURE: 'prepared' } }, nativeInspection => verify({
          vendorResumeId, nativeInspection,
          sessionFiles: { verifyDeclaredPaths: async () => ({ found: false }), findDeclaredCandidate: async () => ({ found: false }) },
        }))
        : verify({ vendorResumeId,
          sessionFiles: { verifyDeclaredPaths: async () => ({ found: false }), findDeclaredCandidate: async () => ({ found: false }) },
        });
      await expect(inspect('ses_reachable')).resolves.toEqual({ ok: true, proof: 'native_session' });
      await expect(inspect('ses_missing')).resolves.toEqual({ ok: false, reason: 'kilo_resume_unreachable' });
      await expect(inspect('ses_reachable')).resolves.toEqual({ ok: true, proof: 'native_session' });
      const requests = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toEqual(['ses_reachable', 'ses_missing', 'ses_reachable'].flatMap(sessionId => [
        { method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} }, marker: 'prepared' },
        { method: 'session/load', params: { sessionId, cwd: root, mcpServers: [] }, marker: 'prepared' },
      ]));
    } finally {
      await activation.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
