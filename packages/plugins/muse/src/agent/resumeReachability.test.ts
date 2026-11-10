import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { verifySpawnResumeReachability } from '@/daemon/connectedServices/verifySpawnResumeReachability';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { MUSE_MSP_PLAYBACK_SCRIPT, readMuseMspProcessAudit, waitForMuseMspProcessAudit } from './testkit/mspProcess.js';
import { readMuseRecord } from './events.js';

const nativeSessionId = '00000000-0000-7000-8000-00000000002c';

describe('Muse native resume proof through the admitted catalog', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.muse'] } });
  });
  afterAll(async () => { await runtime?.dispose(); await pluginReloadController.shutdown(); });

  it.each(['found', 'mismatched', 'not-found', 'cancelled'] as const)('checks %s native reachability with one read and no conversation mutation', async outcome => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-native-resume-proof-'));
    const auditPath = join(directory, 'native-audit.json');
    const script = join(directory, 'native-playback.cjs');
    const captured = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-resume-fork-after.json', import.meta.url), 'utf8')));
    if (!Array.isArray(captured.rows)) throw new Error('Expected captured native rows');
    const frame = readMuseRecord(captured.rows[27]);
    const reply = readMuseRecord(frame.message);
    const result = readMuseRecord(reply.result);
    // Negative identity/refusal and held-read variants are schema-derived OS
    // vectors. Native success fields and identities come from the real capture.
    const response = outcome === 'not-found'
      ? { jsonrpc: '2.0', id: reply.id, error: { code: -32010, message: 'Fixture session not found',
        data: { kind: 'sessionNotFound', fixtureSchemaDerived: true } } }
      : { ...reply, result: { ...result, session: { ...readMuseRecord(result.session),
        ...(outcome === 'mismatched' ? { sessionId: '00000000-0000-7000-8000-000000000099' } : {}) } } };
    const recording = JSON.stringify({ ...captured,
      rows: [...captured.rows.slice(0, 27), { ...frame, message: response }, ...captured.rows.slice(28)] });
    // The real 1.4.14 read reply is captured. excludeItems:true is the published
    // read-only request variant; no model turn or native credential is used.
    await writeFile(script, `process.env.MUSE_TEST_RECORDING = ${JSON.stringify(recording)};\n`
      + `process.env.MUSE_TEST_AUDIT_PATH = ${JSON.stringify(auditPath)};\n`
      + `process.env.MUSE_TEST_PLAYBACK_STEPS = ${JSON.stringify(JSON.stringify([{ requestRow: 26, receiveUntilRow: outcome === 'cancelled' ? 27 : 28 }]))};\n`
      + `process.env.MUSE_TEST_SELECTED_HOME = process.env.XDG_DATA_HOME;\n${MUSE_MSP_PLAYBACK_SCRIPT}`);
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    writeExecutableShimSync({ dir: directory, fileName: process.platform === 'win32' ? 'muse.cmd' : 'muse',
      contents: process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n` });
    const selectedHome = join(directory, 'selected-native-data');
    const environment = { XDG_DATA_HOME: selectedHome, HOME: directory,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ''}` };
    const controller = new AbortController();
    try {
      const pending = verifySpawnResumeReachability({ agentId: 'muse', vendorResumeId: nativeSessionId,
        cwd: directory, signal: controller.signal,
        materializedEnv: environment });
      if (outcome === 'cancelled') {
        await Promise.race([
          waitForMuseMspProcessAudit(auditPath, audit => audit.sessionReads.length === 1),
          pending.then(() => { throw new Error('Native inspection completed before the cancellation boundary'); }),
        ]);
        controller.abort(new Error('Containing resume preparation cancelled'));
      }
      const proof = await pending;
      if (outcome === 'found') expect(proof).toEqual({ ok: true, proof: 'native_session' });
      else expect(proof).toMatchObject({ ok: false });
      const audit = await readMuseMspProcessAudit(auditPath);
      expect(audit).toMatchObject({ initializeCount: 1, initializedCount: 1, commandCount: 0,
        cwd: directory, selectedHome, autoUpdate: '1' });
      expect(audit.methods).toEqual(['initialize', 'initialized', 'session/read']);
      expect(audit.sessionReads).toEqual([{ sessionId: nativeSessionId, excludeItems: true }]);
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
