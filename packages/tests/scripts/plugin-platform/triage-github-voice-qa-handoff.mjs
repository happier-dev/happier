import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  loadPackedAuthorCandidateManifest,
  loadPackedAuthorNaturalArtifacts,
} from './run-packed-author-ui-compat.mjs';
import {
  loadPackedTriageGithubVoiceQaHandoff,
  parsePackedTriageGithubVoiceQaHandoff,
} from './run-packed-candidate-browser-qa.mjs';

const HANDOFF_FILE = 'triage-github-voice-qa.json';
const ROOT_MARKER_FILE = '.triage-github-voice-qa-root.json';
const ROOT_MARKER_KIND = 'happier_triage_github_voice_qa_handoff_root_v1';
const HANDOFF_KIND = 'happier_triage_github_voice_qa_handoff_v1';
const GITHUB_TOKEN_ENV = 'HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_GITHUB_TOKEN';
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

function fail(code, cause) {
  throw new Error(code, cause === undefined ? undefined : { cause });
}

function requireNonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(code);
  return value;
}

function isWithin(root, candidate) {
  const pathRelative = relative(root, candidate);
  return (
    pathRelative === ''
    || (!pathRelative.startsWith(`..${sep}`)
      && pathRelative !== '..'
      && !isAbsolute(pathRelative))
  );
}

async function assertOutsideRepository(path, { existing = false } = {}) {
  const physicalRepositoryRoot = await realpath(REPO_ROOT);
  const physicalPath = existing
    ? await realpath(path)
    : join(await realpath(dirname(path)), basename(path));
  if (isWithin(physicalRepositoryRoot, physicalPath)) {
    fail('triage_github_voice_qa_handoff_output_root_must_be_outside_repository');
  }
}

async function assertRegularFile(path, unavailableCode) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    fail(unavailableCode, error);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) fail(unavailableCode);
  return stats;
}

function assertPrivateMode(stats, code) {
  if (
    process.platform !== 'win32'
    && (stats.mode & 0o077) !== 0
  ) {
    fail(code);
  }
}

async function setPrivateMode(path, mode) {
  if (process.platform !== 'win32') await chmod(path, mode);
}

function createCandidateIdentity(candidate) {
  return {
    sdk: {
      packageName: candidate?.sdk?.packageName,
      version: candidate?.sdk?.version,
      integrity: candidate?.sdk?.integrity,
    },
    pluginUi: {
      packageName: candidate?.pluginUi?.packageName,
      version: candidate?.pluginUi?.version,
      pluginSdkVersion: candidate?.pluginUi?.pluginSdkVersion,
      integrity: candidate?.pluginUi?.integrity,
    },
    cli: {
      packageName: candidate?.cli?.packageName,
      version: candidate?.cli?.version,
      integrity: candidate?.cli?.integrity,
    },
  };
}

async function assertMicrophoneFixture(microphoneFixturePath) {
  if (
    typeof microphoneFixturePath !== 'string'
    || !isAbsolute(microphoneFixturePath)
  ) {
    fail('triage_github_voice_qa_handoff_microphone_fixture_invalid');
  }
  await assertRegularFile(
    microphoneFixturePath,
    'triage_github_voice_qa_handoff_microphone_fixture_invalid',
  );
}

function createHandoff({
  candidate,
  token,
  scopeTitle,
  issueATitle,
  issueBTitle,
  microphoneFixturePath,
}) {
  return parsePackedTriageGithubVoiceQaHandoff(
    JSON.stringify({
      schemaVersion: 2,
      kind: HANDOFF_KIND,
      candidate: createCandidateIdentity(candidate),
      github: {
        token,
        scopeTitle,
        issueA: { title: issueATitle },
        issueB: { title: issueBTitle },
      },
      voice: {
        adapterId: 'local_conversation',
        conversationMode: 'agent',
        agentId: 'claude',
        sttProviderId: 'happier.voice.openai-compat/stt',
        microphoneFixturePath,
      },
    }),
  );
}

