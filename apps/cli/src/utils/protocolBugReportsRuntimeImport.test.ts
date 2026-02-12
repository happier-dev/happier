import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { projectPath } from '@/projectPath';

function resolveProtocolBugReportsDistPath(): string {
  return resolve(join(projectPath(), '..', '..', 'packages', 'protocol', 'dist', 'bugReports.js'));
}

describe('protocol dist runtime import', () => {
  it('loads bugReports dist module in Node ESM runtime', async () => {
    const modulePath = resolveProtocolBugReportsDistPath();
    if (!existsSync(modulePath)) {
      throw new Error(`Expected built protocol module at ${modulePath}. Run "yarn --cwd packages/protocol build".`);
    }
    const moduleUrl = pathToFileURL(modulePath).href;
    const probeScript = `import(${JSON.stringify(moduleUrl)}).then((mod)=>{if(typeof mod.submitBugReportToService!=='function')process.exit(2);}).catch((err)=>{console.error(String(err&&err.stack||err));process.exit(1);});`;
    const res = spawnSync(process.execPath, ['-e', probeScript], { encoding: 'utf8' });
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
  });
});
