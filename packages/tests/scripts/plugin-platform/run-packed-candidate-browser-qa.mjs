import { access, lstat, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANIFEST_ENV = 'HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST';
const NOVEL_HANDOFF_MANIFEST_ENV =
  'HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST';
const UCX_WEB_SDK_TARBALL_ENV = 'HAPPIER_E2E_UCX_WEB_SDK_TARBALL';
const UCX_WEB_PLUGIN_UI_TARBALL_ENV =
  'HAPPIER_E2E_UCX_WEB_PLUGIN_UI_TARBALL';
const UCX_WEB_CLI_TARBALL_ENV = 'HAPPIER_E2E_UCX_WEB_CLI_TARBALL';
const TRIAGE_GITHUB_VOICE_HANDOFF_MANIFEST_ENV =
  'HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST';
const TRIAGE_GITHUB_VOICE_MICROPHONE_FIXTURE_PATH_ENV =
  'HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_MICROPHONE_FIXTURE_PATH';
const TRIAGE_GITHUB_VOICE_ADAPTER_ENV =
  'HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ADAPTER';
const TRIAGE_GITHUB_VOICE_QA_HANDOFF_KIND =
  'happier_triage_github_voice_qa_handoff_v1';
const FIRST_PARTY_REALTIME_VOICE_PROVIDER_ID =
  'happier.voice.openai/realtime-openai';
const LOCAL_AGENT_VOICE_ADAPTER_ID = 'local_conversation';
const LOCAL_AGENT_VOICE_STT_PROVIDER_ID = 'happier.voice.openai-compat/stt';

function failTriageGithubVoiceHandoffInvalid() {
  throw new Error(
    'packed_triage_github_voice_browser_qa_blocked_handoff_invalid',
  );
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function requireExactRecordKeys(value, expectedKeys) {
  const record = asRecord(value);
  if (!record) failTriageGithubVoiceHandoffInvalid();
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length
    || actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    failTriageGithubVoiceHandoffInvalid();
  }
  return record;
}

function requireNonEmptyHandoffString(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    failTriageGithubVoiceHandoffInvalid();
  }
  return value;
}

function parseTriageGithubVoiceCandidateIdentity(value) {
  const candidate = requireExactRecordKeys(value, ['sdk', 'pluginUi', 'cli']);
  const parseArtifact = (artifact, packageName) => {
    const parsed = requireExactRecordKeys(artifact, [
      'packageName',
      'version',
      'integrity',
    ]);
    if (parsed.packageName !== packageName) failTriageGithubVoiceHandoffInvalid();
    return Object.freeze({
      packageName,
      version: requireNonEmptyHandoffString(parsed.version),
      integrity: requireNonEmptyHandoffString(parsed.integrity),
    });
  };
  const sdk = parseArtifact(candidate.sdk, '@happier-dev/plugin-sdk');
  const pluginUi = requireExactRecordKeys(candidate.pluginUi, [
    'packageName',
    'version',
    'pluginSdkVersion',
    'integrity',
  ]);
  if (
    pluginUi.packageName !== '@happier-dev/plugin-ui'
    || pluginUi.pluginSdkVersion !== sdk.version
  ) {
    failTriageGithubVoiceHandoffInvalid();
  }
  return Object.freeze({
    sdk,
    pluginUi: Object.freeze({
      packageName: '@happier-dev/plugin-ui',
      version: requireNonEmptyHandoffString(pluginUi.version),
      pluginSdkVersion: sdk.version,
      integrity: requireNonEmptyHandoffString(pluginUi.integrity),
    }),
    cli: parseArtifact(candidate.cli, '@happier-dev/cli'),
  });
}

