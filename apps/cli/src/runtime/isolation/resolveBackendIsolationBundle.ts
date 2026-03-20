import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import type { BackendIsolationBundle, BackendIsolationRequest } from './types';

export function resolveBackendIsolationBundle(request: BackendIsolationRequest): BackendIsolationBundle {
  const backendId = String(request.backendId ?? '').trim() || 'unknown';
  const scope = request.scope;
  const isolationId = String(request.isolationId ?? '').trim() || 'unknown';

  const root = join(configuration.activeServerDir, 'isolation', backendId, scope, isolationId);
  const xdgRoot = join(root, 'xdg');

  const xdgState = join(xdgRoot, 'state');
  const xdgCache = join(xdgRoot, 'cache');
  const xdgData = join(xdgRoot, 'data');

  try {
    mkdirSync(xdgState, { recursive: true });
    mkdirSync(xdgCache, { recursive: true });
    mkdirSync(xdgData, { recursive: true });
  } catch {
    // Best-effort: if directory creation fails, still return deterministic paths so callers can attempt to use them.
  }

  return {
    env: {
      XDG_STATE_HOME: xdgState,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

