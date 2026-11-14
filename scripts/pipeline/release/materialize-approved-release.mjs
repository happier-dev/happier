#!/usr/bin/env node
// @ts-check
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { planComponentVersion } from './bump-version.mjs';
import { buildReleaseNotesBundle, RELEASE_NOTES_SOURCE_PATH } from './release-notes/project-release-notes.mjs';
import { resolveReleasePromotionIntent } from './validate-release-dispatch.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

/** Local source writer only. The private conductor owns push, final-child CI and admission. */
export function materializeApprovedRelease(packet, cwd = process.cwd()) {
  requireThat(object(packet) && packet.kind === 'happier.approved-release-packet.v1', 'Expected an approved release packet v1.');
  requireThat(typeof packet.baseSha === 'string' && SHA.test(packet.baseSha), 'baseSha must be a full lowercase commit SHA.');
  requireThat(typeof packet.releaseId === 'string' && object(packet.notes) && typeof packet.notes.content === 'string', 'Approved release ID and full authored changelog are required.');
  requireThat(object(packet.versions) && Object.keys(packet.versions).length > 0, 'Exact component versions are required.');
  const intent = packet.intent;
  requireThat(object(intent) && intent.kind === 'happier.release-dispatch-plan.v3' && intent.schemaVersion === 3, 'Expected a public release dispatch plan v3.');
  const hosted = intent.hostedDispatch;
  requireThat(object(hosted) && hosted.workflow === 'release.yml' && object(hosted.inputs), 'Intent must contain canonical hosted release transport.');
  const inputs = hosted.inputs;
  requireThat(inputs.hmaint_attempt_id === 'attempt_1' && !Object.hasOwn(intent, 'resumeRunId') && !Object.hasOwn(inputs, 'resume_run_id'), 'Approved packets must describe an initial attempt_1 without a resume grant.');
  const { target, sourceBranch } = resolveReleasePromotionIntent({ environment: inputs.environment, confirm: inputs.confirm });
  requireThat(sourceBranch !== 'preview', 'Preview-source production consumes an already validated candidate; materialization onto preview is not allowed.');
  requireThat(target !== 'dev', 'Approved packet materialization requires a preview or production release target.');
  requireThat(intent.sourceBranch === sourceBranch, 'Intent sourceBranch differs from its public promotion source.');
  requireThat(intent.authorizedPromotionSourceSha === packet.baseSha && inputs.authorized_promotion_source_sha === packet.baseSha, 'Packet and intent must authorize the same base SHA.');
  requireThat(intent.releaseNotesId === packet.releaseId && inputs.release_notes_id === packet.releaseId, 'Packet and intent must identify the same release notes.');
  requireThat(inputs.dry_run === 'false', 'Intent must describe a real approved release.');
  buildReleaseNotesBundle(packet.notes.content, { releaseId: packet.releaseId, sourceSha: packet.baseSha, componentVersions: packet.versions });

  // Tree listings and tracked files outgrow Node's 1 MiB default; Git output has no product limit here.
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
  const repoRoot = git('rev-parse', '--show-toplevel').trim();
  requireThat(resolve(cwd) === resolve(repoRoot), 'Materialization must run from the target repository root.');
  const head = git('rev-parse', 'HEAD').trim();
  const parents = git('rev-list', '--parents', '-n', '1', head).trim().split(' ');
  requireThat(head === packet.baseSha || (parents.length === 2 && parents[1] === packet.baseSha), 'HEAD must be the approved base or its identical materialized direct child.');

  // All desired bytes come from the approved Git base, never from dirty source
  // or an already-materialized child. The writer retains component/path ownership.
  const basePaths = git('ls-tree', '-r', '--name-only', '-z', packet.baseSha).split('\0').filter(Boolean);
  const source = {
    readFile: (name) => git('show', `${packet.baseSha}:${name}`),
    exists: (name) => basePaths.some((file) => file === name || file.startsWith(`${name}/`)),
    listDirectory: (name) => [...new Set(basePaths.filter((file) => file.startsWith(`${name}/`)).map((file) => file.slice(name.length + 1).split('/')[0]))],
  };
  const changes = [{ path: RELEASE_NOTES_SOURCE_PATH, content: packet.notes.content }];
  for (const [component, version] of Object.entries(packet.versions)) {
    changes.push(...planComponentVersion({ repoRoot, component, version, source }).changes);
  }
  const changed = [];
  for (const change of changes) {
    const file = join(repoRoot, change.path);
    requireThat(lstatSync(file).isFile(), `Approved source must be a regular tracked file: ${change.path}`);
    const base = git('show', `${packet.baseSha}:${change.path}`);
    const current = readFileSync(file, 'utf8');
    requireThat(current === base || current === change.content, `Conflicting worktree edit on approved path: ${change.path}`);
    requireThat(git('diff', '--cached', '--name-only', 'HEAD', '--', change.path).trim() === '', `Conflicting index edit on approved path: ${change.path}`);
    if (base !== change.content) changed.push(change.path);
  }
  requireThat(changed.length > 0, 'Approved packet produces no source changes.');
  if (head !== packet.baseSha) {
    const actual = git('diff', '--name-only', '-z', packet.baseSha, head).split('\0').filter(Boolean).sort();
    requireThat(JSON.stringify(actual) === JSON.stringify([...changed].sort()), 'Existing child contains changes outside this approved packet.');
    for (const change of changes) requireThat(git('show', `${head}:${change.path}`) === change.content, `Existing child differs from approved packet: ${change.path}`);
  } else {
    // Preflight every path before writing any approved content. Explicit --only
    // leaves the caller's unrelated index and worktree changes intact.
    for (const change of changes) {
      if (readFileSync(join(repoRoot, change.path), 'utf8') === change.content) continue;
      const temporary = join(repoRoot, `${change.path}.release-tmp-${process.pid}`);
      writeFileSync(temporary, change.content, { mode: lstatSync(join(repoRoot, change.path)).mode });
      renameSync(temporary, join(repoRoot, change.path));
    }
    git('commit', '--only', '-m', `chore(release): materialize ${packet.releaseId}`, '--', ...changed);
  }
  const sourceSha = git('rev-parse', 'HEAD').trim();
  const rebound = structuredClone(intent);
  rebound.authorizedPromotionSourceSha = sourceSha;
  rebound.hostedDispatch.inputs.authorized_promotion_source_sha = sourceSha;
  // Shared source/control refs move together through this notes/version-only child.
  // A distinct workflow-control ref keeps its independently approved pin.
  if (hosted.ref === sourceBranch && inputs.workflow_control_sha === packet.baseSha) {
    rebound.hostedDispatch.inputs.workflow_control_sha = sourceSha;
  }
  return { kind: 'happier.materialized-release.v1', baseSha: packet.baseSha, sourceSha, sourceBranch, releaseId: packet.releaseId, target, intent: rebound };
}

function main() {
  const { values } = parseArgs({ options: { packet: { type: 'string' }, json: { type: 'boolean', default: false } }, allowPositionals: false });
  requireThat(values.packet && values.json, 'Usage: materialize-approved-release.mjs --packet <path> --json');
  const result = materializeApprovedRelease(JSON.parse(readFileSync(resolve(values.packet), 'utf8')));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { process.stderr.write(`[materialize-approved-release] ${error.message}\n`); process.exitCode = 1; }
}