export function parsePackedTriageGithubVoiceQaHandoff(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      'packed_triage_github_voice_browser_qa_blocked_handoff_invalid',
      { cause: error },
    );
  }
  const handoff = requireExactRecordKeys(value, [
    'schemaVersion',
    'kind',
    'candidate',
    'github',
    'voice',
  ]);
  if (handoff.kind !== TRIAGE_GITHUB_VOICE_QA_HANDOFF_KIND) {
    failTriageGithubVoiceHandoffInvalid();
  }
  const github = requireExactRecordKeys(handoff.github, [
    'token',
    'scopeTitle',
    'issueA',
    'issueB',
  ]);
  const issueA = requireExactRecordKeys(github.issueA, ['title']);
  const issueB = requireExactRecordKeys(github.issueB, ['title']);
  const issueATitle = requireNonEmptyHandoffString(issueA.title);
  const issueBTitle = requireNonEmptyHandoffString(issueB.title);
  if (issueATitle === issueBTitle) failTriageGithubVoiceHandoffInvalid();

  const common = {
    kind: TRIAGE_GITHUB_VOICE_QA_HANDOFF_KIND,
    candidate: parseTriageGithubVoiceCandidateIdentity(handoff.candidate),
    github: Object.freeze({
      token: requireNonEmptyHandoffString(github.token),
      scopeTitle: requireNonEmptyHandoffString(github.scopeTitle),
      issueA: Object.freeze({ title: issueATitle }),
      issueB: Object.freeze({ title: issueBTitle }),
    }),
  };

  if (handoff.schemaVersion === 1) {
    const voice = requireExactRecordKeys(handoff.voice, [
      'providerId',
      'optionId',
      'credentialSlotId',
      'credential',
      'microphoneFixturePath',
    ]);
    const microphoneFixturePath = requireNonEmptyHandoffString(
      voice.microphoneFixturePath,
    );
    if (
      voice.providerId !== FIRST_PARTY_REALTIME_VOICE_PROVIDER_ID
      || voice.optionId !== 'byo'
      || voice.credentialSlotId !== 'api_key'
      || !isAbsolute(microphoneFixturePath)
    ) {
      failTriageGithubVoiceHandoffInvalid();
    }
    return Object.freeze({
      schemaVersion: 1,
      ...common,
      voice: Object.freeze({
        providerId: FIRST_PARTY_REALTIME_VOICE_PROVIDER_ID,
        optionId: 'byo',
        credentialSlotId: 'api_key',
        credential: requireNonEmptyHandoffString(voice.credential),
        microphoneFixturePath,
      }),
    });
  }

  if (handoff.schemaVersion === 2) {
    const voice = requireExactRecordKeys(handoff.voice, [
      'adapterId',
      'conversationMode',
      'agentId',
      'sttProviderId',
      'microphoneFixturePath',
    ]);
    const microphoneFixturePath = requireNonEmptyHandoffString(
      voice.microphoneFixturePath,
    );
    if (
      voice.adapterId !== LOCAL_AGENT_VOICE_ADAPTER_ID
      || voice.conversationMode !== 'agent'
      || voice.agentId !== 'claude'
      || voice.sttProviderId !== LOCAL_AGENT_VOICE_STT_PROVIDER_ID
      || !isAbsolute(microphoneFixturePath)
    ) {
      failTriageGithubVoiceHandoffInvalid();
    }
    return Object.freeze({
      schemaVersion: 2,
      ...common,
      voice: Object.freeze({
        adapterId: LOCAL_AGENT_VOICE_ADAPTER_ID,
        conversationMode: 'agent',
        agentId: 'claude',
        sttProviderId: LOCAL_AGENT_VOICE_STT_PROVIDER_ID,
        microphoneFixturePath,
      }),
    });
  }

  failTriageGithubVoiceHandoffInvalid();
}

export function resolvePackedTriageGithubVoiceQaAdapter(handoff) {
  if (handoff?.schemaVersion === 1) return 'external_realtime';
  if (handoff?.schemaVersion === 2) return 'local_agent';
  failTriageGithubVoiceHandoffInvalid();
}

export function assertPackedTriageGithubVoiceQaCompletionHandoff(handoff) {
  if (resolvePackedTriageGithubVoiceQaAdapter(handoff) !== 'local_agent') {
    throw new Error(
      'packed_triage_github_voice_browser_qa_blocked_local_agent_handoff_required',
    );
  }
  return handoff;
}

