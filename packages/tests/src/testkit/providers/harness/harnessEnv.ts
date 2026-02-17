import { join } from 'node:path';

export function applyHomeIsolationEnv(params: {
  cliHome: string;
  env: NodeJS.ProcessEnv;
  mode?: 'env' | 'host';
}): NodeJS.ProcessEnv {
  if (params.mode === 'host') {
    return {
      ...params.env,
      HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
    };
  }
  return {
    ...params.env,
    HOME: params.cliHome,
    XDG_CONFIG_HOME: join(params.cliHome, '.config'),
    USERPROFILE: params.cliHome,
    // Provider e2e runs must not auto-start detached daemons. Detached daemons can get stuck
    // in non-interactive auth flows and outlive the test harness, leaking provider processes.
    HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
  };
}

export function applyCliDevTsxTsconfigEnv(params: {
  repoRootDir: string;
  env: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  // Provider harness runs start the CLI via `yarn workspace @happier-dev/cli dev ...` from the repo root.
  // When the dev entrypoint uses TSX, the loader must know which tsconfig defines `@/*` path aliases.
  // Without an explicit TSX_TSCONFIG_PATH, TSX can pick up the wrong config and fail to resolve imports
  // like `@/backends/...` (manifesting as ERR_MODULE_NOT_FOUND at runtime).
  if (typeof params.env.TSX_TSCONFIG_PATH === 'string' && params.env.TSX_TSCONFIG_PATH.trim().length > 0) {
    return params.env;
  }
  return {
    ...params.env,
    TSX_TSCONFIG_PATH: join(params.repoRootDir, 'apps', 'cli', 'tsconfig.json'),
  };
}
