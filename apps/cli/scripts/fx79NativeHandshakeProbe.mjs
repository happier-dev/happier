import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COMPUTER_CUA_DRIVER_VERSION } from '@happier-dev/protocol/installables';
import { openNativeComputerTransport } from '../src/daemon/computer/driver/nativeTransport.ts';

const scratch = await mkdtemp(join(tmpdir(), 'fx79-handshake-'));
async function executable(version) {
  const path = join(scratch, version === COMPUTER_CUA_DRIVER_VERSION ? 'selected-driver.mjs' : 'foreign-driver.mjs');
  await writeFile(path, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
    result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cua-driver', version: ${JSON.stringify(version)} } } }) + '\\n');
});
`);
  await chmod(path, 0o755);
  return path;
}
try {
  const selected = await openNativeComputerTransport(await executable(COMPUTER_CUA_DRIVER_VERSION), ':73');
  assert.equal(selected.unavailable(), false);
  await selected.close();
  await assert.rejects(openNativeComputerTransport(await executable('wrong-version'), ':73'), { code: 'driver_version_mismatch' });
  process.stdout.write('PASS: descriptor-selected version accepted; foreign version refused and subprocess retired\n');
} finally { await rm(scratch, { recursive: true, force: true }); }
