import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import {
  computeRunnerAuthoringCommitmentV1,
  RunnerLaunchManifestV1Schema,
} from '@happier-dev/protocol/ephemeralRunner/launchManifest';

import {
  EPHEMERAL_RUNNER_ENDPOINT_TRANSLATION_KEYS,
  createEphemeralRunnerTerminalUi,
  formatEphemeralRunnerConsentReview,
  resolveEphemeralRunnerActiveClosePresentation,
  resolveEphemeralRunnerConsentReviewPresentation,
  resolveEphemeralRunnerDirectoryChoicePresentation,
  resolveEphemeralRunnerEndpointPresentation,
  resolveEphemeralRunnerEndpointLocale,
  resolveEphemeralRunnerFailureRecoveryPresentation,
  resolveEphemeralRunnerReviewedRuntimeFacts,
} from './endpointTerminalUi';

const preparedAuthoring = {
  v: 1 as const,
  actionsSettings: { v: 1 as const, actions: { 'session.activity.get': { approvalRequiredSurfaces: [] } } },
  mcpMaterial: {
    v: 1 as const,
    strictMode: true,
    capabilitySelection: { mcp: { v: 1 as const, managedServersEnabled: false, forceIncludeServerIds: ['mcp-review'], forceExcludeServerIds: [] } },
    servers: [{
      serverId: 'mcp-review', serverRevision: 2, bindingId: 'binding-review', bindingRevision: 4,
      savedSecretRevisions: [{ secretId: 'mcp-token', revision: 5 }],
      config: {
        id: 'mcp-review', name: 'reviewed_mcp', transport: 'stdio' as const,
        stdio: { command: '/runner/bin/reviewed-mcp', args: ['--token', 'mcp-argument-secret'] },
        env: { TOKEN: { t: 'literal' as const, v: 'mcp-sealed-secret' } },
        createdAt: 1, updatedAt: 2,
      },
    }],
  },
  authoring: {
    targetType: 'new_session' as const,
    executionTarget: { kind: 'temporary_computer' as const, serverId: 'srv_acme_home', artifactTarget: 'linux-x64' as const, workspace: { kind: 'choose_on_endpoint' as const } },
    primaryTeamId: 'team-acme',
    agentTarget: { kind: 'agent' as const, identity: { pluginId: 'dev.happier.codex', localId: 'codex' } },
    modelSelection: { v: 1 as const, ref: { agentTargetKey: 'agent:dev.happier.codex/codex', providerConnectionId: null, modelId: 'gpt-5.6' }, updatedAt: 1 },
    permissionMode: 'safe-yolo',
    transcriptStorage: 'direct' as const,
    profileId: 'review-profile',
    environmentVariables: { RUNNER_MODE: 'super-secret-env-value' },
    capabilitySelection: { mcp: { v: 1 as const, managedServersEnabled: false, forceIncludeServerIds: ['mcp-review'], forceExcludeServerIds: [] } },
    connectedServices: { v: 2 as const, bindingsByServiceId: { 'dev.happier.github/github': { source: 'native' as const } } },
    checkoutCreationDraft: { kind: 'git_worktree' as const, displayName: 'reviewed-worktree', baseRef: 'main', branchMode: 'new' as const },
    resumeSessionId: 'provider-session-reviewed',
    terminal: { mode: 'tmux' as const, tmux: { sessionName: 'runner-reviewed', isolated: true, tmpDir: '/tmp/runner-reviewed' } },
    windowsRemoteSessionLaunchMode: 'windows_terminal' as const,
    windowsRemoteSessionConsole: 'visible' as const,
    windowsTerminalWindowName: 'Runner reviewed',
    acpSessionModeId: 'review-mode',
    sessionConfigOptionOverrides: { v: 1 as const, updatedAt: 2, overrides: { speed: { updatedAt: 2, value: 'careful' } } },
    access: { grants: [{ subject: { kind: 'account' as const, accountId: 'reviewer-account' }, accessLevel: 'edit' as const, canApprovePermissions: false }] },
    organizationPlacement: { folderId: 'folder-reviewed', tagIds: ['tag-reviewed'] },
  },
  composer: {
    text: 'Fix the checkout race without changing user features.',
    references: [{ kind: 'acme.issue', ref: 'issue:42', token: '@issue-42', label: 'Issue #42', start: 0, end: 9 }],
    attachments: [],
  },
  reviewComments: {
    workspace: { serverId: 'srv_acme_home', machineId: 'machine-review', rootPath: '/review/root' },
    comments: [{ id: 'comment-1', filePath: 'src/review.ts', source: 'file' as const, anchor: { kind: 'fileLine' as const, startLine: 4, lineHash: 'lh1:1234567890abcdef' }, snapshot: { selectedLines: ['const reviewed = true;'], beforeContext: [], afterContext: [] }, body: 'Keep this behavior.', createdAt: 1 }],
  },
  files: [{ id: 'file-1', name: 'trace.txt', mimeType: 'text/plain', sizeBytes: 42, sha256: 'a'.repeat(64) }],
  attachmentDestination: { uploadLocation: 'workspace' as const, workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'git_info_exclude' as const, vcsIgnoreWritesEnabled: true },
};
const authoringCommitment = computeRunnerAuthoringCommitmentV1(preparedAuthoring);
const manifest = RunnerLaunchManifestV1Schema.parse({
  v: 1,
  purpose: 'happier.ephemeral-session-runner.launch-manifest',
  binding: {
    activationId: '00000000-0000-4000-8000-000000000013',
    homeServerIdentityId: 'srv_acme_home',
    creatorAccountId: 'alice-account',
    creatorTokenEpoch: 1,
    activationExpiresAt: null,
    workspace: { kind: 'choose_on_endpoint' as const },
    sessionId: 'session-review',
    machineId: 'machine-review',
    activationSigningPublicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey, 'base64url'),
    authoringCommitment,
    artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'b'.repeat(64) },
    endpointFactsRecipient: { mode: 'plain', creatorAccountId: 'alice-account' },
  },
  preparedAuthoring,
  authoringCommitment,
  endpointFacts: {
    v: 1,
    directory: '/Users/bob/Projects/widget',
    machine: {
      host: 'runner.example.test',
      platform: 'linux',
      happyCliVersion: '0.3.0',
      happyHomeDir: '/Users/bob/.happier-runner',
      homeDir: '/Users/bob/.happier-runner',
    },
  },
  machineContentKeyBinding: null,
  displayFacts: {
    v: 1,
    homeId: 'srv_acme_home',
    homeName: 'Acme Home 🌍',
    requesterId: 'alice-account',
    requesterName: 'Alice Example',
    teamId: 'team-acme',
    teamName: '研究開発チーム',
  },
  credentialSelectionBinding: { v: 1, resourceId: 'resource-acme', brokerMachineId: 'broker-machine', revision: 7,
    application: { agentTargetKey: 'agent:dev.happier.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
    sourceRevision: 'source-revision-7' },
  reviewedProviderModel: {
    selection: { kind: 'team_credential_provider_model', resourceId: 'resource-acme', teamId: 'team-acme', expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:dev.happier.codex/codex', modelId: 'gpt-5.6' },
    descriptor: { id: 'gpt-5.6', name: 'GPT 5.6 Verified' },
    application: { agentTargetKey: 'agent:dev.happier.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
    sourceRevision: 'source-revision-7',
    availability: 'available',
  },
  connectedServiceReviewBindings: { v: 1, bindings: [] },
});

describe('ephemeral Runner terminal endpoint presentation', () => {
  it('renders every exact consent fact and the OS-permission warning before Allow', () => {
    const rendered = formatEphemeralRunnerConsentReview({
      manifest,
      directory: '/Users/bob/Projects/widget',
    });

    expect(rendered).toContain('srv_acme_home');
    expect(rendered).toContain('alice-account');
    expect(rendered).toContain('team-acme');
    expect(rendered).toContain('dev.happier.codex');
    expect(rendered).toContain('gpt-5.6');
    expect(rendered).toContain('safe-yolo');
    expect(rendered).toContain('Action policy');
    expect(rendered).toContain('session.activity.get');
    expect(rendered).toContain('Fix the checkout race without changing user features.');
    expect(rendered).toContain('trace.txt');
    expect(rendered).toContain('a'.repeat(64));
    expect(rendered).toContain('resource-acme');
    expect(rendered).toContain('broker-machine');
    expect(rendered).toContain('/Users/bob/Projects/widget');
    expect(rendered).toMatch(/current OS user/i);
    expect(rendered).toMatch(/not a sandbox/i);
    expect(rendered).toContain('Application: Happier Runner 0.3.0');
    expect(rendered).toContain('Publisher: Happier');
    expect(rendered).toContain('linux-x64');
    expect(rendered).toContain('b'.repeat(64));
  });

  it('projects one closed review view-model carrying every material consent fact', () => {
    const presentation = resolveEphemeralRunnerConsentReviewPresentation({
      manifest,
      directory: '/Users/bob/Projects/widget',
    });
    const facts = presentation.sections.flatMap((section) => section.facts);
    const valueOf = (id: string) => {
      const fact = facts.find((entry) => entry.id === id);
      if (!fact) throw new Error(`Missing reviewed fact: ${id}`);
      return fact.value;
    };

    expect(presentation.heading).toBe('Happier Runner');
    expect(presentation.title).toBe('Review the exact request');
    // Allow is never the pre-selected default of the consent step.
    expect(presentation.defaultDecision).toBe('decline');

    expect(valueOf('application')).toBe('Happier Runner 0.3.0');
    expect(valueOf('publisher')).toBe('Happier');
    expect(valueOf('artifact')).toContain('linux-x64');
    expect(valueOf('artifact')).toContain('b'.repeat(64));

    expect(valueOf('home')).toBe('Acme Home 🌍');
    expect(valueOf('home_id')).toBe('srv_acme_home');
    expect(valueOf('requested_by')).toBe('Alice Example');
    expect(valueOf('requester_id')).toBe('alice-account');
    expect(valueOf('team')).toBe('研究開発チーム');
    expect(valueOf('team_id')).toBe('team-acme');
    expect(valueOf('folder')).toBe('/Users/bob/Projects/widget');

    expect(valueOf('agent')).toBe('Codex');
    expect(valueOf('agent_id')).toBe('agent:dev.happier.codex/codex');
    expect(valueOf('model')).toBe('GPT 5.6 Verified');
    expect(valueOf('model_id')).toBe('gpt-5.6');
    expect(valueOf('permissions')).toBe('safe-yolo');
    expect(valueOf('profile')).toBe('review-profile');
    expect(valueOf('environment')).toContain('RUNNER_MODE');
    expect(valueOf('environment')).not.toContain('super-secret-env-value');
    expect(valueOf('mcp')).toContain('mcp-review');
    expect(valueOf('mcp_material')).toContain('/runner/bin/reviewed-mcp');
    expect(valueOf('mcp_material')).toContain('mcp-token');
    expect(JSON.parse(valueOf('mcp_material')).capabilitySelection).toEqual(preparedAuthoring.mcpMaterial.capabilitySelection);
    expect(valueOf('mcp_material')).not.toContain('mcp-sealed-secret');
    expect(valueOf('mcp_material')).not.toContain('mcp-argument-secret');
    expect(valueOf('connected_services')).toContain('dev.happier.github/github');
    expect(valueOf('connected_service_bindings')).toContain('"bindings": []');
    expect(valueOf('acp_mode')).toBe('review-mode');
    expect(valueOf('session_configuration')).toContain('careful');
    expect(valueOf('transcript_storage')).toBe('direct');
    expect(valueOf('initial_access')).toContain('reviewer-account');
    expect(valueOf('organization_placement')).toContain('folder-reviewed');
    expect(valueOf('checkout')).toContain('reviewed-worktree');
    expect(valueOf('resume_session')).toBe('provider-session-reviewed');
    expect(valueOf('terminal')).toContain('runner-reviewed');
    expect(valueOf('windows_launch_preferences')).toMatch(/not applied.*native Runner shell/i);
    expect(valueOf('ai_resource')).toBe('resource-acme');
    expect(valueOf('ai_source')).toBe('Openai');
    expect(valueOf('ai_source_id')).toBe('happier.provider.openai/openai');
    expect(valueOf('broker_machine')).toBe('broker-machine');

    expect(valueOf('prompt')).toContain('Fix the checkout race without changing user features.');
    expect(valueOf('references')).toContain('issue:42');
    expect(valueOf('action_policy')).toContain('session.activity.get');
    expect(valueOf('review_comments')).toContain('Keep this behavior.');

    const reviewedFile = facts.find((entry) => entry.id === 'file:file-1');
    expect(reviewedFile?.label).toBe('trace.txt');
    expect(reviewedFile?.value).toContain('text/plain');
    expect(reviewedFile?.value).toContain('42 bytes');
    expect(reviewedFile?.value).toContain('a'.repeat(64));
    expect(valueOf('attachment_destination')).toContain('workspace');
    expect(valueOf('workspace_folder')).toContain('.happier/uploads');
    expect(valueOf('vcs_ignore')).toContain('git_info_exclude');
    expect(valueOf('vcs_ignore_writes')).toBe('Enabled');

    const notice = presentation.notice.join(' ');
    expect(notice).toMatch(/current OS user/i);
    expect(notice).toMatch(/not a sandbox/i);
  });

  it('renders the terminal consent review from that one projection', () => {
    const input = { manifest, directory: '/Users/bob/Projects/widget' };
    const rendered = formatEphemeralRunnerConsentReview(input);
    const presentation = resolveEphemeralRunnerConsentReviewPresentation(input);

    for (const section of presentation.sections) {
      expect(rendered).toContain(section.title);
      for (const fact of section.facts) {
        expect(rendered).toContain(fact.label);
        expect(rendered).toContain(fact.value);
      }
    }
    for (const line of presentation.notice) expect(rendered).toContain(line);
  });

  it('defaults consent and active-close choices to the safe non-effect choices', async () => {
    const answers = ['d', 'k'];
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: true,
      write: vi.fn(),
      readInput: vi.fn(async () => answers.shift() ?? ''),
      resolveDirectory: (value) => value,
      isDirectory: vi.fn(async () => true),
      selectNativeDirectory: vi.fn(async () => ({ status: 'unavailable' as const })),
    });

    await expect(ui.reviewAndRequestConsent({
      review: {
        manifest,
        launchManifestCommitment: 'commitment',
        authoringCommitment: 'authoring',
        directory: '/Users/bob/Projects/widget',
      },
      pluginInstallation: null,
      signal: new AbortController().signal,
    })).resolves.toEqual({ allow: false });
    await expect(ui.confirmActiveClose({ phase: 'running', signal: new AbortController().signal }))
      .resolves.toBe('keep_open');
  });

  it('stops when terminal-window close removes the active decision prompt', async () => {
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: true,
      write: vi.fn(),
      readInput: vi.fn(async () => {
        const error = new Error('Terminal prompt closed');
        error.name = 'AbortError';
        throw error;
      }),
    });

    await expect(ui.confirmActiveClose({ phase: 'running', signal: new AbortController().signal }))
      .resolves.toBe('stop');
  });

  it('projects one accessible announcement and only actions valid for the current phase', () => {
    expect(resolveEphemeralRunnerEndpointPresentation({ phase: 'running', connection: 'connected' })).toEqual(expect.objectContaining({
      heading: 'Happier Runner',
      announcement: expect.objectContaining({ priority: 'polite' }),
      actions: [{ id: 'stop_session', label: 'Stop Session' }],
    }));
    expect(resolveEphemeralRunnerEndpointPresentation({ phase: 'starting', connection: 'connected' })).toEqual(expect.objectContaining({
      actions: [{ id: 'stop_session', label: 'Stop Session' }],
    }));
    expect(resolveEphemeralRunnerEndpointPresentation({
      phase: 'failed',
      connection: 'connected',
      failure: {
        kind: 'before_session',
      },
      canRetry: true,
    })).toEqual(expect.objectContaining({
      announcement: expect.objectContaining({ priority: 'assertive' }),
      focusTarget: 'primary_recovery',
      actions: [{ id: 'retry', label: 'Retry' }, { id: 'exit', label: 'Exit' }],
      detail: 'The request could not be prepared. Check the activation and try again.',
    }));
  });

  it('projects the quiet reviewed facts only while the consented Session is active', () => {
    const reviewedRuntimeSummary = resolveEphemeralRunnerReviewedRuntimeFacts({
      manifest,
      directory: '/Users/bob/Projects/widget',
    });

    expect(reviewedRuntimeSummary.map((entry) => entry.id))
      .toEqual(['home', 'requested_by', 'team', 'agent', 'folder']);
    // No consent-only fact survives the narrowing.
    expect(JSON.stringify(reviewedRuntimeSummary)).not.toContain('Fix the checkout race');

    expect(resolveEphemeralRunnerEndpointPresentation({
      phase: 'reviewing',
      connection: 'connected',
      reviewedRuntimeSummary,
    }).facts).toEqual([]);
    for (const phase of ['starting', 'running', 'stopping'] as const) {
      expect(resolveEphemeralRunnerEndpointPresentation({
        phase,
        connection: 'connected',
        reviewedRuntimeSummary,
      }).facts).toEqual(reviewedRuntimeSummary);
    }
    // A surface that never observed the review has nothing to show.
    expect(resolveEphemeralRunnerEndpointPresentation({ phase: 'running', connection: 'connected' }).facts)
      .toEqual([]);
  });

  it('asks each optional plugin access separately after Allow, off unless answered yes', async () => {
    const answers = ['a', 'a', ''];
    const prompts: string[] = [];
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: true,
      write: vi.fn(),
      readInput: vi.fn(async (prompt: string) => { prompts.push(prompt); return answers.shift() ?? ''; }),
    });
    const optionalHostAccess = [
      { id: 'clipboard.write', capability: 'clipboard', reason: 'Copies results', authorizationClass: 'hostResourceSelection', normalizedScope: {} },
      { id: 'network.fetch', capability: 'network', reason: 'Fetches docs', authorizationClass: 'hostResourceSelection', normalizedScope: {} },
    ];

    await expect(ui.reviewAndRequestConsent({
      review: { manifest, launchManifestCommitment: 'c', authoringCommitment: 'a', directory: '/Users/bob/Projects/widget' },
      pluginInstallation: {
        pluginId: 'acme.reviewed-external',
        displayName: 'Reviewed External',
        version: '1.2.3',
        packageIdentity: { name: '@acme/reviewed-external', version: '1.2.3' },
        publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
        source: { kind: 'npm', locator: '@acme/reviewed-external@1.2.3', integrity: `sha512-${'A'.repeat(86)}==`, integrityBasis: 'expected' },
        updateChannel: { kind: 'npm', packageName: '@acme/reviewed-external', registryOrigin: 'https://registry.npmjs.org' },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: { status: 'unreviewed', sourceId: 'marketplace:community-npm' },
        executableRealms: ['daemon'],
        contributions: [{ family: 'agents', count: 1 }],
        requestInterceptors: [],
        uiArtifacts: { status: 'none', contributionIds: [] },
        requiredHostAccess: [],
        optionalHostAccess,
        rawCredentialAccess: [],
        compatibility: { runtimeApiVersion: 1 },
        updatePolicy: 'pinned',
      } as never,
      signal: new AbortController().signal,
    })).resolves.toEqual({ allow: true, optionalSelections: [
      { accessId: 'clipboard.write', selected: true },
      { accessId: 'network.fetch', selected: false },
    ] });
    expect(prompts.filter((prompt) => prompt.includes('optional'))).toHaveLength(2);
  });

  it('asks for a private registry sign-in with a hidden token, and declines by default', async () => {
    const answers = ['s', 'd'];
    const written: string[] = [];
    const readSecret = vi.fn(async () => '  endpoint-token  ');
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: true,
      write: (value) => { written.push(value); },
      readInput: vi.fn(async () => answers.shift() ?? ''),
      readSecret,
    });
    const requirement = { registryOrigin: 'https://npm.acme.example.test', packageName: '@acme/agent', registryProfileId: null };
    const signal = new AbortController().signal;

    await expect(ui.requestRegistryProfile({ requirement, signal })).resolves.toEqual({ credential: 'endpoint-token' });
    expect(readSecret).toHaveBeenCalledOnce();
    expect(written.join('')).toContain('https://npm.acme.example.test');
    expect(written.join('')).toContain('@acme/agent');
    // The typed token never reaches the terminal output.
    expect(written.join('')).not.toContain('endpoint-token');
    await expect(ui.requestRegistryProfile({ requirement, signal })).resolves.toBeNull();
    // An empty answer takes the safe default: decline.
    await expect(ui.requestRegistryProfile({ requirement, signal })).resolves.toBeNull();
  });

  it('keeps the terminal running surface quiet and free of consent-only detail', async () => {
    const writes: string[] = [];
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: true,
      write: (value) => writes.push(value),
      readInput: vi.fn(async () => 'a'),
    });

    await expect(ui.reviewAndRequestConsent({
      review: {
        manifest,
        launchManifestCommitment: 'commitment',
        authoringCommitment: 'authoring',
        directory: '/Users/bob/Projects/widget',
      },
      pluginInstallation: null,
      signal: new AbortController().signal,
    })).resolves.toEqual({ allow: true, optionalSelections: [] });
    writes.length = 0;
    ui.present({ phase: 'running', connection: 'connected' });

    const output = writes.join('');
    expect(output).toContain('Home: Acme Home 🌍');
    expect(output).toContain('Agent: Codex');
    expect(output).toContain('/Users/bob/Projects/widget');
    expect(output).toContain('[ Stop Session ]');
    expect(output).not.toContain('Fix the checkout race without changing user features.');
    expect(output).not.toContain('a'.repeat(64));
    expect(output).not.toContain('Action policy');
  });

  it('keeps Stop Session persistently reachable and routes it through the bound controller', async () => {
    const requestStop = vi.fn(async () => 'stopped' as const);
    const writes: string[] = [];
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: true,
      write: (value) => writes.push(value),
      readInput: vi.fn(async () => 's'),
      resolveDirectory: (value) => value,
      isDirectory: vi.fn(async () => true),
      selectNativeDirectory: vi.fn(async () => ({ status: 'unavailable' as const })),
    });
    const unbind = ui.bindControls({ requestStop });

    ui.present({ phase: 'running', connection: 'connected' });
    ui.present({ phase: 'running', connection: 'connected' });
    await vi.waitFor(() => expect(requestStop).toHaveBeenCalledOnce());

    expect(writes.filter((value) => value.includes('[ Stop Session ]'))).toHaveLength(1);
    unbind();
  });

  it('accepts Stop again after Keep open without another presentation event', async () => {
    const answers = ['s', 'k', 's', 's'];
    const decisions: string[] = [];
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: true,
      write: vi.fn(),
      readInput: async () => {
        const answer = answers.shift();
        if (answer === undefined) throw new Error('unexpected_prompt');
        return answer;
      },
    });
    const unbind = ui.bindControls({ requestStop: async () => {
      const decision = await ui.confirmActiveClose({ phase: 'running', signal: new AbortController().signal });
      decisions.push(decision);
      if (decision === 'stop') ui.present({ phase: 'stopping', connection: 'connected' });
      return decision === 'keep_open' ? 'kept_open' : 'stopped';
    } });
    try {
      ui.present({ phase: 'running', connection: 'connected' });
      await vi.waitFor(() => expect(decisions).toEqual(['keep_open', 'stop']));
      expect(answers).toEqual([]);
    } finally {
      unbind();
    }
  });

  it('keeps connection wording consistent through running reconnect and recovery', () => {
    const writes: string[] = [];
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: false,
      write: (value) => writes.push(value),
    });
    for (const connection of ['connected', 'reconnecting', 'connected'] as const) {
      writes.length = 0;
      ui.present({ phase: 'running', connection });
      const presentation = resolveEphemeralRunnerEndpointPresentation({ phase: 'running', connection });
      expect(writes.join('')).toContain(presentation.status);
      expect(writes.join('')).toContain('[ Stop Session ]');
      if (connection === 'reconnecting') expect(writes.join('')).not.toContain('Connected.');
    }
  });

  it('returns a cancelled native folder dialog to the chooser without offering a Home fallback', async () => {
    const answers = ['c', 'c'];
    const selectNativeDirectory = vi.fn()
      .mockResolvedValueOnce({ status: 'cancelled' as const })
      .mockResolvedValueOnce({ status: 'selected' as const, directory: '/Users/bob/Projects' });
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: true,
      write: vi.fn(),
      readInput: vi.fn(async () => answers.shift() ?? ''),
      resolveDirectory: (value) => value,
      isDirectory: vi.fn(async () => true),
      selectNativeDirectory,
    });

    await expect(ui.selectDirectory({ signal: new AbortController().signal }))
      .resolves.toBe('/Users/bob/Projects');
    expect(selectNativeDirectory).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the selected shell has neither a native chooser nor the approved Happier SelectionList', async () => {
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: true,
      write: vi.fn(),
      readInput: vi.fn(async () => 'c'),
      selectNativeDirectory: vi.fn(async () => ({ status: 'unavailable' as const })),
    });

    await expect(ui.selectDirectory({ signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'RUNNER_NATIVE_DIRECTORY_PICKER_UNAVAILABLE' });
  });

  it('keeps long consent content complete and emits no color-only terminal styling', () => {
    const longPath = `/workspace/${'nested/'.repeat(100)}project`;
    const rendered = formatEphemeralRunnerConsentReview({ manifest, directory: longPath });

    expect(rendered).toContain(longPath);
    expect(rendered).toContain('Fix the checkout race without changing user features.');
    expect(rendered).not.toMatch(/\u001b\[[0-9;]*m/);
  });

  it('keeps long verified Unicode labels complete and all consent actions reachable', () => {
    const longLabel = '研究🌍'.repeat(96);
    const rendered = formatEphemeralRunnerConsentReview({
      manifest: { ...manifest, displayFacts: { ...manifest.displayFacts, teamName: longLabel } },
      directory: '/workspace',
    });
    expect(rendered).toContain(longLabel);
    const presentation = resolveEphemeralRunnerConsentReviewPresentation({
      manifest: { ...manifest, displayFacts: { ...manifest.displayFacts, teamName: longLabel } },
      directory: '/workspace',
    });
    expect(presentation.declineLabel).toBe('Decline');
    expect(presentation.allowLabel).toBe('Allow');
  });

  it('uses the native directory chooser as the selected terminal-shell mechanism', async () => {
    const readInput = vi.fn(async () => 'c');
    const selectNativeDirectory = vi.fn(async () => ({
      status: 'selected' as const,
      directory: '/Users/bob/Native Pick',
    }));
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      interactive: true,
      write: vi.fn(),
      readInput,
      resolveDirectory: (value) => value,
      isDirectory: vi.fn(async () => true),
      selectNativeDirectory,
    });

    await expect(ui.selectDirectory({ signal: new AbortController().signal }))
      .resolves.toBe('/Users/bob/Native Pick');
    expect(selectNativeDirectory).toHaveBeenCalledOnce();
    expect(readInput).toHaveBeenCalledOnce();
  });

  it('keeps every endpoint copy key complete and resolves OS locale facts with an English fallback', () => {
    expect(EPHEMERAL_RUNNER_ENDPOINT_TRANSLATION_KEYS.length).toBeGreaterThan(40);
    expect(new Set(EPHEMERAL_RUNNER_ENDPOINT_TRANSLATION_KEYS).size)
      .toBe(EPHEMERAL_RUNNER_ENDPOINT_TRANSLATION_KEYS.length);
    expect(resolveEphemeralRunnerEndpointLocale({ locale: 'fr_CH.UTF-8' })).toBe('fr');
    expect(resolveEphemeralRunnerEndpointLocale({ locale: 'zz-ZZ' })).toBe('en');
    expect(resolveEphemeralRunnerEndpointLocale({
      environment: { LC_ALL: 'C', LANG: 'fr_FR.UTF-8' },
    })).toBe('en');
  });

  it('localizes one closed French endpoint presentation without changing consent or review facts', () => {
    const locale = 'fr' as const;
    const chooser = resolveEphemeralRunnerDirectoryChoicePresentation({ locale });
    const review = resolveEphemeralRunnerConsentReviewPresentation({
      manifest,
      directory: '/workspace/exact',
      locale,
    });
    const close = resolveEphemeralRunnerActiveClosePresentation({ phase: 'running', locale });
    const failure = resolveEphemeralRunnerFailureRecoveryPresentation({
      failure: {
        kind: 'before_session',
      },
      locale,
    });
    const running = resolveEphemeralRunnerEndpointPresentation({
      phase: 'running',
      connection: 'connected',
      locale,
    });

    expect(chooser).toMatchObject({
      documentLanguage: 'fr',
      chooseLabel: 'Choisir un dossier',
      cancelLabel: 'Annuler la demande',
    });
    expect(review).toMatchObject({
      documentLanguage: 'fr',
      title: 'Vérifier la demande exacte',
      declineLabel: 'Refuser',
      allowLabel: 'Autoriser',
      defaultDecision: 'decline',
    });
    expect(review.sections.find((section) => section.id === 'destination')?.facts)
      .toContainEqual(expect.objectContaining({ id: 'folder', label: 'Dossier de travail', value: '/workspace/exact' }));
    expect(review.notice.join(' ')).toContain('pas un bac à sable');
    expect(close).toMatchObject({ keepOpenLabel: 'Garder ouvert', stopLabel: 'Arrêter la session' });
    expect(failure).toMatchObject({
      message: "La demande n’a pas pu être préparée. Vérifie l’activation et réessaie.",
      retryLabel: 'Réessayer',
      exitLabel: 'Quitter',
    });
    expect(running.actions).toEqual([{ id: 'stop_session', label: 'Arrêter la session' }]);
  });

  it('resolves locale once for the terminal and uses that closed copy across decisions and status', async () => {
    const writes: string[] = [];
    const prompts: string[] = [];
    const answers = ['c', 'r'];
    const ui = createEphemeralRunnerTerminalUi({
      activation: {
        homeServerIdentityId: 'srv_acme_home',
        creatorAccountId: 'alice-account',
        artifact: manifest.binding.artifact,
      },
      locale: 'fr-FR',
      interactive: true,
      write: (value) => writes.push(value),
      readInput: vi.fn(async (message) => {
        prompts.push(message);
        return answers.shift() ?? '';
      }),
      resolveDirectory: (value) => value,
      isDirectory: vi.fn(async () => true),
      selectNativeDirectory: vi.fn(async () => ({ status: 'selected' as const, directory: '/Users/alice' })),
    });

    await expect(ui.selectDirectory({ signal: new AbortController().signal }))
      .resolves.toBe('/Users/alice');
    await expect(ui.reviewAndRequestConsent({
      review: {
        manifest,
        directory: '/Users/alice',
        launchManifestCommitment: 'launch',
        authoringCommitment: 'authoring',
      },
      pluginInstallation: null,
      signal: new AbortController().signal,
    })).resolves.toEqual({ allow: false });
    ui.present({ phase: 'running', connection: 'connected' });

    expect(prompts).toEqual(expect.arrayContaining([
      expect.stringContaining('Choisir le dossier de travail'),
      expect.stringContaining('Autoriser cette demande exacte'),
    ]));
    expect(writes.join('\n')).toContain('L’Agent est en cours d’exécution');
    expect(writes.join('\n')).toContain('[ Arrêter la session ]');
  });

  it('carries the canonical plugin installation review into the one consent projection', () => {
    const pluginInstallation = {
      pluginId: 'acme.reviewed-external',
      displayName: 'Reviewed External',
      version: '1.2.3',
      packageIdentity: { name: '@acme/reviewed-external', version: '1.2.3' },
      publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
      source: { kind: 'npm', locator: '@acme/reviewed-external@1.2.3', integrity: `sha512-${'A'.repeat(86)}==`, integrityBasis: 'expected' },
      updateChannel: { kind: 'npm', packageName: '@acme/reviewed-external', registryOrigin: 'https://registry.npmjs.org' },
      signature: { status: 'notProvided' },
      provenance: { status: 'notProvided' },
      curation: { status: 'unreviewed', sourceId: 'marketplace:community-npm' },
      executableRealms: ['daemon'],
      contributions: [{ family: 'agents', count: 1 }],
      requestInterceptors: [],
      uiArtifacts: { status: 'none', contributionIds: [] },
      requiredHostAccess: [{ id: 'files.read', capability: 'files', reason: 'Reads the workspace', authorizationClass: 'cooperativeDisclosure', normalizedScope: {} }],
      optionalHostAccess: [],
      rawCredentialAccess: [],
      compatibility: { runtimeApiVersion: 1 },
      updatePolicy: 'pinned',
    } as never;
    const input = { manifest, directory: '/Users/bob/Projects/widget', pluginInstallation };
    const presentation = resolveEphemeralRunnerConsentReviewPresentation(input);
    const facts = presentation.sections.flatMap((section) => section.facts);
    const valueOf = (id: string) => facts.find((fact) => fact.id === id)?.value;

    expect(valueOf('plugin_package')).toContain('@acme/reviewed-external');
    expect(valueOf('plugin_package')).toContain('1.2.3');
    expect(valueOf('plugin_integrity')).toContain('sha512-');
    expect(valueOf('plugin_publisher')).toMatch(/Acme.*unverified/i);
    expect(valueOf('plugin_update_channel')).toContain('registry.npmjs.org');
    expect(valueOf('plugin_curation')).toMatch(/unreviewed/i);
    expect(valueOf('plugin_signature')).toBe('Not provided');
    expect(valueOf('plugin_provenance')).toBe('Not provided');
    expect(valueOf('plugin_executable_code')).toContain('daemon');
    expect(valueOf('plugin_required_access')).toContain('files');

    // The same closed projection is what the terminal renders, so no plugin
    // fact can appear on one endpoint surface and be missing on the other.
    const rendered = formatEphemeralRunnerConsentReview(input);
    for (const fact of facts) expect(rendered).toContain(fact.value);

    // A bundled Agent installs nothing and must not show an empty install block.
    const bundled = resolveEphemeralRunnerConsentReviewPresentation({
      manifest,
      directory: '/Users/bob/Projects/widget',
    });
    expect(bundled.sections.flatMap((section) => section.facts).map((fact) => fact.id))
      .not.toContain('plugin_package');
  });

  it('discloses every canonical installation-review fact the settings surface shows', () => {
    const pluginInstallation = {
      pluginId: 'acme.reviewed-external',
      displayName: 'Reviewed External',
      version: '1.2.3',
      packageIdentity: { name: '@acme/reviewed-external', version: '1.2.3' },
      publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
      source: { kind: 'npm', locator: '@acme/reviewed-external@1.2.3', integrity: `sha512-${'A'.repeat(86)}==`, integrityBasis: 'expected' },
      updateChannel: { kind: 'npm', packageName: '@acme/reviewed-external', registryOrigin: 'https://registry.npmjs.org' },
      signature: { status: 'verified', keyId: 'key-7' },
      provenance: { status: 'declaredUnverified', predicateType: 'https://slsa.dev/provenance/v1' },
      curation: { status: 'unreviewed', sourceId: 'marketplace:community-npm' },
      executableRealms: ['daemon'],
      contributions: [{ family: 'agents', count: 1 }],
      requestInterceptors: [{ id: 'proxy.all', origins: ['https://api.example'], methods: ['POST'], priority: 10 }],
      uiArtifacts: { status: 'none', contributionIds: [] },
      requiredHostAccess: [{ id: 'files.read', capability: 'files', reason: 'Reads the workspace', authorizationClass: 'cooperativeDisclosure', normalizedScope: { roots: ['workspace'] } }],
      optionalHostAccess: [{ id: 'clipboard.write', capability: 'clipboard', reason: 'Copies results', authorizationClass: 'hostResourceSelection', normalizedScope: {} }],
      rawCredentialAccess: [{
        accessMode: 'raw',
        contribution: { pluginId: 'acme.reviewed-external', localId: 'acme-voice' },
        credentialSlot: { id: 'apiKey', title: 'API key', purpose: 'voice' },
        sourceClass: { kind: 'savedSecret' },
        realm: 'daemon',
        phase: 'session',
        request: {},
      }],
      compatibility: { runtimeApiVersion: 1 },
      updatePolicy: 'pinned',
    } as never;
    const presentation = resolveEphemeralRunnerConsentReviewPresentation({
      manifest,
      directory: '/Users/bob/Projects/widget',
      pluginInstallation,
    });
    const facts = presentation.sections.flatMap((section) => section.facts);
    const valueOf = (id: string) => facts.find((fact) => fact.id === id)?.value;

    // The person whose machine runs this code must not decide on strictly less
    // than a Happier settings user sees for the same canonical review.
    expect(valueOf('plugin_signature')).toContain('key-7');
    expect(valueOf('plugin_provenance')).toContain('slsa.dev');
    expect(valueOf('plugin_request_interceptors')).toContain('api.example');
    expect(valueOf('plugin_raw_credential_access')).toContain('acme-voice');
    expect(valueOf('plugin_raw_credential_access')).toContain('API key');
    expect(valueOf('plugin_optional_access')).toContain('clipboard.write');
    expect(valueOf('plugin_required_access')).toContain('workspace');
  });
});
