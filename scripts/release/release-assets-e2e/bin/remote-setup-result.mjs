import { readFileSync } from 'node:fs';

// The CLI's JSON task result is authoritative even when its process exits 0.
// Keep task events and successful credential-bearing data out of smoke logs.
const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/u);
let result;
for (const line of lines) {
  try {
    const value = JSON.parse(line);
    if (value?.protocolVersion === 1 && typeof value.ok === 'boolean') result = value;
  } catch {
    // npm and hstack can emit non-JSON diagnostics before the task stream.
  }
}
if (result?.ok !== true) {
  console.error(JSON.stringify({
    ok: false,
    error: {
      code: typeof result?.error?.code === 'string' ? result.error.code : 'REMOTE_SETUP_RESULT_MISSING',
      message: typeof result?.error?.message === 'string' ? result.error.message : 'Remote setup produced no successful terminal task result',
    },
  }));
  process.exitCode = 1;
}
