#!/usr/bin/env node
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureDir,
  nowStamp,
  runTauriMcpCli,
  runTauriMcpCliJson,
  writeTextArtifact,
} from './tauriMcpCli.mjs';
import {
  resolveDefaultDriverSessionPort,
  startTargetedDriverSession,
} from './tauriDriverSessionSelection.mjs';

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(uiRoot, '../..');

function readRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Host-side attribute-value escaping for `data-testid` CSS selectors. */
export function buildTestIdentifierSelector(testId) {
  const escaped = String(testId).replace(/[\\"]/gu, '\\$&');
  return `[data-testid="${escaped}"]`;
}

export function unwrapWebviewScriptValue(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      return unwrapWebviewScriptValue(JSON.parse(text));
    } catch {
      return text;
    }
  }
  const record = readRecord(value);
  if (!record) return value ?? null;
  if (typeof record.text === 'string') return unwrapWebviewScriptValue(record.text);
  if (Array.isArray(record.content)) {
    for (const entry of record.content) {
      const unwrapped = unwrapWebviewScriptValue(entry);
      if (unwrapped != null) return unwrapped;
    }
  }
  if (Object.hasOwn(record, 'result')) return unwrapWebviewScriptValue(record.result);
  return record;
}

export function buildNavigationScript(route) {
  return `(() => {
    const next = ${JSON.stringify(route)};
    window.history.pushState({}, '', next);
    window.dispatchEvent(new PopStateEvent('popstate'));
    return window.location.pathname + window.location.search + window.location.hash;
  })()`;
}

export function buildPresenceProbeScript({ selector }) {
  return `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    return { kind: node ? 'present' : 'absent', selector: ${JSON.stringify(selector)} };
  })()`;
}

export function buildTextPresenceProbeScript({ text }) {
  return `(() => ({
    kind: document.body && document.body.textContent.includes(${JSON.stringify(text)}) ? 'present' : 'absent',
  }))()`;
}

export function buildTextCountProbeScript({ text }) {
  return `(() => ({
    kind: 'counted',
    count: Array.from(document.querySelectorAll('*')).filter((node) =>
      node.children.length === 0 && node.textContent.includes(${JSON.stringify(text)})
    ).length,
  }))()`;
}

export function buildSetTextareaValueScript({ selector, value }) {
  return `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { kind: 'missing', selector: ${JSON.stringify(selector)} };
    const prototype = node instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (!descriptor || typeof descriptor.set !== 'function') {
      return { kind: 'unavailable', code: 'value_descriptor_missing' };
    }
    descriptor.set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return { kind: 'set', value: node.value };
  })()`;
}

export function buildComposerEnabledProbeScript({ selector }) {
  return `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { kind: 'absent', selector: ${JSON.stringify(selector)} };
    return { kind: 'present', disabled: node.getAttribute('aria-disabled') === 'true' };
  })()`;
}

/**
 * The loaded external Session Agent journey for the real Tauri desktop
 * client. It consumes the incumbent driver-session selection and MCP CLI
 * helpers only; no second driver abstraction is introduced.
 */
