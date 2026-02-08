import { join } from 'node:path';

export function applyHomeIsolationEnv(params: {
  cliHome: string;
  env: NodeJS.ProcessEnv;
  mode?: 'env' | 'host';
}): NodeJS.ProcessEnv {
  if (params.mode === 'host') return params.env;
  return {
    ...params.env,
    HOME: params.cliHome,
    XDG_CONFIG_HOME: join(params.cliHome, '.config'),
    USERPROFILE: params.cliHome,
  };
}