export function assertPackedTriageGithubVoiceQaCandidate({ handoff, candidate }) {
  const candidateIdentity = {
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
  if (JSON.stringify(candidateIdentity) !== JSON.stringify(handoff?.candidate)) {
    throw new Error(
      'packed_triage_github_voice_browser_qa_blocked_candidate_mismatch',
    );
  }
  return handoff;
}

export async function loadPackedTriageGithubVoiceQaHandoff({ manifestPath }) {
  const resolvedManifestPath = resolve(manifestPath);
  let manifestStats;
  try {
    manifestStats = await lstat(resolvedManifestPath);
  } catch (error) {
    throw new Error(
      'packed_triage_github_voice_browser_qa_blocked_handoff_unavailable',
      { cause: error },
    );
  }
  if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
    throw new Error(
      'packed_triage_github_voice_browser_qa_blocked_handoff_unavailable',
    );
  }
  let raw;
  try {
    raw = await readFile(resolvedManifestPath, 'utf8');
  } catch (error) {
    throw new Error(
      'packed_triage_github_voice_browser_qa_blocked_handoff_unavailable',
      { cause: error },
    );
  }
  const handoff = parsePackedTriageGithubVoiceQaHandoff(raw);
  let microphoneFixtureStats;
  try {
    microphoneFixtureStats = await lstat(handoff.voice.microphoneFixturePath);
  } catch (error) {
    throw new Error(
      'packed_triage_github_voice_browser_qa_blocked_microphone_fixture_unavailable',
      { cause: error },
    );
  }
  if (
    microphoneFixtureStats.isSymbolicLink()
    || !microphoneFixtureStats.isFile()
  ) {
    throw new Error(
      'packed_triage_github_voice_browser_qa_blocked_microphone_fixture_unavailable',
    );
  }
  return handoff;
}

