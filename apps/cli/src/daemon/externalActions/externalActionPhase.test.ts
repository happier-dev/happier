import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

import { refuseExternalActionPhase, runTracedExternalActionStage, runTracedExternalActionInnerStage, traceExternalActionStage, readSessionInputAdmissionDiagnostic } from './externalActionPhase';
import { executeExternalAction } from './executeExternalAction';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

it('correlates only opaque Session input ids and drops all private admission carrier fields', () => {
  const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  const requestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
  const carrier = { actionId: 'session.message.send', requestId, accountEncryptionMode: 'e2ee' as const,
    accountId: 'PRIVATE_ACCOUNT', token: 'PRIVATE_CREDENTIAL', input: { message: 'PRIVATE_PROMPT' } };
  try {
    const diagnostic = readSessionInputAdmissionDiagnostic(carrier);
    refuseExternalActionPhase('requester_prepare', 'machine', undefined, { ...diagnostic, refusalBranch: 'custody' });
    expect(log.mock.calls).toEqual([[expect.any(String), expect.objectContaining({ requestId,
      actionId: 'session.message.send', accountEncryptionMode: 'e2ee', refusalBranch: 'custody' })]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_');
    expect(readSessionInputAdmissionDiagnostic({ ...carrier, requestId: 'PRIVATE_AUTHORED_INPUT' })).toBeUndefined();
    expect(readSessionInputAdmissionDiagnostic({ ...carrier, actionId: 'browser.diagnostics.snapshot' })).toBeUndefined();
  } finally { log.mockRestore(); }
});

it.each(['session_detail_invalid_response', 'session_detail_projection_unavailable', 'not_authenticated', 'client-upgrade-required'])(
  'keeps the known Session diagnostic %s without private exception content', code => {
    const error = Object.assign(new Error('private-response\n    at /PRIVATE_SENTINEL.js:1:2'), {
      name: 'HttpStatusError', code, response: { status: 403, data: 'private-body', headers: { Authorization: 'private-bearer' } },
    });
    expect(readUnexpectedActionErrorDiagnosticV1(error)).toMatchObject({ errorClass: 'HttpStatusError', errorCode: code, httpStatus: 403,
      stackFrames: expect.arrayContaining([expect.objectContaining({ file: expect.stringContaining('externalActionPhase.test.ts') })]),
    });
    expect(JSON.stringify(readUnexpectedActionErrorDiagnosticV1(error))).not.toMatch(/private-|PRIVATE_SENTINEL/);
    expect(readUnexpectedActionErrorDiagnosticV1(Object.assign(new Error('private'), {
      name: 'private-name', code: 'private-code', response: { status: '403' },
    }))).toMatchObject({ errorClass: 'Error', errorCode: null, httpStatus: null });
  },
);

it.each(['session.stop', 'session.archive', 'session.unarchive', 'session.status.get', 'projects.script.run', 'projects.compute.exec', 'projects.inspect', 'localServices.launcher.start', 'approval.request.decide', 'plugins.list'])('traces %s admission and real executor phases without caller content', async actionId => {
  vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', actionId === 'plugins.list' || actionId === 'session.archive' || actionId === 'session.unarchive' ? '0' : '1');
  const log = vi.spyOn(logger, 'debugLocalFile').mockImplementation(() => {});
  const rootRequestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
  try {
    const execution = await executeExternalAction({ actionId,
      envelope: { v: 1, requestId: rootRequestId, input: { private: 'private-input-marker' } },
      principal: { authority: 'present_user' }, currentMachineId: 'machine-1',
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'private-token-marker', encryption: null } }),
      executor: createCliActionExecutor({ token: 'private-token-marker', sessionId: '', mode: 'plain', ctx: null }),
    });
    expect(execution).toMatchObject({ kind: 'response' });
    const stages = log.mock.calls.filter(([message]) => message === '[external-action-stage]');
    expect(stages).toEqual(expect.arrayContaining([
      ['[external-action-stage]', { actionId, rootRequestId, stage: 'target_resolution.begin' }],
      ['[external-action-stage]', expect.objectContaining({ actionId, rootRequestId,
        stage: 'action_execution.phase', phase: 'cli_context', elapsedMs: expect.any(Number) })],
    ]));
    expect(JSON.stringify(stages)).not.toContain('private-');
  } finally { log.mockRestore(); vi.unstubAllEnvs(); }
});

