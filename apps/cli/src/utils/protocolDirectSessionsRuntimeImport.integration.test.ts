import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

function resolveProtocolDistPath(): string {
  return resolve(__dirname, '../../../../packages/protocol/dist/index.js');
}

function resolveProtocolDirectSessionsDistPath(): string {
  return resolve(__dirname, '../../../../packages/protocol/dist/directSessions/daemonRpcV1.js');
}

describe('protocol direct sessions dist runtime import', () => {
  it('loads direct session schemas in a Node ESM runtime', () => {
    const modulePath = resolveProtocolDistPath();
    if (!existsSync(modulePath)) {
      throw new Error(`Expected built protocol module at ${modulePath}. Run "yarn --cwd packages/protocol build".`);
    }

    const moduleUrl = pathToFileURL(modulePath).href;
    const probeScript = `import(${JSON.stringify(moduleUrl)}).then((mod)=>{const schema=mod.DirectSessionsCandidatesListResponseSchema;if(!schema)process.exit(2);schema.parse({ok:true,candidates:[{remoteSessionId:'s1',updatedAtMs:1}],nextCursor:null});}).catch((err)=>{console.error(String(err&&err.stack||err));process.exit(1);});`;
    const res = spawnSync(process.execPath, ['-e', probeScript], { encoding: 'utf8' });

    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
  });

  it('loads the directSessions daemon RPC module in a Node ESM runtime', () => {
    const modulePath = resolveProtocolDirectSessionsDistPath();
    if (!existsSync(modulePath)) {
      throw new Error(`Expected built protocol module at ${modulePath}. Run "yarn --cwd packages/protocol build".`);
    }

    const moduleUrl = pathToFileURL(modulePath).href;
    const probeScript = `import(${JSON.stringify(moduleUrl)}).then((mod)=>{const schema=mod.DirectSessionsCandidatesListResponseSchema;if(!schema)process.exit(2);schema.parse({ok:true,candidates:[{remoteSessionId:'s1',updatedAtMs:1}],nextCursor:null});}).catch((err)=>{console.error(String(err&&err.stack||err));process.exit(1);});`;
    const res = spawnSync(process.execPath, ['-e', probeScript], { encoding: 'utf8' });

    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
  });
});