export function requirePackedCandidateBrowserQaInputs({
  argv,
  env,
  cwd,
}) {
  const values = {
    candidate: null,
    novelHandoff: null,
    sdkTarball: null,
    pluginUiTarball: null,
    cliTarball: null,
    triageGithubVoiceHandoff: null,
  };
  const flags = {
    '--candidate': 'candidate',
    '--novel-handoff': 'novelHandoff',
    '--sdk-tarball': 'sdkTarball',
    '--plugin-ui-tarball': 'pluginUiTarball',
    '--cli-tarball': 'cliTarball',
    '--triage-github-voice-handoff': 'triageGithubVoiceHandoff',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = flags[argument];
    if (!key) {
      throw new Error(`packed_candidate_browser_qa_unknown_argument:${argument}`);
    }
    if (values[key] !== null) {
      throw new Error(`packed_candidate_browser_qa_${key}_repeated`);
    }
    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith('--')) {
      if (key === 'triageGithubVoiceHandoff') {
        throw new Error(
          'packed_candidate_browser_qa_triage_github_voice_blocked_handoff_value_required',
        );
      }
      throw new Error(`packed_candidate_browser_qa_${key}_value_required`);
    }
    values[key] = value;
    index += 1;
  }

  const resolveInput = ({ value, environmentValue, conflictCode }) => {
    if (
      value
      && environmentValue
      && resolve(cwd, value) !== resolve(cwd, environmentValue)
    ) {
      throw new Error(conflictCode);
    }
    return value ?? environmentValue;
  };
  const environmentPath = (name) => env[name]?.trim() || null;
  const candidateValue = resolveInput({
    value: values.candidate,
    environmentValue: environmentPath(MANIFEST_ENV),
    conflictCode: 'packed_candidate_browser_qa_manifest_conflict',
  });
  const novelHandoffValue = resolveInput({
    value: values.novelHandoff,
    environmentValue: environmentPath(NOVEL_HANDOFF_MANIFEST_ENV),
    conflictCode: 'packed_candidate_browser_qa_novel_handoff_conflict',
  });
  const sdkTarballValue = resolveInput({
    value: values.sdkTarball,
    environmentValue: environmentPath(UCX_WEB_SDK_TARBALL_ENV),
    conflictCode: 'packed_candidate_browser_qa_sdk_tarball_conflict',
  });
  const pluginUiTarballValue = resolveInput({
    value: values.pluginUiTarball,
    environmentValue: environmentPath(UCX_WEB_PLUGIN_UI_TARBALL_ENV),
    conflictCode: 'packed_candidate_browser_qa_plugin_ui_tarball_conflict',
  });
  const cliTarballValue = resolveInput({
    value: values.cliTarball,
    environmentValue: environmentPath(UCX_WEB_CLI_TARBALL_ENV),
    conflictCode: 'packed_candidate_browser_qa_cli_tarball_conflict',
  });
  const rowLocalArtifactValues = [
    sdkTarballValue,
    pluginUiTarballValue,
    cliTarballValue,
  ];
  const hasRowLocalArtifact = rowLocalArtifactValues.some(Boolean);
  const hasAllRowLocalArtifacts = rowLocalArtifactValues.every(Boolean);
  const hasCandidateArtifactBasis = Boolean(candidateValue || novelHandoffValue);
  if (hasCandidateArtifactBasis && hasRowLocalArtifact) {
    throw new Error('packed_candidate_browser_qa_artifact_basis_conflict');
  }

  let artifactInputs;
  if (hasCandidateArtifactBasis) {
    if (!candidateValue) {
      throw new Error('packed_candidate_browser_qa_artifact_basis_required');
    }
    if (!novelHandoffValue) {
      throw new Error('packed_candidate_browser_qa_novel_handoff_required');
    }
    artifactInputs = {
      artifactBasis: 'candidate_manifest',
      manifestPath: isAbsolute(candidateValue)
        ? candidateValue
        : resolve(cwd, candidateValue),
      novelHandoffManifestPath: isAbsolute(novelHandoffValue)
        ? novelHandoffValue
        : resolve(cwd, novelHandoffValue),
    };
  } else if (hasRowLocalArtifact) {
    if (!hasAllRowLocalArtifacts) {
      throw new Error(
        'packed_candidate_browser_qa_row_local_artifacts_required',
      );
    }
    artifactInputs = {
      artifactBasis: 'row_local_natural',
      sdkTarballPath: isAbsolute(sdkTarballValue)
        ? sdkTarballValue
        : resolve(cwd, sdkTarballValue),
      pluginUiTarballPath: isAbsolute(pluginUiTarballValue)
        ? pluginUiTarballValue
        : resolve(cwd, pluginUiTarballValue),
      cliTarballPath: isAbsolute(cliTarballValue)
        ? cliTarballValue
        : resolve(cwd, cliTarballValue),
    };
  } else {
    throw new Error('packed_candidate_browser_qa_artifact_basis_required');
  }

  const triageGithubVoiceHandoffEnvironmentProvided = Object.hasOwn(
    env,
    TRIAGE_GITHUB_VOICE_HANDOFF_MANIFEST_ENV,
  );
  const triageGithubVoiceHandoffEnvironmentValue =
    env[TRIAGE_GITHUB_VOICE_HANDOFF_MANIFEST_ENV]?.trim() ?? '';
  if (
    triageGithubVoiceHandoffEnvironmentProvided
    && !triageGithubVoiceHandoffEnvironmentValue
  ) {
    throw new Error(
      'packed_candidate_browser_qa_triage_github_voice_blocked_handoff_value_required',
    );
  }
  if (
    values.triageGithubVoiceHandoff
    && triageGithubVoiceHandoffEnvironmentValue
    && resolve(cwd, values.triageGithubVoiceHandoff)
      !== resolve(cwd, triageGithubVoiceHandoffEnvironmentValue)
  ) {
    throw new Error(
      'packed_candidate_browser_qa_triage_github_voice_blocked_handoff_conflict',
    );
  }
  const triageGithubVoiceHandoffValue = values.triageGithubVoiceHandoff
    ?? (triageGithubVoiceHandoffEnvironmentProvided
      ? triageGithubVoiceHandoffEnvironmentValue
      : null);
  return {
    ...artifactInputs,
    ...(triageGithubVoiceHandoffValue
      ? {
        triageGithubVoiceHandoffManifestPath:
          isAbsolute(triageGithubVoiceHandoffValue)
            ? triageGithubVoiceHandoffValue
            : resolve(cwd, triageGithubVoiceHandoffValue),
      }
      : {}),
  };
}

export function buildPackedCandidateBrowserQaRunnerEvidence({
  hasCompletionHandoff,
  exitCode,
}) {
  return Object.freeze({
    v: 1,
    kind: 'packed_candidate_browser_qa_runner_evidence',
    process: Object.freeze({ exitCode }),
    outcome: exitCode === 0 ? 'passed' : 'failed',
    proofScope: hasCompletionHandoff
      ? 'normal_triage_github_voice_full_receipt_required'
      : 'credential_free_action_projection_partial',
    completion: hasCompletionHandoff ? 'full_receipt_required' : 'partial',
    // This runner never grants EU08 completion credit. The normal-product
    // path records its stricter completion receipt inside the Playwright row.
    fullEu08CompletionCredit: false,
  });
}

