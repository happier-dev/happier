import { Writable } from 'node:stream';
import { readCredentialRedactionValues } from '@happier-dev/cli-common/plugins/http';
import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import { SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import type { AgentLaunchPayload } from './agentLaunchFrame';
import type { SpawnFailure } from '@/processes/spawnFailure/classifySpawnFailure';

export type AgentLaunchFailureStage = 'exec' | 'child_exit' | 'stdin' | 'stdout' | 'stderr' | 'caller_cancelled';
export type AgentLaunchFailure = Readonly<{
  stage: AgentLaunchFailureStage;
  errno?: SpawnFailure['errno'];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}>;

/** Only closed stage/termination facts and redacted stderr cross the RunAs boundary. */
export class AgentLaunchDiagnosticError extends Error {
  readonly code: 'agent_launch_failed' | 'agent_launch_cancelled';
  readonly stage: AgentLaunchFailureStage;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderrPreview: string;

  constructor(failure: AgentLaunchFailure, tail = '') {
    const code = failure.stage === 'caller_cancelled' ? 'agent_launch_cancelled' : 'agent_launch_failed';
    const heading = `${code} stage=${failure.stage}`
      + (failure.errno ? ` errno=${failure.errno}` : '')
      + (failure.exitCode !== undefined ? ` exitCode=${failure.exitCode}` : '')
      + (failure.signal !== undefined ? ` signal=${failure.signal ?? 'none'}` : '');
    // The existing TURN-FAIL preview is the containing budget. Reserve its
    // heading and newline so the transport's retained tail keeps the stage.
    const preview = redactBugReportSensitiveText(tail).trim();
    const message = heading + (preview ? `: ${trimBugReportTextToMaxBytes(preview,
      SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH - Buffer.byteLength(heading) - 3)}` : '');
    super(message);
    this.code = code;
    this.stage = failure.stage;
    this.exitCode = failure.exitCode;
    this.signal = failure.signal;
    this.stderrPreview = message;
  }
}

export function createAgentLaunchStderr(payload: AgentLaunchPayload) {
  // The frame is the selected material owner; never put it or an OS exception
  // (which can contain argv) in a diagnostic. Protect exact values even when
  // the child splits a Provider key across writes or emits it without a label.
  const lease = createProviderRedactionLease({ values: [
    ...Object.values(payload.environment),
    ...payload.selectedMaterials.flatMap(file => {
      const text = Buffer.from(file.contentBase64, 'base64').toString('utf8');
      const values = [text];
      // Credential files may be JSON while the native error prints only a
      // value. Extract strings for redaction, without imposing a file format.
      try { JSON.parse(text, (_key, value: unknown) => {
        if (typeof value === 'string' && value.length) values.push(value);
        return value;
      }); } catch { /* Non-JSON material remains protected as exact text. */ }
      return values;
    }),
  ].flatMap(rawCredential => readCredentialRedactionValues({ rawCredential })) });
  const sanitizer = lease.createStreamingSanitizer();
  let tail = '';
  const retain = (value: string) => {
    tail = trimBugReportTextToMaxBytes(tail + value, SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH);
  };
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      retain(sanitizer.push(chunk));
      callback();
    },
    final(callback) { retain(sanitizer.flush()); callback(); },
  });
  return { stream, readTail: () => redactBugReportSensitiveText(tail), close: lease.close };
}
