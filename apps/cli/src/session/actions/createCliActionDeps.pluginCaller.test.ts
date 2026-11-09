import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';

const settingsAdministration = vi.hoisted(() => ({
  execute: vi.fn(),
}));
const pluginChange = vi.hoisted(() => ({
  request: vi.fn(),
  decide: vi.fn(),
  ensure: vi.fn(async () => undefined),
}));

vi.mock('@/plugins/settings/administration', () => ({
  executePluginSettingsAdministrationAction: settingsAdministration.execute,
}));
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginChange: pluginChange.request,
  decideDaemonPluginChange: pluginChange.decide,
}));
vi.mock('@/daemon/ensureDaemon', () => ({
  ensureDaemonRunningForSessionCommand: pluginChange.ensure,
}));

import { createCliActionDeps } from './createCliActionDeps';

describe('createCliActionDeps plugin caller forwarding', () => {
  beforeEach(() => {
    settingsAdministration.execute.mockReset();
    pluginChange.request.mockReset();
    pluginChange.decide.mockReset();
    pluginChange.ensure.mockClear();
  });

  it.each([
    { surface: 'agent', actionCaller: { kind: 'host' } },
    { surface: 'cli', actionCaller: { kind: 'host' } },
    { surface: 'plugin', actionCaller: { kind: 'plugin', pluginId: 'acme.author', contributionLocalId: 'surface' } },
  ] as const)('requires ordinary Ask before an independent $surface install can prepare or decide a candidate', async requester => {
    const executor = createActionExecutor(createCliActionDeps({ token: 'token', sessionId: 'cli-global', mode: 'plain', ctx: null }));
    const input = { kind: 'archive', path: '/tmp/independent-plugin.tgz' };
    const context = { ...requester, authority: 'account_automation' as const,
      serverId: 'home', runtimeAccountId: 'account', actionRequestId: `independent-${requester.surface}`,
      interactivePresentation: 'unavailable' as const };

    await expect(executor.execute('plugins.install', input, context)).resolves.toMatchObject({
      ok: false, errorCode: 'action_interactive_review_required',
    });
    await expect(executor.prepare('plugins.install', input, context)).resolves.toMatchObject({
      kind: 'settled', result: { ok: false, errorCode: 'action_interactive_review_required' },
    });
    expect(pluginChange.request).not.toHaveBeenCalled();
    expect(pluginChange.decide).not.toHaveBeenCalled();

  });

  it('does not stage an orphan daemon candidate when preparing an install for review', async () => {
    const input = { kind: 'archive', path: '/tmp/review-only-plugin.tgz' };
    pluginChange.request.mockResolvedValue({ kind: 'reviewRequired', reviewKind: 'installation',
      pendingChangeId: 'review-only-orphan', reason: 'firstInstall', currentVersion: null,
      authorityExpansion: [], review: createPluginInstallationReviewFixture({
        source: { kind: 'archive', locator: input.path, integrity: 'sha512-exact', integrityBasis: 'observed' },
        updateChannel: { kind: 'archive', locator: input.path },
      }) });
    const executor = createActionExecutor(createCliActionDeps({ token: 'token', sessionId: 'cli-global', mode: 'plain', ctx: null }));
    const review = await executor.prepare('plugins.install', input, {
      surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', runtimeAccountId: 'account', actionRequestId: 'review-only-install',
    }, { reviewOnly: true });
    expect(review).toMatchObject({ kind: 'ready', operation: { actionId: 'plugins.install', normalizedInput: input } });
    expect(pluginChange.request).not.toHaveBeenCalled();
    expect(pluginChange.decide).not.toHaveBeenCalled();
    if (review.kind !== 'ready') throw new Error('Expected generic operation review');
    // Running still asks through the ordinary owner; this host has no Artifact credentials.
    await expect(review.invocation.run()).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(pluginChange.request).not.toHaveBeenCalled();
    expect(pluginChange.decide).not.toHaveBeenCalled();
  });

  it('composes a daemon-evaluated plugin review into the approval Artifact preview', async () => {
    const review = createPluginInstallationReviewFixture({
      pluginId: 'acme.archive',
      displayName: 'Acme Archive',
      source: { kind: 'archive', locator: '/tmp/acme-archive.tgz', integrity: 'sha512-exact', integrityBasis: 'observed' },
      updateChannel: { kind: 'archive', locator: '/tmp/acme-archive.tgz' },
      requiredHostAccess: [{
        id: 'network', capability: 'network', reason: 'Call the service.',
        authorizationClass: 'cooperativeDisclosure',
        normalizedScope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] },
      }],
    });
    pluginChange.request.mockResolvedValue({
      kind: 'reviewRequired',
      reviewKind: 'installation',
      pendingChangeId: 'pending-archive-review',
      reason: 'firstInstall',
      currentVersion: null,
      authorityExpansion: [],
      review,
    });
    const credentials = {
      token: 'header.eyJzdWIiOiJhY2NvdW50In0.signature',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });

    const preview = await deps.buildApprovalPreview?.({
      actionId: 'plugins.install',
      input: { path: '/tmp/acme-archive.tgz', kind: 'archive' },
      context: { surface: 'agent', actionCaller: { kind: 'host' } },
      defaultPreview: {
        actionId: 'plugins.install',
        actionArgs: { path: '/tmp/acme-archive.tgz', kind: 'archive' },
        summary: 'Install plugin',
      },
    });
    expect(preview).toMatchObject({
      pluginInstall: {
        permissionsDisclosure: 'daemonEvaluated',
        pendingReview: {
          pendingChangeId: 'pending-archive-review',
          review: { pluginId: 'acme.archive', requiredHostAccess: review.requiredHostAccess },
        },
      },
    });
    const request = ApprovalRequestV2Schema.parse({
      v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' },
      actionId: 'plugins.install', actionArgs: { path: '/tmp/acme-archive.tgz', kind: 'archive' },
      summary: 'Install plugin', preview,
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' },
        requestId: 'review-projection', surface: 'agent', serverId: 'home', actionId: 'plugins.install' },
    });
    const admission = resolveApprovalRequestApproveAdmission(JSON.parse(JSON.stringify(request)));
    expect(admission.status).toBe('available');
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({
      path: 'preview.pluginInstall.pendingReview',
      entries: expect.arrayContaining([expect.objectContaining({ label: 'Display name', value: 'Acme Archive' })]),
    }));
    expect(pluginChange.request).toHaveBeenCalledWith({
      kind: 'installArchive',
      locator: '/tmp/acme-archive.tgz',
    });
    expect(pluginChange.decide).not.toHaveBeenCalled();
  });

  it('does not resolve the Session workspace while preparing a development install review', async () => {
    const review = createPluginInstallationReviewFixture({
      source: { kind: 'path', locator: '/tmp/acme-dev' },
      updateChannel: { kind: 'path', locator: '/tmp/acme-dev', development: true },
    });
    pluginChange.request.mockResolvedValue({
      kind: 'reviewRequired',
      reviewKind: 'installation',
      pendingChangeId: 'pending-development-review',
      reason: 'firstInstall',
      currentVersion: null,
      authorityExpansion: [],
      review,
    });
    let pathReads = 0;
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'plugin-session',
      mode: 'plain',
      ctx: null,
      rawSession: {
        get path() {
          pathReads += 1;
          return '/workspace';
        },
      },
    });

    await expect(deps.buildApprovalPreview?.({
      actionId: 'plugins.install',
      input: { path: '/tmp/acme-dev', dev: true },
      context: { surface: 'agent', actionCaller: { kind: 'host' } },
      defaultPreview: { actionId: 'plugins.install', actionArgs: { path: '/tmp/acme-dev', dev: true }, summary: 'Install plugin' },
    })).resolves.toMatchObject({
      pluginInstall: {
        permissionsDisclosure: 'daemonEvaluated',
        pendingReview: { pendingChangeId: 'pending-development-review' },
      },
    });
    expect(pathReads).toBe(0);
  });

  it('returns the daemon preparation failure instead of a source-only approval preview', async () => {
    pluginChange.request.mockResolvedValue({ kind: 'failed', code: 'registry_unavailable', message: 'Registry is unavailable' });
    const deps = createCliActionDeps({ token: 'token', sessionId: 'cli-global', mode: 'plain', ctx: null });
    await expect(deps.buildApprovalPreview?.({ actionId: 'plugins.install', input: { kind: 'npm', path: '@acme/external' },
      context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } },
      defaultPreview: { actionId: 'plugins.install', actionArgs: { kind: 'npm', path: '@acme/external' }, summary: 'Install plugin' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'registry_unavailable', error: 'Registry is unavailable' });
    expect(pluginChange.decide).not.toHaveBeenCalled();
  });

  it.each(['npm', 'archive'] as const)('prepares and executes a remote %s install without reading a Session workspace', async kind => {
    let workspaceReads = 0;
    const deps = createCliActionDeps({
      token: 'token', sessionId: 'cli-global', mode: 'plain', ctx: null,
      rawSession: { get path() { workspaceReads += 1; return '/unrelated-session'; } },
    });
    const input = { kind, path: kind === 'npm' ? '@acme/plugin' : '/tmp/acme-plugin.tgz', dryRun: true };
    const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    await expect(deps.buildApprovalPreview?.({ actionId: 'plugins.install', input, context,
      defaultPreview: { actionId: 'plugins.install', actionArgs: input, summary: 'Install plugin' },
    })).resolves.toMatchObject({ pluginInstall: { ok: true, source: { kind } } });
    await expect(deps.pluginsDevLoopAction?.({ actionId: 'plugins.install', input, context }))
      .resolves.toMatchObject({ ok: true, kind: 'plugins_install', dryRun: true });
    expect(workspaceReads).toBe(0);
  });

  it('prepares an installed review independently of Session workspace metadata', async () => {
    const kind = 'installed';
    const review = createPluginInstallationReviewFixture();
    pluginChange.request.mockResolvedValue({ kind: 'reviewRequired', reviewKind: 'installation',
      pendingChangeId: 'remote-review', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], review });
    let workspaceReads = 0;
    const deps = createCliActionDeps({ token: 'token', sessionId: 'cli-global', mode: 'plain', ctx: null,
      rawSession: { get path() { workspaceReads += 1; return '/unrelated-session'; } },
    });
    await expect(deps.buildApprovalPreview?.({ actionId: 'plugins.install', input: { source: { kind, pluginId: review.pluginId } },
      context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } },
      defaultPreview: { actionId: 'plugins.install', actionArgs: { source: { kind, pluginId: review.pluginId } }, summary: 'Install plugin' },
    })).resolves.toMatchObject({ pluginInstall: { source: { kind } } });
    expect(workspaceReads).toBe(0);
  });

  it('preserves the canonical host-stamped caller for Settings administration', async () => {
    settingsAdministration.execute.mockResolvedValue({
      ok: true,
      kind: 'plugins.settings.list',
      data: {
        scope: { kind: 'account' },
        target: { kind: 'account' },
        revision: '1',
        fields: [],
      },
    });
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const caller = {
      kind: 'plugin' as const,
      pluginId: 'acme.author',
      contributionLocalId: 'settings-surface',
    };
    const signal = new AbortController().signal;
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });
    const settingsAction = deps.pluginSettingsAdministrationAction;
    expect(settingsAction).toBeDefined();

    await expect(settingsAction!({
      actionId: 'plugins.settings.list',
      input: {
        pluginId: 'acme.settings',
        scope: { kind: 'account' },
        target: { kind: 'account' },
      },
      context: {
        surface: 'cli',
        actionCaller: caller,
        signal,
      },
    })).resolves.toMatchObject({ ok: true, kind: 'plugins.settings.list' });

    expect(settingsAdministration.execute).toHaveBeenCalledWith(expect.objectContaining({
      actionCaller: caller,
      signal,
    }));
  });
});
