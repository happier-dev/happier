import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTypescriptModuleInspectionSession,
} from './typescriptModuleInspection.ts';

const fixtureRoots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-typescript-inspection-'));
  fixtureRoots.push(root);
  await mkdir(join(root, 'plug#in'), { recursive: true });
  return root;
}

describe('per-Plugin TypeScript inspection worker', () => {
  it('closes after inspection even when the authored module retains a runtime timer', async () => {
    const root = await createFixture();
    const authored = join(root, 'plug#in', 'runtime-timer.mts');
    await writeFile(authored, 'setInterval(() => {}, 60_000);\nexport const READY = true;\n', 'utf8');
    let workerPid: number | undefined;
    let closed = false;
    const session = createTypescriptModuleInspectionSession({ onSpawn: pid => { workerPid = pid; } });
    try {
      await expect(session.inspect(authored)).resolves.toMatchObject({ READY: true });
      void session.close().then(() => { closed = true; });
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 });
    } finally {
      // Only this fixture's child is retired after a failing assertion.
      if (!closed && workerPid) process.kill(workerPid, 'SIGTERM');
      await session.close();
    }
  }, 120_000);
  it('lets the containing publication own elapsed time while valid inspection is pending', async () => {
    const root = await createFixture();
    const authored = join(root, 'plug#in', 'delayed.mts');
    await writeFile(authored, 'await new Promise(resolve => setTimeout(resolve, 50));\nexport const READY = true;\n', 'utf8');
    // The parent clock is a real system boundary. The isolated worker retains
    // its own clock and must be allowed to finish after the old local cutoff.
    vi.useFakeTimers();
    const session = createTypescriptModuleInspectionSession();
    try {
      const result = session.inspect(authored).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(180_001);
      expect(await result).toMatchObject({ value: { READY: true } });
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  }, 120_000);
  it('loads several authored modules through one isolated process', async () => {
    const root = await createFixture();
    const first = join(root, 'plug#in', 'first.ts');
    const second = join(root, 'plug#in', 'second.ts');
    await writeFile(first, 'export const FIRST = { value: 1 };\n', 'utf8');
    await writeFile(second, 'export const SECOND = { value: 2 };\n', 'utf8');
    let spawnCount = 0;
    const session = createTypescriptModuleInspectionSession({ onSpawn: () => { spawnCount += 1; } });
    try {
      await expect(session.inspect(first)).resolves.toMatchObject({ FIRST: { value: 1 } });
      await expect(session.inspect(second)).resolves.toMatchObject({ SECOND: { value: 2 } });
      expect(spawnCount).toBe(1);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('inspects the Codex authored manifest within the worker heap budget', async () => {
    const manifestPath = fileURLToPath(new URL(
      '../../../../../packages/plugins/codex/src/manifest.ts',
      import.meta.url,
    ));
    const session = createTypescriptModuleInspectionSession();
    try {
      await expect(session.inspect(manifestPath)).resolves.toMatchObject({
        PLUGIN_MANIFEST: { id: 'happier.agent.codex' },
      });
    } finally {
      await session.close();
    }
  }, 120_000);

  it('inspects the required Claude authored manifest through canonical source resolution', async () => {
    const manifestPath = fileURLToPath(new URL(
      '../../../../../packages/plugins/claude/src/manifest.ts',
      import.meta.url,
    ));
    const session = createTypescriptModuleInspectionSession();
    try {
      await expect(session.inspect(manifestPath)).resolves.toMatchObject({
        PLUGIN_MANIFEST: { id: 'happier.agent.claude' },
      });
    } finally {
      await session.close();
    }
  }, 240_000);

  it('inspects current SDK source exports without compiler declaration aliases', async () => {
    const root = await createFixture();
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    // A compiler declaration alias can point at installed bytes from an older SDK.
    // The source-tool worker must select the canonical source export instead.
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: {
      '@happier-dev/plugin-sdk/first-party/connected-accounts': ['./stale-profile.d.ts'],
    } } }), 'utf8');
    await writeFile(join(root, 'stale-profile.d.ts'), 'export { ANTIGRAVITY_OAUTH_PROFILE } from "./stale-profile.js";\n', 'utf8');
    await writeFile(join(root, 'stale-profile.js'), 'export const ANTIGRAVITY_OAUTH_PROFILE = {};\n', 'utf8');
    const sourceProfile = join(root, 'plug#in', 'source-profile.ts');
    await writeFile(sourceProfile, [
      "import { ANTIGRAVITY_OAUTH_PROFILE } from '@happier-dev/plugin-sdk/first-party/connected-accounts';",
      'export const SOURCE_PROFILE = { allowRawAuthorizationCode: ANTIGRAVITY_OAUTH_PROFILE.allowRawAuthorizationCode };',
    ].join('\n'), 'utf8');
    const ownerUrl = new URL('./typescriptModuleInspection.ts', import.meta.url).href;
    const sourceRuntimePath = fileURLToPath(new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url));
    // The inspector must not inherit compiler-only aliases from the invoking cwd.
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--conditions=happier-source', '--import', sourceRuntimePath, '--input-type=module', '-e',
      [
        `const { createTypescriptModuleInspectionSession } = await import(${JSON.stringify(ownerUrl)});`,
        'const session = createTypescriptModuleInspectionSession();',
        'try { console.log(JSON.stringify(await session.inspect(process.argv[1]))); } finally { await session.close(); }',
      ].join('\n'),
      sourceProfile,
    ], { cwd: root });
    expect(JSON.parse(stdout.trim())).toMatchObject({ SOURCE_PROFILE: { allowRawAuthorizationCode: true } });
  }, 120_000);

  it('carries a multi-byte character that straddles a stdout chunk boundary', async () => {
    // The worker answers over a pipe, and a pipe hands back chunks with no
    // regard for character boundaries. This is the real shape of a bundled
    // plugin manifest: its translations carry CJK, and a corrupted one is
    // published into `.happier-plugin/plugin.json` as mojibake with valid JSON
    // around it, so nothing downstream can notice.
    //
    // The split is unavoidable rather than aimed: every character here is three
    // bytes and the payload is far longer than one pipe chunk, so whatever
    // offset a chunk ends at, it lands mid-character unless it happens to be
    // divisible by three — and the next chunk boundary will not be. Aiming at a
    // single seam instead would depend on the response envelope's own length
    // and would silently stop testing anything.
    const root = await createFixture();
    const wide = join(root, 'plug#in', 'wide.ts');
    const value = '\u8be5'.repeat(80_000);
    await writeFile(
      wide,
      `export const WIDE = { value: ${JSON.stringify(value)} };\n`,
      'utf8',
    );
    const session = createTypescriptModuleInspectionSession();
    try {
      const inspected = await session.inspect(wide) as Readonly<{ WIDE: { value: string } }>;
      expect(inspected.WIDE.value).not.toContain('\ufffd');
      expect(inspected.WIDE.value).toBe(value);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('contains an authored module that terminates its worker process', async () => {
    const root = await createFixture();
    const terminating = join(root, 'plug#in', 'terminating.ts');
    await writeFile(terminating, 'process.exit(23);\n', 'utf8');
    const session = createTypescriptModuleInspectionSession();
    try {
      await expect(session.inspect(terminating)).rejects.toThrow(/worker exited/u);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('rejects unanswered inspection even when the authored module exits successfully', async () => {
    const root = await createFixture();
    const terminating = join(root, 'plug#in', 'terminating-zero.ts');
    await writeFile(terminating, 'process.exit(0);\n', 'utf8');
    const session = createTypescriptModuleInspectionSession();
    const inspected = session.inspect(terminating).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await session.close();
    // Closure is the worker's terminal fact; it must settle every request.
    expect(await Promise.race([inspected, Promise.resolve({ unanswered: true })]))
      .toMatchObject({ error: expect.any(Error) });
  }, 120_000);
});
import { execFile } from 'node:child_process';