export async function runSessionAgentMcpQa({
  env = process.env,
  config,
}) {
  if (!config || !config.appIdentifier) {
    throw new Error('desktop_session_agent_config_missing');
  }
  const artifactRoot = await ensureDir(join(
    repoRoot,
    '.project',
    'logs',
    'plugin-ui-desktop-qa',
    `tauri-session-agent-${nowStamp()}`,
  ));
  const attempts = [];
  const runCliJson = (args, options = {}) => runTauriMcpCliJson(args, {
    cwd: uiRoot,
    env: options.env ?? env,
    timeoutMs: options.timeoutMs,
  });
  const session = await startTargetedDriverSession({
    candidatePorts: [resolveDefaultDriverSessionPort({ env })],
    runCliJson,
    appendAttempt: async (attempt) => { attempts.push(attempt); },
    requireStackOwnedIdentifier: true,
    env,
  });
  const appIdentifier = String(session.resolvedAppIdentifier);
  if (appIdentifier !== config.appIdentifier) {
    throw new Error(`desktop_session_agent_driver_target_mismatch:${appIdentifier}:${config.appIdentifier}`);
  }
  const runWebviewScript = async (script) => unwrapWebviewScriptValue(await runCliJson(
    ['webview-execute-js', '--script', script, '--app-identifier', appIdentifier],
    { timeoutMs: config.scriptTimeoutMs },
  ));

  const waitForSelector = async ({ selector, timeoutMs }) => {
    await runTauriMcpCli([
      'webview-wait-for',
      '--type', 'selector',
      '--strategy', 'css',
      '--value', selector,
      '--timeout', String(Math.max(1, Math.floor(timeoutMs / 1000))),
      '--app-identifier', appIdentifier,
    ], { cwd: uiRoot, env, timeoutMs: timeoutMs + 15_000 });
  };
  const probeUntil = async (params) => {
    const deadline = Date.now() + params.timeoutMs;
    for (;;) {
      const probe = readRecord(await runWebviewScript(params.script));
      if (params.accept(probe)) return probe;
      if (Date.now() >= deadline) {
        throw new Error(`desktop_session_agent_probe_timeout:${params.code}`);
      }
      await new Promise((resolveDelay) => { setTimeout(resolveDelay, 500); });
    }
  };
  const waitForPresent = ({ selector, timeoutMs, code }) => probeUntil({
    script: buildPresenceProbeScript({ selector }),
    timeoutMs,
    code,
    accept: (probe) => readRecord(probe)?.kind === 'present',
  });
  const waitForAbsent = ({ selector, timeoutMs, code }) => probeUntil({
    script: buildPresenceProbeScript({ selector }),
    timeoutMs,
    code,
    accept: (probe) => readRecord(probe)?.kind === 'absent',
  });
  const waitForText = ({ text, timeoutMs }) => probeUntil({
    script: buildTextPresenceProbeScript({ text }),
    timeoutMs,
    code: `text_absent:${text}`,
    accept: (probe) => readRecord(probe)?.kind === 'present',
  });
  const clickSelector = async ({ selector }) => {
    const result = readRecord(await runWebviewScript(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { kind: 'missing', selector: ${JSON.stringify(selector)} };
    node.click();
    return { kind: 'clicked', selector: ${JSON.stringify(selector)} };
  })()`));
    if (!result || result.kind !== 'clicked') {
      throw new Error(`desktop_session_agent_click_failed:${selector}:${JSON.stringify(result)}`);
    }
  };
  const clickTestIdentifier = (testId) => clickSelector({ selector: buildTestIdentifierSelector(testId) });

  await runWebviewScript(buildNavigationScript(config.route));
  await waitForPresent({
    selector: buildTestIdentifierSelector(config.selectors.newSessionComposerInput),
    timeoutMs: config.selectorTimeoutMs,
    code: 'new_session_composer_absent',
  });
  await clickTestIdentifier(config.selectors.agentChip);
  const optionSelector = buildTestIdentifierSelector(config.selectors.chipPickerOption);
  await waitForPresent({
    selector: optionSelector,
    timeoutMs: config.selectorTimeoutMs,
    code: 'qualified_chip_picker_option_absent',
  });
  await clickSelector({ selector: optionSelector });

  await waitForPresent({
    selector: buildTestIdentifierSelector(config.selectors.newSessionComposerInput),
    timeoutMs: config.selectorTimeoutMs,
    code: 'composer_after_selection_absent',
  });
  const setText = readRecord(await runWebviewScript(buildSetTextareaValueScript({
    selector: buildTestIdentifierSelector(config.selectors.newSessionComposerInput),
    value: config.prompt,
  })));
  if (!setText || setText.kind !== 'set') {
    throw new Error(`desktop_session_agent_composer_input_failed:${JSON.stringify(setText)}`);
  }
  await clickTestIdentifier(config.selectors.newSessionComposerSend);

  await waitForPresent({
    selector: buildTestIdentifierSelector(config.selectors.permissionAllow),
    timeoutMs: config.confirmationTimeoutMs,
    code: 'host_confirmation_absent',
  });
  await clickTestIdentifier(config.selectors.permissionAllow);
  await waitForText({ text: config.assistantText, timeoutMs: config.assistantTimeoutMs });
  await waitForText({ text: config.reasoningText, timeoutMs: config.selectorTimeoutMs });
  const assistantCountBeforeCancel = readRecord(await runWebviewScript(buildTextCountProbeScript({
    text: config.assistantText,
  })))?.count;
  if (typeof assistantCountBeforeCancel !== 'number' || assistantCountBeforeCancel < 1) {
    throw new Error('desktop_session_agent_assistant_count_missing_before_cancel');
  }

  await waitForPresent({
    selector: buildTestIdentifierSelector(config.selectors.sessionComposerInput),
    timeoutMs: config.selectorTimeoutMs,
    code: 'session_composer_absent',
  });
  const cancelSetText = readRecord(await runWebviewScript(buildSetTextareaValueScript({
    selector: buildTestIdentifierSelector(config.selectors.sessionComposerInput),
    value: config.cancelPrompt,
  })));
  if (!cancelSetText || cancelSetText.kind !== 'set') {
    throw new Error(`desktop_session_agent_cancel_input_failed:${JSON.stringify(cancelSetText)}`);
  }
  await clickTestIdentifier(config.selectors.sessionComposerSend);
  await waitForPresent({
    selector: buildTestIdentifierSelector(config.selectors.permissionAllow),
    timeoutMs: config.confirmationTimeoutMs,
    code: 'cancel_confirmation_absent',
  });
  await clickTestIdentifier(config.selectors.abort);
  await waitForAbsent({
    selector: buildTestIdentifierSelector(config.selectors.permissionAllow),
    timeoutMs: config.confirmationTimeoutMs,
    code: 'cancel_confirmation_never_settled',
  });
  const composerAfterCancel = readRecord(await runWebviewScript(buildComposerEnabledProbeScript({
    selector: buildTestIdentifierSelector(config.selectors.sessionComposerInput),
  })));
  if (!composerAfterCancel || composerAfterCancel.kind !== 'present' || composerAfterCancel.disabled === true) {
    throw new Error('desktop_session_agent_cancel_turn_not_terminal');
  }
  const assistantCountAfterCancel = readRecord(await runWebviewScript(buildTextCountProbeScript({
    text: config.assistantText,
  })))?.count;
  if (assistantCountAfterCancel !== assistantCountBeforeCancel) {
    throw new Error(`desktop_session_agent_cancel_published_assistant:${String(assistantCountBeforeCancel)}:${String(assistantCountAfterCancel)}`);
  }
  const cancelledPromptProbe = readRecord(await runWebviewScript(buildTextPresenceProbeScript({
    text: `Prompt: ${config.cancelPrompt}`,
  })));
  if (cancelledPromptProbe?.kind !== 'absent') {
    throw new Error('desktop_session_agent_cancelled_prompt_published');
  }

  await writeTextArtifact(join(artifactRoot, 'result.json'), `${JSON.stringify({
    kind: 'observed',
    appIdentifier,
    driverTarget: session.resolvedAppTarget,
    attempts,
    qualifiedAgentId: config.qualifiedAgentId,
    identity: {
      pluginId: config.pluginId,
      agentLocalId: config.agentLocalId,
    },
    proof: {
      qualifiedSelectionObserved: true,
      confirmationSettled: true,
      assistantTextPresent: true,
      reasoningTextPresent: true,
      cancellationTerminal: true,
    },
  }, null, 2)}\n`);
  return { artifactRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configIndex = process.argv.indexOf('--config');
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : null;
  if (!configPath) {
    process.stderr.write('desktop_session_agent_config_path_required\n');
    process.exit(2);
  } else {
    import('node:fs').then(({ readFileSync }) => {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      return runSessionAgentMcpQa({ config });
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  }
}