async function writePrivateJson(path, value) {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await setPrivateMode(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await setPrivateMode(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createSecureOutputRoot(outputRoot) {
  if (outputRoot === undefined || outputRoot === null || outputRoot === '') {
    const root = await mkdtemp(join(tmpdir(), 'happier-triage-github-voice-qa-'));
    try {
      await setPrivateMode(root, 0o700);
      await assertOutsideRepository(root, { existing: true });
      return { root };
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  if (typeof outputRoot !== 'string' || !isAbsolute(outputRoot)) {
    fail('triage_github_voice_qa_handoff_output_root_must_be_absolute');
  }
  const root = resolve(outputRoot);
  try {
    await lstat(root);
    fail('triage_github_voice_qa_handoff_output_root_must_not_exist');
  } catch (error) {
    if (error?.message === 'triage_github_voice_qa_handoff_output_root_must_not_exist') {
      throw error;
    }
    if (error?.code !== 'ENOENT') throw error;
  }
  const parentStats = await assertRegularDirectory(
    dirname(root),
    'triage_github_voice_qa_handoff_output_root_parent_invalid',
  );
  if (parentStats.isSymbolicLink()) {
    fail('triage_github_voice_qa_handoff_output_root_parent_invalid');
  }
  await assertOutsideRepository(root);
  const stagingRoot = join(
    dirname(root),
    `.${basename(root)}.${randomUUID()}.staging`,
  );
  await writeSecureDirectory(stagingRoot);
  return { root, stagingRoot };
}

async function assertRegularDirectory(path, invalidCode) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    fail(invalidCode, error);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail(invalidCode);
  }
  return stats;
}

async function writeSecureDirectory(path) {
  await mkdir(path, { recursive: false, mode: 0o700 });
  await setPrivateMode(path, 0o700);
}

export async function createPackedTriageGithubVoiceQaHandoff({
  candidate,
  token,
  scopeTitle,
  issueATitle,
  issueBTitle,
  microphoneFixturePath,
  outputRoot,
}) {
  requireNonEmpty(token, 'triage_github_voice_qa_handoff_token_required');
  requireNonEmpty(scopeTitle, 'triage_github_voice_qa_handoff_scope_required');
  requireNonEmpty(issueATitle, 'triage_github_voice_qa_handoff_issue_a_required');
  requireNonEmpty(issueBTitle, 'triage_github_voice_qa_handoff_issue_b_required');
  await assertMicrophoneFixture(microphoneFixturePath);
  const handoff = createHandoff({
    candidate,
    token,
    scopeTitle,
    issueATitle,
    issueBTitle,
    microphoneFixturePath,
  });
  const root = await createSecureOutputRoot(outputRoot);
  const writeRoot = root.stagingRoot ?? root.root;
  const manifestPath = join(writeRoot, HANDOFF_FILE);
  let publishedRoot = root.stagingRoot ? null : root.root;
  try {
    await writePrivateJson(join(writeRoot, ROOT_MARKER_FILE), {
      schemaVersion: 1,
      kind: ROOT_MARKER_KIND,
      manifestFile: HANDOFF_FILE,
    });
    await writePrivateJson(manifestPath, handoff);
    if (root.stagingRoot) {
      await rename(root.stagingRoot, root.root);
      publishedRoot = root.root;
    }
    const publishedManifestPath = join(root.root, HANDOFF_FILE);
    await loadPackedTriageGithubVoiceQaHandoff({
      manifestPath: publishedManifestPath,
    });
    return Object.freeze({ manifestPath: publishedManifestPath });
  } catch (error) {
    await rm(publishedRoot ?? root.stagingRoot, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}

function parseRootMarker(raw) {
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch (error) {
    fail('triage_github_voice_qa_handoff_cleanup_unauthorized', error);
  }
  if (
    !marker
    || typeof marker !== 'object'
    || Array.isArray(marker)
    || JSON.stringify(Object.keys(marker).sort())
      !== JSON.stringify(['kind', 'manifestFile', 'schemaVersion'])
    || marker.schemaVersion !== 1
    || marker.kind !== ROOT_MARKER_KIND
    || marker.manifestFile !== HANDOFF_FILE
  ) {
    fail('triage_github_voice_qa_handoff_cleanup_unauthorized');
  }
}

export async function cleanupPackedTriageGithubVoiceQaHandoff({ manifestPath }) {
  if (typeof manifestPath !== 'string' || manifestPath.trim().length === 0) {
    fail('triage_github_voice_qa_handoff_cleanup_unauthorized');
  }
  const resolvedManifestPath = resolve(manifestPath);
  if (basename(resolvedManifestPath) !== HANDOFF_FILE) {
    fail('triage_github_voice_qa_handoff_cleanup_unauthorized');
  }
  const root = dirname(resolvedManifestPath);
  const rootStats = await assertRegularDirectory(
    root,
    'triage_github_voice_qa_handoff_cleanup_unauthorized',
  );
  assertPrivateMode(rootStats, 'triage_github_voice_qa_handoff_cleanup_unauthorized');
  await assertOutsideRepository(root, { existing: true });
  const manifestStats = await assertRegularFile(
    resolvedManifestPath,
    'triage_github_voice_qa_handoff_cleanup_unauthorized',
  );
  assertPrivateMode(manifestStats, 'triage_github_voice_qa_handoff_cleanup_unauthorized');
  const markerPath = join(root, ROOT_MARKER_FILE);
  const markerStats = await assertRegularFile(
    markerPath,
    'triage_github_voice_qa_handoff_cleanup_unauthorized',
  );
  assertPrivateMode(markerStats, 'triage_github_voice_qa_handoff_cleanup_unauthorized');
  let handoffRaw;
  let markerRaw;
  try {
    [handoffRaw, markerRaw] = await Promise.all([
      readFile(resolvedManifestPath, 'utf8'),
      readFile(markerPath, 'utf8'),
    ]);
  } catch (error) {
    fail('triage_github_voice_qa_handoff_cleanup_unauthorized', error);
  }
  const handoff = parsePackedTriageGithubVoiceQaHandoff(handoffRaw);
  if (handoff.schemaVersion !== 2) {
    fail('triage_github_voice_qa_handoff_cleanup_unauthorized');
  }
  parseRootMarker(markerRaw);
  await rm(root, { recursive: true, force: false });
  return Object.freeze({ removed: true });
}

export function parsePackedTriageGithubVoiceQaHandoffArgs(argv, env = process.env) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      candidate: { type: 'string' },
      'scope-title': { type: 'string' },
      'issue-a-title': { type: 'string' },
      'issue-b-title': { type: 'string' },
      'microphone-fixture': { type: 'string' },
      'output-root': { type: 'string' },
      'sdk-tarball': { type: 'string' },
      'plugin-ui-tarball': { type: 'string' },
      'cli-tarball': { type: 'string' },
      manifest: { type: 'string' },
    },
  });
  const mode = positionals[0] ?? 'create';
  if (
    positionals.length !== 1
    && !(positionals.length === 0 && mode === 'create')
  ) {
    fail('triage_github_voice_qa_handoff_command_invalid');
  }
  if (mode === 'cleanup') {
    if (
      values.candidate
      || values['scope-title']
      || values['issue-a-title']
      || values['issue-b-title']
      || values['microphone-fixture']
      || values['output-root']
      || values['sdk-tarball']
      || values['plugin-ui-tarball']
      || values['cli-tarball']
    ) {
      fail('triage_github_voice_qa_handoff_command_invalid');
    }
    return Object.freeze({
      mode,
      manifestPath: requireNonEmpty(
        values.manifest,
        'triage_github_voice_qa_handoff_manifest_required',
      ),
    });
  }
  if (mode !== 'create' || values.manifest) {
    fail('triage_github_voice_qa_handoff_command_invalid');
  }
  const candidateManifestPath = String(values.candidate ?? '').trim();
  const sdkTarballPath = String(values['sdk-tarball'] ?? '').trim();
  const pluginUiTarballPath = String(values['plugin-ui-tarball'] ?? '').trim();
  const cliTarballPath = String(values['cli-tarball'] ?? '').trim();
  const hasDirectArtifact = Boolean(
    sdkTarballPath || pluginUiTarballPath || cliTarballPath,
  );
  const hasCompleteDirectArtifacts = Boolean(
    sdkTarballPath && pluginUiTarballPath && cliTarballPath,
  );
  if (
    (candidateManifestPath && hasDirectArtifact)
    || (!candidateManifestPath && !hasCompleteDirectArtifacts)
  ) {
    fail('triage_github_voice_qa_handoff_candidate_source_invalid');
  }
  return Object.freeze({
    mode,
    ...(candidateManifestPath
      ? { candidateManifestPath }
      : { sdkTarballPath, pluginUiTarballPath, cliTarballPath }),
    token: requireNonEmpty(
      env?.[GITHUB_TOKEN_ENV],
      'triage_github_voice_qa_handoff_token_required',
    ),
    scopeTitle: requireNonEmpty(
      values['scope-title'],
      'triage_github_voice_qa_handoff_scope_required',
    ),
    issueATitle: requireNonEmpty(
      values['issue-a-title'],
      'triage_github_voice_qa_handoff_issue_a_required',
    ),
    issueBTitle: requireNonEmpty(
      values['issue-b-title'],
      'triage_github_voice_qa_handoff_issue_b_required',
    ),
    microphoneFixturePath: requireNonEmpty(
      values['microphone-fixture'],
      'triage_github_voice_qa_handoff_microphone_fixture_required',
    ),
    ...(values['output-root']
      ? { outputRoot: values['output-root'] }
      : {}),
  });
}

export async function runPackedTriageGithubVoiceQaHandoffCommand(
  argv,
  { cwd = process.cwd(), env = process.env } = {},
) {
  const parsed = parsePackedTriageGithubVoiceQaHandoffArgs(argv, env);
  if (parsed.mode === 'cleanup') {
    return await cleanupPackedTriageGithubVoiceQaHandoff({
      manifestPath: parsed.manifestPath,
    });
  }
  const candidate = parsed.candidateManifestPath
    ? await loadPackedAuthorCandidateManifest(
      ['--candidate', parsed.candidateManifestPath],
      { cwd },
    )
    : await loadPackedAuthorNaturalArtifacts(
      [
        '--scenario',
        'vertical-a',
        '--sdk-tarball',
        parsed.sdkTarballPath,
        '--plugin-ui-tarball',
        parsed.pluginUiTarballPath,
        '--cli-tarball',
        parsed.cliTarballPath,
      ],
      { cwd },
    );
  return await createPackedTriageGithubVoiceQaHandoff({
    candidate,
    token: parsed.token,
    scopeTitle: parsed.scopeTitle,
    issueATitle: parsed.issueATitle,
    issueBTitle: parsed.issueBTitle,
    microphoneFixturePath: parsed.microphoneFixturePath,
    ...(parsed.outputRoot ? { outputRoot: parsed.outputRoot } : {}),
  });
}

async function main() {
  const result = await runPackedTriageGithubVoiceQaHandoffCommand(
    process.argv.slice(2),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
