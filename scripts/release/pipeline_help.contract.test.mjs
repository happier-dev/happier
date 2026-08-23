import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAnsiStyle } from '../pipeline/cli/ansi-style.mjs';
import { renderCommandHelp } from '../pipeline/cli/help.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pipelineCli = resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs');

test('pipeline CLI supports --help', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, '--help'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /Happier Pipeline/i);
  assert.match(out, /Usage:/i);
  assert.match(out, /node scripts\/pipeline\/run\.mjs/i);
});

test('pipeline CLI supports help <command>', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, 'help', 'expo-submit'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /\bexpo-submit\b/);
  assert.match(out, /\bsubmit\b/i);
  assert.match(out, /--environment/);
});

test('pipeline CLI supports help for npm-release', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, 'help', 'npm-release'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /\bnpm-release\b/);
  assert.match(out, /--channel/);
  assert.match(out, /--publish-cli/);
  assert.match(out, /--publish-plugin-sdk/);
  assert.match(out, /--publish-sdk/);
  assert.match(out, /lockstep/i);
});

test('pipeline CLI help exposes public SDK release planning and version controls', async () => {
  const bumpPlan = execFileSync(process.execPath, [pipelineCli, 'help', 'release-bump-plan'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert.match(bumpPlan, /--bump-plugin-sdk-override/);
  assert.match(bumpPlan, /--changed-plugin-sdk/);
  assert.match(bumpPlan, /--versioned-sdk-changed/);

  const bumpVersion = execFileSync(process.execPath, [pipelineCli, 'help', 'release-bump-version'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert.match(bumpVersion, /plugin_sdk/);
  assert.match(bumpVersion, /sdk/);

  const preview = execFileSync(process.execPath, [pipelineCli, 'help', 'npm-set-preview-versions'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert.match(preview, /--publish-plugin-sdk/);
  assert.match(preview, /--publish-sdk/);
});

test('pipeline CLI supports help for checks', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, 'help', 'checks'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /\bchecks\b/);
  assert.match(out, /--profile/);
});

test('pipeline CLI release help documents conductor and canonical notes identities', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, 'help', 'release'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /--operation-id <id>/);
  assert.match(out, /--release-notes-id <id>/);
  assert.match(out, /same conductor operation identity/i);
  assert.match(out, /approved canonical release-note entry/i);
});

test('pipeline CLI supports <command> --help', async () => {
  const out = execFileSync(process.execPath, [pipelineCli, 'expo-submit', '--help'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /\bexpo-submit\b/);
  assert.match(out, /--path/);
});

test('pipeline CLI help reflects expanded Expo environment support', async () => {
  const mobileReleaseHelp = execFileSync(process.execPath, [pipelineCli, 'help', 'ui-mobile-release'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert.match(mobileReleaseHelp, /internaldev\*, internalpreview\*, dev\*, preview\*, production\*/);
  assert.match(mobileReleaseHelp, /--profile dev\b/);
  assert.match(mobileReleaseHelp, /App Store Connect external TestFlight distribution/i);
  assert.doesNotMatch(mobileReleaseHelp, /\bpublicdev\b/);

  const downloadHelp = execFileSync(process.execPath, [pipelineCli, 'help', 'expo-download-apk'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert.match(downloadHelp, /internaldev\|internalpreview\|dev\|preview\|production/);

  const publishHelp = execFileSync(process.execPath, [pipelineCli, 'help', 'expo-publish-apk-release'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert.match(publishHelp, /internaldev\|internalpreview\|dev\|preview\|production/);

  const submitHelp = execFileSync(process.execPath, [pipelineCli, 'help', 'expo-submit'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert.match(submitHelp, /--profile dev\b/);
  assert.doesNotMatch(submitHelp, /\bpublicdev\b/);
});

test('pipeline CLI help reflects expanded Tauri environment support', async () => {
  for (const command of ['tauri-prepare-assets', 'tauri-build-updater-artifacts', 'tauri-collect-updater-artifacts']) {
    const help = execFileSync(process.execPath, [pipelineCli, 'help', command], {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    assert.match(help, /dev\|preview\|production/);
  }
});

test('pipeline CLI help reflects the public dev release ring for publish/release commands', async () => {
  for (const command of [
    'publish-cli-binaries',
    'publish-hstack-binaries',
    'publish-server-runtime',
    'publish-ui-web',
    'release-build-cli-binaries',
    'release-build-hstack-binaries',
    'release-build-server-binaries',
    'release-prepare-binary-assets',
    'release-publish-manifests',
    'release-build-ui-web-bundle',
  ]) {
    const help = execFileSync(process.execPath, [pipelineCli, 'help', command], {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    assert.match(help, /stable\|preview\|dev/);
    assert.doesNotMatch(help, /\bpublicdev\b/);
  }
});

test('pipeline CLI help reflects the current release-validate execution surface', async () => {
  const help = execFileSync(process.execPath, [pipelineCli, 'help', 'release-validate'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(help, /installers-smoke \(published-channel\|published-tag\|local-build with --release-channel\)/);
  assert.match(help, /artifact-verify \(local-build or --product\/--version\)/);
  assert.match(help, /docker-release-assets \(local-build\|published-channel; published-channel -> local-build upgrade\)/);
  assert.match(help, /cli-update \(published-channel\|published-tag -> published-channel\|published-tag\|local-build\|local-pack\)/);
  assert.doesNotMatch(help, /server-upgrade/);
  assert.doesNotMatch(help, /Later phases will add executor wiring/);
});

test('pipeline CLI help describes the public release contract reader', async () => {
  const help = execFileSync(process.execPath, [pipelineCli, 'help', 'release-contract'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(help, /release-contract/);
  assert.match(help, /JSON/);
  assert.match(help, /integrated.*stable.*deep/s);
});

test('pipeline CLI help describes bounded release-profile selection', async () => {
  const help = execFileSync(process.execPath, [pipelineCli, 'help', 'release'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(help, /--release-profile/);
  assert.match(help, /--qualified-v4-activation-approval/);
  assert.match(help, /--resume-run-id/);
  assert.match(help, /separate irreversible-migration approval/i);
  assert.match(help, /integrated.*stable.*deep/s);
  assert.match(help, /production.*stable/i);
  assert.match(help, /--bump.*must be none.*exact-SHA/i);
  assert.match(help, /Materialize and commit CHANGELOG and version changes.*--bump none/i);
  assert.match(help, /Dry-run remains available only with --bump none/i);
});

test('pipeline help covers every supported subcommand', async () => {
  const runSource = fs.readFileSync(pipelineCli, 'utf8');
  const allowlist = Array.from(runSource.matchAll(/subcommand\s*!==\s*'([^']+)'/g)).map((m) => String(m[1] ?? '').trim()).filter(Boolean);
  const unique = [];
  for (const name of allowlist) {
    if (!unique.includes(name)) unique.push(name);
  }

  const style = createAnsiStyle({ enabled: false });
  for (const cmd of unique) {
    const out = renderCommandHelp({ style, command: cmd, cliRelPath: 'scripts/pipeline/run.mjs' });
    assert.doesNotMatch(out, /^Unknown command:/m, `missing help entry for: ${cmd}`);
    assert.match(out, new RegExp(`\\b${cmd.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`));
  }
});
