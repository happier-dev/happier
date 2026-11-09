import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { resolveRuntimeManifestEntrypoint } from '../shared/runtime_manifest.mjs';

const SERVER_COMPONENTS = new Set(['happier-server', 'happier-server-light']);

export class RuntimeServerComponentError extends Error {
  constructor(message, { code, reason, requestedServerComponent = null, admittedServerComponent = null } = {}) {
    super(message);
    this.name = 'RuntimeServerComponentError';
    this.code = code;
    this.reason = reason;
    this.requestedServerComponent = requestedServerComponent;
    this.admittedServerComponent = admittedServerComponent;
  }
}

function resolveAdmittedServerComponent({ serverComponent, snapshot }) {
  const requestedServerComponent = String(serverComponent ?? '').trim();
  const admittedServerComponent = String(snapshot?.manifest?.source?.serverComponent ?? '').trim();
  if (!admittedServerComponent) {
    throw new RuntimeServerComponentError('[runtime] admitted snapshot server component is missing', {
      code: 'ERUNTIMESERVERCOMPONENTUNAVAILABLE',
      reason: 'missing_admitted_server_component',
      requestedServerComponent,
    });
  }
  if (!SERVER_COMPONENTS.has(admittedServerComponent)) {
    throw new RuntimeServerComponentError(`[runtime] admitted snapshot server component is unsupported: ${admittedServerComponent}`, {
      code: 'ERUNTIMESERVERCOMPONENTUNAVAILABLE',
      reason: 'unsupported_admitted_server_component',
      requestedServerComponent,
      admittedServerComponent,
    });
  }
  if (!SERVER_COMPONENTS.has(requestedServerComponent) || requestedServerComponent !== admittedServerComponent) {
    throw new RuntimeServerComponentError(
      `[runtime] requested server component ${requestedServerComponent || '<empty>'} does not match admitted snapshot component ${admittedServerComponent}`,
      {
        code: 'ERUNTIMESERVERCOMPONENTMISMATCH',
        reason: 'requested_admitted_server_component_mismatch',
        requestedServerComponent,
        admittedServerComponent,
      },
    );
  }
  return admittedServerComponent;
}

export function resolveServerRuntimeLaunchSpec({ serverComponent, dbProvider, snapshot, sourceRuntimeLaunch, migrationsEnabled = true,
  env = {}, stackBaseDir }) {
  const runtimeArgs = [];
  if (env.HAPPIER_STACK_SERVER_CPU_PROF === '1') {
    if (!sourceRuntimeLaunch || !stackBaseDir) {
      throw new Error('[runtime] server CPU profiling requires a source-runtime launch and its Stack state root');
    }
    const profileDir = join(stackBaseDir, 'logs', 'server-cpu-prof');
    mkdirSync(profileDir, { recursive: true });
    console.log(`[local] server: CPU profile output directory: ${profileDir}`);
    runtimeArgs.push('--cpu-prof', `--cpu-prof-dir=${profileDir}`, '--cpu-prof-interval=10000', '--disable-sigusr1');
  }
  if (sourceRuntimeLaunch) {
    return { ...sourceRuntimeLaunch, command: process.execPath,
      args: [...runtimeArgs, sourceRuntimeLaunch.entrypoint, ...(sourceRuntimeLaunch.args ?? [])],
      migration: migrationsEnabled && !sourceRuntimeLaunch.lastGreen
        ? sourceRuntimeLaunch.migration ?? { mode: 'in-process' } : { mode: 'disabled' } };
  }
  resolveAdmittedServerComponent({ serverComponent, snapshot });
  const runtimeRoot = snapshot.launchPath ?? snapshot.snapshotPath;
  const serverDir = join(runtimeRoot, 'server');
  const entrypoint = resolveRuntimeManifestEntrypoint({ snapshotPath: runtimeRoot, manifest: snapshot?.manifest, component: 'server' });
  if (!entrypoint) {
    throw new RuntimeServerComponentError('[runtime] admitted snapshot server entrypoint is missing', {
      code: 'ERUNTIMESERVERCOMPONENTUNAVAILABLE', reason: 'missing_admitted_server_entrypoint',
      requestedServerComponent: serverComponent,
      admittedServerComponent: snapshot.manifest.source.serverComponent,
    });
  }
  const migration = !migrationsEnabled
    ? { mode: 'disabled' }
    : dbProvider === 'postgres' || dbProvider === 'mysql' || dbProvider === 'pglite'
      ? {
        mode: 'packaged',
        command: join(serverDir, `happier-server-migrate${entrypoint.toLowerCase().endsWith('.exe') ? '.exe' : ''}`),
        args: [],
        cwd: serverDir,
      }
      : { mode: 'in-process' };

  return {
    source: 'runtime',
    serverDir,
    entrypoint,
    command: entrypoint,
    args: [],
    migration,
  };
}
