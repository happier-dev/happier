import { createHash } from 'node:crypto';

import {
  readManagedServiceEndpointUrl,
  type ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';
import type {
  AgentExternalSessionsManagedEndpointServiceRequest,
} from '@happier-dev/plugin-sdk/sessions/external';

import { buildOpenCodeManagedServerAttachSpec } from '../../../runtime/server/attachSpec.js';
import { buildOpenCodeManagedServerSpawnSpec } from '../../../runtime/server/spawnSpec.js';
import { projectOpenCodeExternalSessionSource } from './client.js';

export const OPENCODE_EXTERNAL_SESSIONS_SERVICE_ID = 'opencode-external-sessions-server';

/**
 * A generation-scoped browse surface can see several configured servers at
 * once, and the managed-services owner keys one supervised service per service
 * id. A stable per-origin suffix keeps two attached servers from colliding on
 * one entry without inventing a registry to track them.
 */
function attachServiceId(baseUrl: string): string {
  const digest = createHash('sha256').update(baseUrl).digest('hex').slice(0, 32);
  return `${OPENCODE_EXTERNAL_SESSIONS_SERVICE_ID}/attach/${digest}`;
}

/**
 * The shared endpoint owner admits only HTTPS remote endpoints and HTTP
 * loopback. OpenCode keeps the admitted request base path, but drops query and
 * fragment before either the managed-service identity or the request path can
 * observe them.
 */
function normalizeAttachBaseUrl(value: string): string | null {
  const read = readManagedServiceEndpointUrl(value, {
    hostPolicy: 'userDeclaredAttach',
    allowSearch: true,
    allowHash: true,
  });
  if (!read.ok) return null;
  const url = new URL(read.endpoint.baseUrl);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/u, '');
}

/**
 * Declares the OpenCode server that serves External Sessions reads.
 *
 * Both shapes are managed services, which is the point: browse and Session
 * runtime reach an OpenCode server through one owner, one credential
 * mechanism and one transport, whether Happier owns the process or the user
 * does.
 *
 * - No configured base URL — Happier spawns a data-root-scoped server and
 *   mints its own credential.
 * - A configured base URL — the user's own process; Happier attaches to it and
 *   the host applies the password the user recorded, if any.
 */
export function resolveOpenCodeExternalSessionsManagedService(
  request: AgentExternalSessionsManagedEndpointServiceRequest,
): ManagedServiceSpec | null {
  const source = projectOpenCodeExternalSessionSource(request.source);
  if (!source) return null;
  const baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '';
  if (baseUrl) {
    const normalizedBaseUrl = normalizeAttachBaseUrl(baseUrl);
    if (!normalizedBaseUrl) return null;
    return buildOpenCodeManagedServerAttachSpec({
      id: attachServiceId(normalizedBaseUrl),
      baseUrl: normalizedBaseUrl,
    });
  }
  if (source.managedEndpoint !== true) return null;
  return buildOpenCodeManagedServerSpawnSpec({
    id: OPENCODE_EXTERNAL_SESSIONS_SERVICE_ID,
    additionalEnv: {
      // A read-only browse surface must never prune the user's OpenCode
      // corpus, and `opencode serve` prunes on start by default.
      OPENCODE_DISABLE_PRUNE: '1',
    },
  });
}
