// @ts-check
// Drives one hsetup system task over its JSON-lines protocol the way the desktop bridge does
// (`apps/ui/src-tauri/src/system_tasks/mod.rs`): the spec goes to stdin, events and the result come
// back on stdout, and a prompt is answered with one JSON line on stdin. The approver stands in for
// the signed-in app; every prompt is recorded so a scenario can count what the user would see.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const SYSTEM_TASK_PROTOCOL_VERSION = 1;

/** Prompt kinds of the current contract (`packages/protocol/src/systemTasks/setupThisComputerTaskContract.ts`). */
const PAIRING_PROMPT_KIND = 'setup.pairThisComputer';
const SERVICE_CONSENT_PROMPT_KIND = 'setup.serviceConsent';
/** 0.2.12's registry-dispatched setup emitted this prompt and did not read an answer. */
const LEGACY_PAIRING_PROMPT_KIND = 'authRequest';

/**
 * What the released 0.2.12 app sent as `setup.thisComputer.v1` params
 * (`ui-desktop-v0.2.12:apps/ui/sources/components/systemTasks/buildLocalMachineSetupSystemTaskSpec.ts:7-10`).
 * That hsetup (`ui-desktop-v0.2.12:apps/bootstrap/src/systemTasks/kinds/setupThisComputer.ts:19-22,121-126`)
 * requires a non-array object, declares `surface?`/`target?` without reading them, ignores unknown
 * fields, and sets up whatever relay the CLI reports as current (`server current --json`).
 */
const PREDECESSOR_0_2_12_SETUP_PARAMS = Object.freeze({ surface: 'desktop.ui', target: 'thisComputer' });

/**
 * What the released 0.2.17 app sent: the explicit relay, account and channel of the signed-in app
 * (`ui-desktop-v0.2.17:apps/ui/sources/components/systemTasks/buildLocalMachineSetupSystemTaskSpec.ts:36-52`).
 * Its hsetup requires activeRelayUrl, activeWebappUrl, expectedAccountId and a bootstrap channel
 * (`ui-desktop-v0.2.17:apps/bootstrap/src/systemTasks/kinds/setupThisComputer.ts:732-800`).
 * @param {PredecessorSetupTarget} target
 */
const predecessor0217SetupParams = (target) => Object.freeze({
  activeRelayUrl: target.relayUrl,
  activeWebappUrl: target.webappUrl,
  activeLocalRelayUrl: null,
  channel: target.channel,
  expectedAccountId: target.accountId,
  surface: 'desktop.ui',
});

/**
 * @typedef {{ relayUrl: string; webappUrl: string; channel: string; accountId: string }} PredecessorSetupTarget
 */

/**
 * The `setup.thisComputer.v1` params a released desktop sent, per baseline tag, as a function of the
 * run's relay, account and channel. A baseline whose contract was not characterized from its tagged
 * source has none, and the upgrade scenario is reported BLOCKED rather than driven with another
 * version's params.
 * @type {Readonly<Record<string, (target: PredecessorSetupTarget) => Readonly<Record<string, unknown>>>>}
 */
export const PREDECESSOR_SETUP_PARAMS_BY_DESKTOP_TAG = Object.freeze({
  'ui-desktop-v0.2.12': () => PREDECESSOR_0_2_12_SETUP_PARAMS,
  'ui-desktop-v0.2.17': predecessor0217SetupParams,
});

/**
 * @param {string} desktopTag
 * @param {PredecessorSetupTarget} target
 * @returns {Readonly<Record<string, unknown>> | null}
 */
export function resolvePredecessorSetupParams(desktopTag, target) {
  return Object.hasOwn(PREDECESSOR_SETUP_PARAMS_BY_DESKTOP_TAG, desktopTag)
    ? PREDECESSOR_SETUP_PARAMS_BY_DESKTOP_TAG[desktopTag](target)
    : null;
}

/**
 * @typedef {{ kind: string; stepId: string | null; answered: boolean; approved: boolean | null }} PromptRecord
 * @typedef {'approve' | 'decline'} ConsentPolicy
 * @typedef {{
 *   approvePairing: (publicKey: string) => Promise<void>;
 *   serviceConsent?: ConsentPolicy;
 * }} PromptHandlers
 */

