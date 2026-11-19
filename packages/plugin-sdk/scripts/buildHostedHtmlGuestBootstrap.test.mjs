import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as guest from './buildHostedHtmlGuestBootstrap.mjs';

test('guest generation preserves unchanged output and replaces changed browser bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-guest-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'packages/plugin-sdk');
  await mkdir(join(packageRoot, 'src/ui'), { recursive: true });
  const entry = join(packageRoot, 'src/ui/hostedHtmlGuestEntry.ts');
  const target = join(packageRoot, 'src/ui/guestBootstrap.generated.ts');
  await writeFile(entry, 'globalThis.guestVersion = 1;\n');
  assert.equal(typeof guest.buildHostedHtmlGuestBootstrap, 'function');
  await guest.buildHostedHtmlGuestBootstrap({ packageRoot, outputFile: target });
  const original = await readFile(target, 'utf8');
  await utimes(target, 1, 1);
  await guest.buildHostedHtmlGuestBootstrap({ packageRoot, outputFile: target });
  assert.equal((await stat(target)).mtimeMs, 1000);
  await writeFile(entry, 'globalThis.guestVersion = 2;\n');
  await assert.rejects(guest.buildHostedHtmlGuestBootstrap({ packageRoot, outputFile: target, check: true }), /stale/);
  assert.equal(await readFile(target, 'utf8'), original);
  await guest.buildHostedHtmlGuestBootstrap({ packageRoot, outputFile: target });
  assert.notEqual(await readFile(target, 'utf8'), original);
  await guest.buildHostedHtmlGuestBootstrap({ packageRoot, outputFile: target, check: true });
});

test('guest generation can publish directly to its consuming host', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-guest-host-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'packages/plugin-sdk');
  const outputFile = join(root, 'apps/ui/guestBootstrap.generated.ts');
  await mkdir(join(packageRoot, 'src/ui'), { recursive: true });
  await mkdir(join(root, 'apps/ui'), { recursive: true });
  await writeFile(join(packageRoot, 'src/ui/hostedHtmlGuestEntry.ts'), 'globalThis.hostGuest = true;\n');

  await guest.buildHostedHtmlGuestBootstrap({ packageRoot, outputFile });

  assert.match(await readFile(outputFile, 'utf8'), /hostGuest/);
  await assert.rejects(readFile(join(packageRoot, 'src/host/ui/hostedHtmlGuestBootstrap.generated.ts'), 'utf8'), { code: 'ENOENT' });
  await guest.buildHostedHtmlGuestBootstrap({ packageRoot, outputFile, check: true });
});


test('a host presentation kit installs with the guest client in the one bootstrap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-guest-kit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'packages/plugin-sdk');
  const outputFile = join(root, 'apps/ui/guestBootstrap.generated.ts');
  const kit = join(root, 'packages/plugin-ui/src/kit.ts');
  await mkdir(join(packageRoot, 'src/ui'), { recursive: true });
  await mkdir(join(root, 'apps/ui'), { recursive: true });
  await mkdir(join(root, 'packages/plugin-ui/src'), { recursive: true });
  await writeFile(join(packageRoot, 'src/ui/hostedHtmlGuestEntry.ts'), 'globalThis.steps = [...(globalThis.steps ?? []), "client"];\n');
  await writeFile(kit, 'export function installHappierHtmlKit(realm: { steps?: string[] }) { realm.steps = [...(realm.steps ?? []), "kit"]; }\n');

  await guest.buildHostedHtmlGuestBootstrap({ packageRoot, outputFile, presentationKit: kit });
  const generated = await readFile(outputFile, 'utf8');
  const script = JSON.parse(generated.slice(generated.indexOf('= ') + 2, generated.lastIndexOf(';')));
  const realm = { steps: undefined };
  runInNewContext(`globalThis.window = globalThis;\n${script}`, realm);
  assert.equal(JSON.stringify(realm.steps), '["client","kit"]');
  // Regenerating without the host's kit is a different bootstrap, so a check against it reports stale.
  await assert.rejects(guest.buildHostedHtmlGuestBootstrap({ packageRoot, outputFile, check: true }), /stale/);
});
