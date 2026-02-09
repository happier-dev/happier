import './utils/env/env.mjs';

import { runSelfHostCli } from './self_host_runtime.mjs';

runSelfHostCli(process.argv.slice(2)).catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(msg);
  process.exit(1);
});
