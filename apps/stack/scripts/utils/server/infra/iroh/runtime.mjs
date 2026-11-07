import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHappyStacksHomeDir } from '../../../paths/paths.mjs';
import { withJsonOwnerFileLock } from '../../../proc/jsonOwnerFileLock.mjs';
import { killProcessTree, spawnProc } from '../../../proc/proc.mjs';
import { killPidOwnedByStack } from '../../../proc/ownership.mjs';
import { pickNextFreeTcpPort } from '../../../net/ports.mjs';
import { tailscaleServeEnable, tailscaleServeReset, tailscaleServeStatus } from '../../../net/tailscale_serve.mjs';
import { tailscaleRelayCertificate } from './certificate.mjs';
import { TailscaleCommandError, runTailscaleStatus, runTailscaleFunnelEnable,
  runTailscaleFunnelDisable } from '@happier-dev/cli-common/tailscale';
import { tailscaleEnableTimeoutMs, tailscaleProbeTimeoutMs } from '../../../net/tailscale_serve.mjs';
import { STACK_LISTENER_OBSERVATION_TIMEOUT_MS } from '../../listener_ownership.mjs';
import { resolveServerReadyTimeoutMs, waitForHttpOk } from '../../server.mjs';
import { getStackRuntimeProcessInstanceFingerprint, isStackRuntimeProcessTrusted,
  readStackRuntimeStateFile, recordStackRuntimeUpdate, writeStackRuntimeStateFile } from '../../../stack/runtime_state.mjs';
import { ensureRelayBinary } from './binary.mjs';
import { recordedRelayListener, relayHttpsPortFromState, relayListenerFailure, selectRelayHttpsPort } from './listener.mjs';
import { relayStartupFailure } from './failure.mjs';
import { readRelayProfile, renderRelayConfiguration, resolveRelayRequest,
  projectRelayEnvironment, relayFunnelEnabled, resolveRelayFunnelDecision } from './configuration.mjs';

const HOST_RELAY_OWNER = 'host-iroh-relay';

function pathsFor(env) {
  const directory = join(getHappyStacksHomeDir(env), 'iroh-relay');
  return { directory, statePath: join(directory, 'stack.runtime.json'), lockPath: join(directory, 'lifecycle.lock') };
}

function degraded(reason, remediation) {
  return { status: 'degraded', reason, httpsUrl: null, upstreamUrl: null, version: null,
    remediation: remediation ?? null, target: null };
}

export function relayProcessEnvironment(env) {
  const inherited = new Set(['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT',
    'TEMP', 'TMP', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'TOKIO_WORKER_THREADS']);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => inherited.has(key))),
    HAPPIER_STACK_STACK: HOST_RELAY_OWNER,
    HAPPIER_STACK_ENV_FILE: join(pathsFor(env).directory, 'env'),
    HAPPIER_STACK_PROCESS_KIND: 'infra',
    RUST_LOG: 'warn',
  };
}

async function ownsRelayProcess(state, env) {
  const pid = state?.processes?.relayPid;
  return await isStackRuntimeProcessTrusted(pid, { stackName: HOST_RELAY_OWNER,
    envPath: join(pathsFor(env).directory, 'env'), key: 'relayPid',
    processInstanceFingerprint: getStackRuntimeProcessInstanceFingerprint(state, 'relayPid', pid),
    recordedStartedAt: state?.startedAt });
}

async function readRelayHealth(upstreamUrl, signal) {
  try {
    const response = await fetch(`${upstreamUrl}/healthz`, { signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(STACK_LISTENER_OBSERVATION_TIMEOUT_MS)])
      : AbortSignal.timeout(STACK_LISTENER_OBSERVATION_TIMEOUT_MS) });
    const value = await response.json();
    return response.ok && value?.status === 'ok' ? value : null;
  } catch { return null; }
}

