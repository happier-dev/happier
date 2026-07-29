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

export function resolveServerRuntimeLaunchSpec({ serverComponent, snapshot }) {
  const admittedServerComponent = resolveAdmittedServerComponent({ serverComponent, snapshot });
  const runtimeRoot = snapshot.launchPath ?? snapshot.snapshotPath;
  const serverDir = join(runtimeRoot, 'server');
  const entrypoint =
    resolveRuntimeManifestEntrypoint({ snapshotPath: runtimeRoot, manifest: snapshot?.manifest, component: 'server' }) ||
    join(serverDir, 'happier-server');
  const migration = admittedServerComponent === 'happier-server'
    ? {
        command: join(serverDir, `happier-server-migrate${entrypoint.toLowerCase().endsWith('.exe') ? '.exe' : ''}`),
        args: [],
        cwd: serverDir,
      }
    : undefined;

  return {
    source: 'runtime',
    serverDir,
    entrypoint,
    command: entrypoint,
    args: [],
    ...(migration ? { migration } : {}),
  };
}
