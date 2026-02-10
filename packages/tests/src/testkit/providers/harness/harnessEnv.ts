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