/**
 * Decide how one prompt event is answered. Pure, so the policy is testable without a process.
 * @param {unknown} data
 * @param {PromptHandlers} handlers
 * @returns {{ kind: string; action: 'approve-pairing'; publicKey: string; answer: object | null } | { kind: string; action: 'answer'; answer: object }}
 */
export function planPromptResponse(data, handlers) {
  const record = data && typeof data === 'object' && !Array.isArray(data) ? /** @type {Record<string, unknown>} */ (data) : {};
  const kind = typeof record.kind === 'string' ? record.kind : 'unknown';
  if (kind === PAIRING_PROMPT_KIND && typeof record.publicKeyB64Url === 'string' && record.publicKeyB64Url) {
    return { kind, action: 'approve-pairing', publicKey: record.publicKeyB64Url, answer: { approved: true } };
  }
  if (kind === LEGACY_PAIRING_PROMPT_KIND && typeof record.publicKey === 'string' && record.publicKey) {
    return { kind, action: 'approve-pairing', publicKey: record.publicKey, answer: null };
  }
  if (kind === SERVICE_CONSENT_PROMPT_KIND && handlers.serviceConsent === 'approve') {
    return { kind, action: 'answer', answer: { approved: true } };
  }
  // Anything else — an account move, an unexpected consent, an unknown prompt — is refused so the
  // run ends on its own terms and the scenario reports what was asked.
  return { kind, action: 'answer', answer: { approved: false, reason: 'release_validation_declined' } };
}

/**
 * @param {unknown} value
 * @returns {value is { type: string; data?: unknown; stepId?: string }}
 */
function isEvent(value) {
  return Boolean(value && typeof value === 'object' && typeof /** @type {{ type?: unknown }} */ (value).type === 'string');
}

/**
 * @param {unknown} value
 * @returns {value is { ok: boolean; data?: unknown; error?: { code: string; message: string } }}
 */
function isResult(value) {
  return Boolean(value && typeof value === 'object' && !isEvent(value) && typeof /** @type {{ ok?: unknown }} */ (value).ok === 'boolean');
}

/**
 * Run one task and resolve once the process exits.
 * @param {{
 *   command: string;
 *   args: readonly string[];
 *   kind: string;
 *   params: unknown;
 *   handlers: PromptHandlers;
 *   env?: NodeJS.ProcessEnv;
 *   onLine?: (line: string) => void;
 * }} options
 */
export async function runHsetupTask({ command, args, kind, params, handlers, env, onLine }) {
  const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env });
  /** @type {unknown[]} */
  const events = [];
  /** @type {PromptRecord[]} */
  const prompts = [];
  /** @type {unknown} */
  let result = null;
  let stderr = '';
  /** @type {Error | null} */
  let handlerError = null;
  let stdinOpen = true;

  child.stdin.on('error', () => { stdinOpen = false; });
  child.stdin.on('close', () => { stdinOpen = false; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const writeLine = (/** @type {object} */ value) => {
    if (stdinOpen) child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  writeLine({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, kind, params });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  lines.on('line', (line) => {
    onLine?.(line);
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (isResult(parsed)) {
      result = parsed;
      return;
    }
    if (!isEvent(parsed)) return;
    events.push(parsed);
    if (parsed.type !== 'prompt') return;
    const plan = planPromptResponse(parsed.data, handlers);
    const record = /** @type {PromptRecord} */ ({ kind: plan.kind, stepId: parsed.stepId ?? null, answered: false, approved: null });
    prompts.push(record);
    // Prompts are answered in order; the executor waits for each answer before it continues.
    chain = chain.then(async () => {
      if (plan.action === 'approve-pairing') {
        await handlers.approvePairing(plan.publicKey);
      }
      if (plan.answer) {
        writeLine(plan.answer);
        record.answered = true;
        record.approved = /** @type {{ approved?: boolean }} */ (plan.answer).approved === true;
      } else {
        record.approved = true;
      }
    }).catch((error) => {
      handlerError = error instanceof Error ? error : new Error(String(error));
      child.kill('SIGTERM');
    });
  });

  const exitCode = await new Promise((resolveExit) => {
    child.on('close', (code) => resolveExit(code));
  });
  await chain;
  if (handlerError) throw handlerError;
  return { exitCode, result: /** @type {null | { ok: boolean; data?: any; error?: { code: string; message: string } }} */ (result), events, prompts, stderr };
}
