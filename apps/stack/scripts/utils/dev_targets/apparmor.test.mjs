import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesGlob } from 'node:path';
import { renderSandboxAppArmorProfile } from './apparmor.mjs';

test('attachment covers observed and future stack/build paths without granting unrelated executables', () => {
  const policy = renderSandboxAppArmorProfile('/home/happier');
  const attachment = policy.match(/profile happier-sandbox-binaries "([^"\n]+)" flags=\(unconfined\)/)?.[1];
  assert.ok(attachment, 'sandbox binaries need an unconfined attachment');
  assert.match(policy, /\n  userns,\n/);
  const root = '/home/happier/.happier/dev-targets/nl3/stack-state';
  for (const binary of [
    `${root}/agent-qa-home-atmosphere/cli/tools/providers/codex/current/codex-resources/bwrap`,
    `${root}/new-stack/cli/tools/providers/codex/current/bin/codex`,
    `${root}/agent-qa-l12-d2/cli/tools/browser-chromium/current/chrome-linux64/chrome`,
    `${root}/new-stack/cli/tools/browser-chromium/new-build-hash/chrome-linux64/chrome`,
    `${root}/agent-qa-servers-deploy/cli/tools/providers/muse/current/bin/muse-bin-1.4.15-R8339.1`,
    `${root}/new-stack/cli/tools/providers/muse/current/bin/muse-bin-new-version`,
    '/home/happier/.local/bin/muse-bin-1.4.15-R8339.1',
    '/home/happier/.local/share/codex-standalone/0.162.1-x86_64-unknown-linux-musl/codex-resources/bwrap',
  ]) assert.ok(matchesGlob(binary, attachment), binary);
  for (const binary of ['/usr/bin/bwrap', '/usr/bin/chromium', '/home/other/.local/bin/muse-bin-1', `${root}/new-stack/cli/tools/unrelated/current/bin/tool`]) assert.equal(matchesGlob(binary, attachment), false, binary);
});

test('home directory cannot inject policy syntax', () => {
  for (const home of ['/home/*', '/home/user"', '/home/user\n', 'relative', '/home/{user,other}']) assert.throws(() => renderSandboxAppArmorProfile(home));
});