async function observeHostRelay(state, env, signal, serveStatusText) {
  if (!state?.irohRelay || !await ownsRelayProcess(state, env)) {
    const failure = state?.irohRelay?.failure;
    const result = degraded(failure?.retryable === false ? failure.code : 'relay_process_unavailable',
      failure?.remediation);
    return failure ? { ...result, failure } : result;
  }
  const relay = state.irohRelay;
  const health = await readRelayHealth(relay.upstreamUrl, signal);
  if (!health || health.version !== relay.version) return degraded('relay_health_unavailable');
  const listener = recordedRelayListener({
    serveStatusText: serveStatusText ?? await tailscaleServeStatus({ env, signal, json: true }), runtimeState: state,
    allowFunnel: true,
  });
  const httpsUrl = listener?.httpsUrl;
  if (!httpsUrl || httpsUrl !== relay.httpsUrl) return degraded('relay_serve_unavailable');
  const observed = { status: 'ready', httpsUrl, exposure: listener.exposure, upstreamUrl: relay.upstreamUrl, version: relay.version,
    reason: null, remediation: null, target: null };
  if (listener.exposure === 'tailnet' && relayFunnelEnabled(state)) {
    return { ...observed, status: 'degraded', reason: 'funnel_unavailable',
      remediation: relay.failure?.remediation ?? 'Resolve the Tailscale Funnel refusal on the server host, then retry ensure. The relay remains available on the tailnet.',
      failure: relay.failure ?? { phase: 'funnel_enable', code: 'funnel_unavailable' } };
  }
  return observed;
}

async function settlePreparedHostRelay(state, env, signal, serveStatusText) {
  const observed = await observeHostRelay(state, env, signal, serveStatusText);
  if (observed.status === 'ready' && (state?.irohRelay?.failure
    || state?.irohRelay?.exposure !== observed.exposure)) {
    // An explicit successful repair retires the old refusal. Ordinary healthy
    // ensures remain read-only, and observational status never clears a cause.
    await recordStackRuntimeUpdate(pathsFor(env).statePath, {
      irohRelay: { status: 'ready', exposure: observed.exposure, reason: null, remediation: null, failure: null },
    });
  }
  return observed;
}

export async function inspectStackRelay({ env = process.env, runtimeState, repoDir, stackBaseDir,
  serverTarget, executorDependencies } = {}) {
  const recorded = runtimeState?.irohRelay;
  if (!recorded) return { status: 'not_started', httpsUrl: null };
  if (recorded.status !== 'ready' && recorded.reason !== 'funnel_unavailable') return recorded;
  if (recorded.target) {
    // HTTPS health cannot attest Funnel exposure. Ask the same host owner
    // that publishes the listener; inspection never repairs or configures it.
    try {
      let target = serverTarget;
      if (!target) {
        const { loadDevTargetsConfig } = await import('../../../dev_targets/config.mjs');
        const loaded = await loadDevTargetsConfig({ stackName: env.HAPPIER_STACK_STACK, env });
        target = loaded.config.targets.find(candidate => candidate.name === recorded.target);
      }
      if (!repoDir || target?.name !== recorded.target) throw new Error('Relay target unavailable');
      const { inspectRelayOnTarget } = await import('./placement.mjs');
      return await inspectRelayOnTarget({ serverTarget: target, repoDir, stackBaseDir, env, executorDependencies });
    } catch {
      return { ...degraded('relay_observation_unavailable'), exposure: null, target: recorded.target };
    }
  }
  try { return await observeHostRelay(await readStackRuntimeStateFile(pathsFor(env).statePath), env); }
  catch (error) {
    return error instanceof TailscaleCommandError && error.failure
      ? relayStartupFailure(error, 'observation') : degraded('relay_observation_unavailable');
  }
}

export async function inspectHostRelay({ env = process.env, repoDir } = {}) {
  const state = await readStackRuntimeStateFile(pathsFor(env).statePath);
  if (!state?.irohRelay) return { status: 'not_started', httpsUrl: null };
  let observed;
  try { observed = await observeHostRelay(state, env); }
  catch (error) {
    return error instanceof TailscaleCommandError && error.failure
      ? relayStartupFailure(error, 'observation') : degraded('relay_observation_unavailable');
  }
  // Host tools status can recover an exited managed relay through the same
  // owner as stack preparation. Inspection without a repo stays read-only.
  if (repoDir && state.processes?.relayPid && observed.reason === 'relay_process_unavailable'
    && resolveRelayRequest(env) === 'managed') {
    return await prepareHostRelay({ repoDir, env, recoverOnly: true });
  }
  return observed;
}