it('does not disclose a changing Error name through private diagnostics', () => {
  // The local file sink is an OS boundary; diagnostic classification stays real.
  const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  const error = new TypeError('details must remain private');
  let reads = 0;
  Object.defineProperty(error, 'name', { get: () => ++reads === 1 ? 'ZodError' : 'private-details' });
  try {
    const result = refuseExternalActionPhase('requester_settings', 'machine', error);
    expect(result).toEqual({ ok: false, phase: 'requester_settings', errorClass: 'ZodError',
      message: 'External Action phase threw (details redacted)' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-details');
  } finally { log.mockRestore(); }
});

it.each([false, true])('excludes multiline exception content from the real phase log (unproven stack: %s)', unproven => {
  const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  const error = new Error('private message\n    at /CREDENTIAL_SENTINEL.js:7:9');
  if (unproven) error.stack = '    at /UNPROVEN_SENTINEL.js:1:2';
  try {
    const failure = refuseExternalActionPhase('requester_settings', 'machine', error);
    expect(JSON.stringify(log.mock.calls)).not.toContain('SENTINEL');
    const diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
    expect(log.mock.calls).toEqual([['[external-action-phase]', {
      machineId: 'machine', phase: failure.phase, message: failure.message, ...diagnostic,
    }]]);
    if (unproven) expect(diagnostic.stackFrames).toEqual([]);
    else expect(diagnostic.stackFrames[0]?.file).toContain('externalActionPhase.test.ts');
  } finally { log.mockRestore(); }
});

it.each([
  { kind: 'module_link', source: "import { missingBinding } from './dependency.mjs';" },
  { kind: 'module_parse', source: 'export const invalid = ;' },
])('keeps only location metadata for a native ESM $kind failure', async ({ kind, source }) => {
  const scratchPath = '.project/tmp/COORD/phase-error-location-1120';
  const scratch = fileURLToPath(new URL(`../../../../../${scratchPath}/`, import.meta.url));
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'modules-'));
  const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  try {
    const importer = join(dir, 'importer.mjs');
    await writeFile(importer, `${source} // PRIVATE_SOURCE_COMMENT`);
    await writeFile(join(dir, 'dependency.mjs'), 'export const presentBinding = 1;');
    // Keep import() outside the Vite transform to exercise the native loader.
    const loader = join(dir, 'load.cjs');
    await writeFile(loader, 'module.exports = () => import("./importer.mjs");');
    const nativeImport: () => Promise<unknown> = createRequire(import.meta.url)(loader);
    const error = await new Promise<unknown>((resolve, reject) => {
      void nativeImport().then(() => reject(new Error('Expected ESM failure')), resolve);
    });
    expect(readUnexpectedActionErrorDiagnosticV1(error)).toMatchObject({ errorClass: 'SyntaxError', stackFrames: [] });
    const failure = refuseExternalActionPhase('approval.execute', 'machine', error);
    expect(failure).toEqual({ ok: false, phase: 'approval.execute', errorClass: 'SyntaxError',
      message: 'External Action phase threw (details redacted)' });
    expect(log.mock.calls[0]?.[1]).toMatchObject({
      message: failure.message, stackFrames: [],
      errorLocation: kind === 'module_link' ? { kind, file: `${scratchPath}/${basename(dir)}/importer.mjs`,
        missingExport: 'missingBinding', line: 1, column: 10 } : { kind },
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE_SOURCE_COMMENT|The requested module|file:\/\/|import \{/);
  } finally {
    log.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps payload excerpts from a real JSON.parse failure out of a frameless phase log', () => {
  const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  const payload = 'PRIVATE_TOKEN_827fecc1';
  const previous = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 1; // Keep the native JSON.parse frame alone.
    try {
      JSON.parse(payload);
      throw new Error('Expected JSON.parse failure');
    } catch (error) {
      expect(error).toBeInstanceOf(SyntaxError);
      expect(readUnexpectedActionErrorDiagnosticV1(error).stackFrames).toEqual([]);
      const failure = refuseExternalActionPhase('approval.execute', 'machine', error);
      expect(log.mock.calls).toEqual([['[external-action-phase]', {
        machineId: 'machine', phase: failure.phase, message: 'External Action phase threw (details redacted)',
        errorClass: 'SyntaxError', errorCode: null, httpStatus: null, stackFrames: [],
      }]]);
    }
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|TOKEN|827fecc1/);
  } finally {
    Error.stackTraceLimit = previous;
    log.mockRestore();
  }
});

it('joins contributed stages by the RPC UUID and preserves thrown values without logging them', async () => {
  const log = vi.spyOn(logger, 'debugLocalFile').mockImplementation(() => {});
  const requestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
  const failure = new Error('private-failure-marker');
  try {
    await expect(runTracedExternalActionStage('action.invoke', `rpc_${requestId}`, 'contributed.execute',
      async () => { throw failure; })).rejects.toBe(failure);
    expect(log.mock.calls).toEqual(['begin', 'end'].map(edge => [
      '[external-action-stage]', { actionId: 'action.invoke', rootRequestId: requestId, stage: `contributed.execute.${edge}` },
    ]));
    await runTracedExternalActionStage('action.invoke', 'private-invalid-request-marker', 'contributed.execute', () => null);
    expect(log.mock.calls).toHaveLength(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
  } finally { log.mockRestore(); }
});

it('correlates overlapping inner phases with their own ingress and preserves boundary failure identity', async () => {
  vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
  const log = vi.spyOn(logger, 'debugLocalFile').mockImplementation(() => {});
  const first = '70cc64d3-0386-4914-b7d8-713b7879e99f';
  const second = 'fd0b0146-17a5-431c-bc69-3a3fa865b1d7';
  let release!: () => void;
  const boundary = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error('private-boundary-error');
  try {
    const pending = runTracedExternalActionStage('action.invoke', `rpc_${first}`, 'contributed.target_invoke', () =>
      runTracedExternalActionInnerStage('collection.http.query', async () => { await boundary; throw failure; }));
    const outcome = pending.then(() => null, error => error);
    await runTracedExternalActionStage('action.invoke', `rpc_${second}`, 'contributed.target_invoke', () =>
      runTracedExternalActionInnerStage('contributed.handler', () => 'private-result'));
    release();
    expect(await outcome).toBe(failure);
    const ends = log.mock.calls.filter(([, record]) => record && typeof record === 'object'
      && 'stage' in record && typeof record.stage === 'string'
      && record.stage.endsWith('.end') && 'elapsedMs' in record);
    expect(ends).toEqual(expect.arrayContaining([
      ['[external-action-stage]', expect.objectContaining({ rootRequestId: first, stage: 'collection.http.query.end', elapsedMs: expect.any(Number) })],
      ['[external-action-stage]', expect.objectContaining({ rootRequestId: second, stage: 'contributed.handler.end', elapsedMs: expect.any(Number) })],
    ]));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
    log.mockClear();
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
    await runTracedExternalActionInnerStage('contributed.handler', () => null);
    expect(log).not.toHaveBeenCalled();
  } finally { release(); log.mockRestore(); vi.unstubAllEnvs(); }
});

it.each(['machines.provisioners.list', 'machines.provisioners.check', 'machines.provisioners.options'])(
  'correlates %s read completion and cleanup only while latency diagnostics are enabled', actionId => {
    const log = vi.spyOn(logger, 'debugLocalFile').mockImplementation(() => {});
    const rootRequestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
    const transportRequestId = 'fd0b0146-17a5-431c-bc69-3a3fa865b1d7';
    try {
      vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
      traceExternalActionStage(actionId, rootRequestId, 'action_execution.end', transportRequestId);
      expect(log).not.toHaveBeenCalled();
      vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
      traceExternalActionStage(actionId, rootRequestId, 'action_execution.end', transportRequestId);
      traceExternalActionStage(actionId, rootRequestId, 'daemon.cleanup.end', transportRequestId);
      expect(log.mock.calls).toEqual(['action_execution.end', 'daemon.cleanup.end'].map(stage => [
        '[external-action-stage]', { actionId, rootRequestId, stage, transportRequestId },
      ]));
    } finally { log.mockRestore(); vi.unstubAllEnvs(); }
  },
);
