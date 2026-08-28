import { dirname, join, resolve } from 'node:path';
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

export function buildHostedArtifactCapabilityProbeScript() {
  return `(async () => {
    try {
      const core = window.__TAURI__ && window.__TAURI__.core;
      if (!core || typeof core.invoke !== 'function') {
        return { kind: 'unavailable', code: 'desktop_tauri_invoke_unavailable' };
      }
      return await core.invoke('desktop_hosted_artifact_get_frame_capability');
    } catch (error) {
      return {
        kind: 'unavailable',
        code: 'desktop_hosted_artifact_capability_probe_failed',
        detail: String(error && error.message ? error.message : error),
      };
    }
  })()`;
}

export function buildHostedArtifactIdentityProbeScript({ surfaceId }) {
  const selector = `[data-testid="plugin-surface-interaction-boundary:${surfaceId}"]`;
  return `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { kind: 'missing', selector: ${JSON.stringify(selector)} };
    return {
      kind: 'present',
      interactionState: node.getAttribute('data-plugin-interaction-state'),
      pluginId: node.getAttribute('data-plugin-id'),
      generation: node.getAttribute('data-plugin-generation'),
      artifactDigest: node.getAttribute('data-plugin-artifact-digest'),
      machineId: node.getAttribute('data-plugin-machine-id'),
      serverId: node.getAttribute('data-plugin-server-id'),
    };
  })()`;
}

export function buildHostedArtifactRouteProbeScript() {
  return `(() => window.location.pathname + window.location.search + window.location.hash)()`;
}

export function unwrapTauriMcpValue(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      return unwrapTauriMcpValue(JSON.parse(text));
    } catch {
      return text;
    }
  }
  const record = readRecord(value);
  if (!record) return value ?? null;
  if (Object.hasOwn(record, 'kind')) return record;
  if (typeof record.text === 'string') return unwrapTauriMcpValue(record.text);
  if (Array.isArray(record.content)) {
    for (const entry of record.content) {
      const unwrapped = unwrapTauriMcpValue(entry);
      if (unwrapped != null) return unwrapped;
    }
  }
  if (Object.hasOwn(record, 'result')) return unwrapTauriMcpValue(record.result);
  return record;
}

export function assertHostedArtifactRuntimeIdentity(actualValue, expected) {
  const actual = readRecord(unwrapTauriMcpValue(actualValue));
  if (!actual || actual.kind !== 'present') {
    throw new Error('desktop_hosted_artifact_surface_identity_missing');
  }
  for (const key of ['pluginId', 'generation', 'artifactDigest', 'machineId', 'serverId']) {
    if (actual[key] !== expected[key]) {
      throw new Error(`desktop_hosted_artifact_surface_identity_mismatch:${key}:${String(actual[key])}:${expected[key]}`);
    }
  }
  if (actual.interactionState !== 'enabled') {
    throw new Error(`desktop_hosted_artifact_surface_not_interactive:${String(actual.interactionState)}`);
  }
  return actual;
}

function buildNavigationScript(route) {
  return `(() => {
    const next = ${JSON.stringify(route)};
    window.history.pushState({}, '', next);
    window.dispatchEvent(new PopStateEvent('popstate'));
    return window.location.pathname + window.location.search + window.location.hash;
  })()`;
}

async function runWebviewScript(script, { appIdentifier, env }) {
  const response = await runTauriMcpCliJson([
    'webview-execute-js',
    '--script',
    script,
    '--app-identifier',
    appIdentifier,
  ], { cwd: uiRoot, env });
  return unwrapTauriMcpValue(response);
}

async function captureLoadedBoundary({ artifactRoot, appIdentifier, env }) {
  // These MCP artifacts inspect the main Tauri webview and therefore prove
  // only the host interaction boundary. The direct-Wry child requires the
  // separate native-window/VoiceOver checks written below.
  const screenshotPath = join(artifactRoot, '01-host-boundary.png');
  await runTauriMcpCli([
    'webview-screenshot', '--format', 'png', '--file-path', screenshotPath,
    '--app-identifier', appIdentifier,
  ], { cwd: uiRoot, env });
  for (const type of ['structure', 'accessibility']) {
    const response = await runTauriMcpCli([
      'webview-dom-snapshot', '--type', type, '--app-identifier', appIdentifier,
    ], { cwd: uiRoot, env });
    await writeTextArtifact(join(artifactRoot, `01-host-boundary.${type}.yml`), response.stdout);
  }
  return screenshotPath;
}