async function removeRelayListener(state, env, signal) {
  const listener = recordedRelayListener({ runtimeState: state, allowFunnel: true, exclusive: true,
    serveStatusText: await tailscaleServeStatus({ env, signal, json: true }) });
  // Cleanup observes exposure even if publication failed before recording it.
  // It never adopts an unrecorded listener or changes another route's exposure.
  if (listener?.exposure === 'public') {
    await runTailscaleFunnelDisable({ env, signal, httpsPort: listener.port, servePath: '/',
      timeoutMs: tailscaleEnableTimeoutMs(env) });
    return;
  }
  // A changed listener can retire only our matching root, preserving foreign handlers.
  await tailscaleServeReset({ upstreamUrl: state.irohRelay.upstreamUrl,
    internalServerUrl: state.irohRelay.upstreamUrl, servePath: '/', httpsPort: relayHttpsPortFromState(state), env });
}

async function publishRelayListener(state, httpsPort, funnel, env, signal) {
  if (state.irohRelay.httpsUrl && (httpsPort !== relayHttpsPortFromState(state)
    || (state.irohRelay.exposure === 'public' && !funnel))) await removeRelayListener(state, env, signal);
  // Record ownership before the effect. Exposure is unknown until JSON readback.
  await recordStackRuntimeUpdate(pathsFor(env).statePath, { ports: { relayHttps: httpsPort },
    irohRelay: { httpsUrl: null, exposure: null } });
  const upstreamUrl = state.irohRelay.upstreamUrl;
  // Establish the usable tailnet route before attempting optional public access.
  await tailscaleServeEnable({ internalServerUrl: upstreamUrl, upstreamUrl,
    servePath: '/', httpsPort, env, openApproval: false, signal });
  let failure = null;
  if (funnel) {
    try {
      const result = await runTailscaleFunnelEnable({ env, signal, upstreamUrl, servePath: '/', httpsPort,
        timeoutMs: tailscaleEnableTimeoutMs(env) });
      if (result.approvalUrl) failure = { phase: 'funnel_enable', code: 'tailscale_funnel_approval_required' };
    } catch (error) {
      signal?.throwIfAborted();
      failure = relayStartupFailure(error, 'funnel_enable').failure;
    }
  }
  const serveStatusText = await tailscaleServeStatus({ env, signal, json: true });
  const listener = recordedRelayListener({ serveStatusText, allowFunnel: true,
    runtimeState: { ports: { relayHttps: httpsPort }, irohRelay: { upstreamUrl } } });
  if (!listener) throw Object.assign(new Error('The relay TLS listener is not available'), { code: 'relay_serve_unavailable' });
  await recordStackRuntimeUpdate(pathsFor(env).statePath, {
    irohRelay: { httpsUrl: listener.httpsUrl, exposure: listener.exposure, failure },
  });
  return serveStatusText;
}

async function stopHostRelayLocked(env) {
  const { statePath } = pathsFor(env);
  const state = await readStackRuntimeStateFile(statePath);
  if (!state?.irohRelay || state.irohRelay.status === 'degraded') return { stopped: false, reason: 'not_started' };
  if (state.irohRelay.exposure === 'public') await removeRelayListener(state, env);
  const pid = state.processes?.relayPid;
  const stopped = await killPidOwnedByStack(pid, { stackName: HOST_RELAY_OWNER,
    envPath: join(pathsFor(env).directory, 'env'), label: 'iroh-relay', json: true, signal: 'SIGINT',
    processInstanceFingerprint: getStackRuntimeProcessInstanceFingerprint(state, 'relayPid', pid),
    recordedStartedAt: state.startedAt });
  if (!stopped.killed) return { stopped: false, reason: stopped.reason };
  if (state.irohRelay.exposure !== 'public') await removeRelayListener(state, env);
  await recordStackRuntimeUpdate(statePath, { ownerPid: null, processes: { relayPid: null }, irohRelay: null });
  return { stopped: true };
}

export async function stopHostRelay({ env = process.env } = {}) {
  return await withJsonOwnerFileLock(async () => {
    const result = await stopHostRelayLocked(env);
    if (result.stopped || result.reason === 'not_started') {
      await recordStackRuntimeUpdate(pathsFor(env).statePath, { relayFunnel: { enabled: false, stack: null } });
    }
    return result;
  }, { lockPath: pathsFor(env).lockPath });
}