export function buildPackedCandidateBrowserQaInvocation({
  testsPackageRoot,
  artifactBasis,
  manifestPath,
  novelHandoffManifestPath,
  sdkTarballPath,
  pluginUiTarballPath,
  cliTarballPath,
  triageGithubVoiceHandoffManifestPath,
  triageGithubVoiceMicrophoneFixturePath,
  triageGithubVoiceAdapter,
  processExecPath,
}) {
  const candidateManifestBasis = artifactBasis === 'candidate_manifest'
    || (artifactBasis === undefined && Boolean(manifestPath));
  const targetSpecs = candidateManifestBasis
    ? [
      'settings.plugins.details.spec.ts',
      'plugin.packed-targeted-projection.spec.ts',
    ]
    : ['plugin.packed-targeted-projection.spec.ts'];
  return {
    command: processExecPath,
    args: [
      join(testsPackageRoot, 'scripts', 'run-playwright-with-heartbeat.mjs'),
      '--config',
      'playwright.ui.config.mjs',
      ...targetSpecs,
    ],
    cwd: testsPackageRoot,
    envPatch: {
      ...(candidateManifestBasis
        ? {
          [MANIFEST_ENV]: manifestPath,
          [NOVEL_HANDOFF_MANIFEST_ENV]: novelHandoffManifestPath,
        }
        : {
          [UCX_WEB_SDK_TARBALL_ENV]: sdkTarballPath,
          [UCX_WEB_PLUGIN_UI_TARBALL_ENV]: pluginUiTarballPath,
          [UCX_WEB_CLI_TARBALL_ENV]: cliTarballPath,
        }),
      ...(triageGithubVoiceHandoffManifestPath
        ? {
          [TRIAGE_GITHUB_VOICE_HANDOFF_MANIFEST_ENV]:
            triageGithubVoiceHandoffManifestPath,
          ...(triageGithubVoiceMicrophoneFixturePath
            ? {
              [TRIAGE_GITHUB_VOICE_MICROPHONE_FIXTURE_PATH_ENV]:
                triageGithubVoiceMicrophoneFixturePath,
            }
            : {}),
          ...(triageGithubVoiceAdapter
            ? {
              [TRIAGE_GITHUB_VOICE_ADAPTER_ENV]: triageGithubVoiceAdapter,
            }
            : {}),
        }
        : {}),
    },
  };
}

export async function runPackedCandidateBrowserQa({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  processExecPath = process.execPath,
  spawnProcess = spawn,
  writeStdout = (value) => process.stdout.write(value),
} = {}) {
  const testsPackageRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  const inputs = requirePackedCandidateBrowserQaInputs({
    argv,
    env,
    cwd,
  });
  await Promise.all(
    inputs.artifactBasis === 'candidate_manifest'
      ? [
        access(inputs.manifestPath),
        access(inputs.novelHandoffManifestPath),
      ]
      : [
        access(inputs.sdkTarballPath),
        access(inputs.pluginUiTarballPath),
        access(inputs.cliTarballPath),
      ],
  );
  const triageGithubVoiceHandoff = inputs.triageGithubVoiceHandoffManifestPath
    ? await loadPackedTriageGithubVoiceQaHandoff({
      manifestPath: inputs.triageGithubVoiceHandoffManifestPath,
    })
    : null;
  if (triageGithubVoiceHandoff) {
    assertPackedTriageGithubVoiceQaCompletionHandoff(triageGithubVoiceHandoff);
  }
  const invocation = buildPackedCandidateBrowserQaInvocation({
    testsPackageRoot,
    ...inputs,
    ...(triageGithubVoiceHandoff
      ? {
        triageGithubVoiceMicrophoneFixturePath:
          triageGithubVoiceHandoff.voice.microphoneFixturePath,
        triageGithubVoiceAdapter:
          resolvePackedTriageGithubVoiceQaAdapter(triageGithubVoiceHandoff),
      }
      : {}),
    processExecPath,
  });
  const child = spawnProcess(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: { ...env, ...invocation.envPatch },
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`packed_candidate_browser_qa_terminated:${signal}`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
  const evidence = buildPackedCandidateBrowserQaRunnerEvidence({
    hasCompletionHandoff: triageGithubVoiceHandoff !== null,
    exitCode,
  });
  writeStdout(`${JSON.stringify(evidence)}\n`);
  return evidence;
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runPackedCandidateBrowserQa()
    .then((evidence) => {
      process.exitCode = evidence.process.exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