export async function runHostedArtifactPluginUiMcpQa({
  env = process.env,
  config,
  runtimeAttribution,
}) {
  if (!config || !runtimeAttribution) {
    throw new Error('desktop_hosted_artifact_canonical_attestation_missing');
  }
  const artifactRoot = await ensureDir(join(
    repoRoot,
    '.project',
    'logs',
    'plugin-ui-desktop-qa',
    `tauri-hosted-artifact-${nowStamp()}`,
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
    throw new Error(`desktop_hosted_artifact_driver_target_mismatch:${appIdentifier}:${config.appIdentifier}`);
  }
  const capability = await runWebviewScript(buildHostedArtifactCapabilityProbeScript(), { appIdentifier, env });
  const captureAttribution = Object.freeze({
    ...runtimeAttribution,
    appIdentifier: config.appIdentifier,
    driverTarget: session.resolvedAppTarget,
    attempts,
  });
  if (!readRecord(capability) || capability.kind !== 'available') {
    const blocker = readRecord(capability)?.code ?? 'desktop_hosted_artifact_frame_capability_unavailable';
    await writeTextArtifact(join(artifactRoot, 'result.json'), `${JSON.stringify({
      kind: 'blocked', blocker, capability, runtime: captureAttribution,
    }, null, 2)}\n`);
    throw new Error(`desktop_hosted_artifact_loaded_proof_blocked:${blocker}:${artifactRoot}`);
  }

  await runWebviewScript(buildNavigationScript(config.route), { appIdentifier, env });
  const selector = `[data-testid="plugin-surface-interaction-boundary:${config.surfaceId}"]`;
  await runTauriMcpCli([
    'webview-wait-for',
    '--type', 'selector',
    '--strategy', 'css',
    '--value', selector,
    '--timeout', '15000',
    '--app-identifier', appIdentifier,
  ], { cwd: uiRoot, env });
  const currentRoute = await runWebviewScript(buildHostedArtifactRouteProbeScript(), { appIdentifier, env });
  if (currentRoute !== config.route) {
    throw new Error(`desktop_hosted_artifact_route_mismatch:${String(currentRoute)}:${config.route}`);
  }
  const identity = assertHostedArtifactRuntimeIdentity(
    await runWebviewScript(buildHostedArtifactIdentityProbeScript({ surfaceId: config.surfaceId }), {
      appIdentifier,
      env,
    }),
    config.expected,
  );
  await captureLoadedBoundary({ artifactRoot, appIdentifier, env });
  await writeTextArtifact(join(artifactRoot, 'manual-native-child-checks.md'), [
    '# Hosted Artifact native-child loaded checks',
    '',
    '- Capture the complete native macOS window (not only the main Tauri webview) and confirm the direct-Wry child pixels are present.',
    `- Confirm VoiceOver exposes one embedded-content boundary named \`${config.title}\` without hiding guest descendants.`,
    '- In the guest, activate **Refresh review status** and confirm the public bridge response renders.',
    '- Activate **Open review history**, then use Happier Back and confirm native history reports and consumes the first Back.',
    '- Reload/update the development plugin and confirm the previous generation retires and refuses late bridge work.',
    '- Disconnect the daemon and confirm the retained Artifact remains visible but interaction is disabled; reconnect and confirm the exact current generation resumes.',
    '- Uninstall/reinstall and confirm stale tokens remain denied while current bytes load again.',
    '',
    'Do not mark the desktop capability proved until these native-child checks and exact identities are recorded.',
    '',
  ].join('\n'));
  await writeTextArtifact(join(artifactRoot, 'result.json'), `${JSON.stringify({
    kind: 'capture_ready_for_native_child_checks',
    capability,
    runtime: captureAttribution,
    identity,
    title: config.title,
    hostBoundaryOnly: true,
    nativeChildProofComplete: false,
  }, null, 2)}\n`);
  return { artifactRoot, capability, identity };
}