async function prepareHostRelay({ repoDir, env, signal, recoverOnly = false }) {
  const paths = pathsFor(env);
  let phase = 'lock';
  try { return await withJsonOwnerFileLock(async () => {
    try {
    phase = 'state_read';
    signal?.throwIfAborted();
    let existing = await readStackRuntimeStateFile(paths.statePath);
    // Recheck under the lifecycle lock: an explicit stop that won the lock
    // before this recovery must not be undone by a stale status observation.
    if (recoverOnly && (!existing?.irohRelay || !existing.processes?.relayPid)) {
      return { status: 'not_started', httpsUrl: null };
    }
    const relayFunnel = resolveRelayFunnelDecision(existing, recoverOnly ? {} : env);
    const funnel = relayFunnel.enabled;
    if (existing?.relayFunnel?.enabled !== funnel || existing?.relayFunnel?.stack !== relayFunnel.stack) {
      await recordStackRuntimeUpdate(paths.statePath, { relayFunnel });
      existing = { ...existing, relayFunnel };
    }
    phase = 'profile';
    const profile = await readRelayProfile(repoDir);
    phase = 'serve_inventory';
    let serveStatusText;
    try { serveStatusText = await tailscaleServeStatus({ env, signal, json: true }); }
    catch (error) {
      signal?.throwIfAborted();
      if (error instanceof TailscaleCommandError && error.failure) throw error;
      throw relayListenerFailure('relay_serve_status_unavailable');
    }
    phase = 'listener_selection';
    // Opt-out first retires only the previously recorded public mapping, then
    // returns that port to the ordinary tailnet allocator.
    if (!funnel && existing?.irohRelay?.exposure === 'public') {
      await removeRelayListener(existing, env, signal);
      serveStatusText = await tailscaleServeStatus({ env, signal, json: true });
      existing.irohRelay = { ...existing.irohRelay, exposure: null, httpsUrl: null };
    }
    const relayHttpsPort = await selectRelayHttpsPort({ serveStatusText, runtimeState: existing, signal, funnel,
      tailscaleStatusText: funnel ? await runTailscaleStatus({ env, signal, json: true,
        timeoutMs: tailscaleProbeTimeoutMs(env) }) : undefined });
    // This existing per-host port record survives explicit stop and degraded
    // startup; all stacks on the host consume the same lifecycle owner.
    phase = 'state_write';
    if (existing?.ports?.relayHttps !== relayHttpsPort) {
      await recordStackRuntimeUpdate(paths.statePath, { ports: { relayHttps: relayHttpsPort } });
    }
    phase = 'process_inspection';
    if (existing?.irohRelay && await ownsRelayProcess(existing, env)) {
      if (existing.irohRelay.version !== profile.version) return degraded('relay_version_changed');
      const observed = await settlePreparedHostRelay(existing, env, signal, serveStatusText);
      if (observed.status !== 'ready' && !['relay_serve_unavailable', 'funnel_unavailable'].includes(observed.reason)) return observed;
      if (observed.status === 'ready' && relayHttpsPort === relayHttpsPortFromState(existing)
        && observed.exposure === (funnel ? 'public' : 'tailnet')) return observed;
      phase = 'serve_enable';
      const publishedStatus = await publishRelayListener(existing, relayHttpsPort, funnel, env, signal);
      phase = 'observation';
      return await settlePreparedHostRelay(await readStackRuntimeStateFile(paths.statePath), env, signal, publishedStatus);
    }
    if (existing?.irohRelay && existing.irohRelay.status !== 'degraded') {
      // The old forwarding route still belongs to this relay even when its
      // process has died and the loopback port has since been reused. Retire
      // only that recorded instance and exact route before publishing another.
      phase = 'retirement';
      const retired = await stopHostRelayLocked(env);
      if (!retired.stopped) return degraded('relay_retirement_unconfirmed');
    }
    phase = 'certificate';
    const certDir = join(paths.directory, 'certs');
    const { tailnetIp } = await tailscaleRelayCertificate({ certDir, env, signal });
    phase = 'binary';
    const binary = await ensureRelayBinary({ version: profile.version, env, signal });
    signal?.throwIfAborted();
    phase = 'ports';
    const httpPort = await pickNextFreeTcpPort(3340);
    const httpsPort = await pickNextFreeTcpPort(httpPort + 1);
    const metricsPort = await pickNextFreeTcpPort(httpsPort + 1);
    phase = 'configuration';
    const config = renderRelayConfiguration({ template: profile.template, httpPort, httpsPort, metricsPort,
      certDir, tailnetIp,
      receiveBytesPerSecond: env.HAPPIER_IROH_RELAY_RX_BYTES_PER_SECOND,
      receiveBurstBytes: env.HAPPIER_IROH_RELAY_RX_MAX_BURST_BYTES });
    await mkdir(paths.directory, { recursive: true });
    const configPath = join(paths.directory, 'relay.toml');
    const pendingConfig = `${configPath}.${process.pid}.tmp`;
    await writeFile(pendingConfig, config, { mode: 0o600 });
    await rename(pendingConfig, configPath);
    phase = 'spawn';
    const log = await open(join(paths.directory, 'relay.log'), 'a', 0o600);
    let child;
    try {
      // Stock --dev places forwarding on the loopback HTTP listener, while
      // retaining the configured TLS certificate and UDP listener for QAD.
      // Tailscale Serve supplies browser-trusted TLS for forwarding.
      child = spawnProc('iroh-relay', binary, ['--dev', '--config-path', configPath], relayProcessEnvironment(env),
        { silent: true, persistOutput: false, stdio: ['ignore', log.fd, log.fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    } finally { await log.close(); }
    child.unref();
    const upstreamUrl = `http://127.0.0.1:${httpPort}`;
    const state = { stackName: HOST_RELAY_OWNER, script: 'iroh-relay', ownerPid: child.pid,
      startedAt: new Date().toISOString(), processes: { relayPid: child.pid }, ports: { relayHttps: relayHttpsPort }, relayFunnel,
      irohRelay: null };
    state.irohRelay = { version: profile.version, upstreamUrl, httpsUrl: null, exposure: null };
    let recorded = false;
    try {
      phase = 'state_write';
      await writeStackRuntimeStateFile(paths.statePath, state);
      recorded = true;
      phase = 'health';
      await waitForHttpOk(`${upstreamUrl}/healthz`, {
        timeoutMs: resolveServerReadyTimeoutMs({ env }), signal, childProcess: child });
      const health = await readRelayHealth(upstreamUrl, signal);
      if (health?.version !== profile.version) throw Object.assign(new Error('Relay startup health failed'), { code: 'relay_health_unavailable' });
      phase = 'serve_enable';
      const publishedStatus = await publishRelayListener(state, relayHttpsPort, funnel, env, signal);
      phase = 'observation';
      return await settlePreparedHostRelay(await readStackRuntimeStateFile(paths.statePath), env, signal, publishedStatus);
    } catch (error) {
      // Failed startup still owns its direct child handle. Retire it before
      // cleaning its recorded route; no process-marker fallback is required.
      await killProcessTree(child, 'SIGINT');
      if (recorded) await stopHostRelayLocked(env);
      throw error;
    }
    } catch (error) {
      signal?.throwIfAborted();
      const result = relayStartupFailure(error, phase);
      try {
        const current = await readStackRuntimeStateFile(paths.statePath);
        // Keep ownership/route facts when failure precedes retirement. A fresh
        // failed attempt records diagnostics even though it has no child PID.
        // Replace the diagnostic as a whole: deep-merging would retain an old
        // command exit code when the next error has none. This host record is
        // owned by the same lifecycle lock as preparation and stop.
        await writeStackRuntimeStateFile(paths.statePath, { ...(current ?? {}), updatedAt: new Date().toISOString(),
          irohRelay: current?.irohRelay ? { ...current.irohRelay, failure: result.failure } : result });
      } catch {
        // A failed diagnostic write must not replace the originating error.
        return { ...result, diagnosticRetained: false };
      }
      return result;
    }
  }, { lockPath: paths.lockPath, signal }); }
  catch (error) {
    signal?.throwIfAborted();
    return relayStartupFailure(error, phase);
  }
}

export async function prepareStackRelay({ repoDir, env = process.env, runtimeStatePath, signal,
  serverTarget, stackBaseDir, executorDependencies } = {}) {
  const request = resolveRelayRequest(env);
  let relay;
  if (serverTarget && request === 'managed') {
    const { prepareRelayOnTarget } = await import('./placement.mjs');
    relay = await prepareRelayOnTarget({ serverTarget, repoDir, stackBaseDir, env, signal, executorDependencies });
  } else if (request !== 'managed') {
    // A stack opt-out controls use, never the shared host relay's lifetime.
    relay = { status: request === 'sandbox' ? 'disabled' : request, httpsUrl: null,
      upstreamUrl: null, version: null, reason: null, remediation: null, target: null };
  }
  else relay = await prepareHostRelay({ repoDir, env, signal });
  signal?.throwIfAborted();
  if (runtimeStatePath) await recordStackRuntimeUpdate(runtimeStatePath, { irohRelay: relay });
  return { env: projectRelayEnvironment(env, relay), relay };
}
