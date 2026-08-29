import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertCurrentManagedStackSessionAgentIdentity,
  buildCurrentManagedStackSessionAgentInstallArgs,
  buildCurrentManagedStackSessionAgentSelectors,
  CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT,
  CURRENT_SOURCE_SESSION_AGENT_CONFIRMATION_TITLE,
  CURRENT_SOURCE_SESSION_AGENT_DISPLAY_TITLE,
  CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID,
  CURRENT_SOURCE_SESSION_AGENT_QUALIFIED_TARGET_ID,
  CURRENT_SOURCE_SESSION_AGENT_REASONING_TEXT,
  CURRENT_SOURCE_SESSION_AGENT_UPDATED_REASONING_TEXT,
  readCurrentManagedStackSessionAgentCatalogIdentity,
} from './currentManagedStackPluginUiQa';
import {
  buildComposerEnabledProbeScript,
  buildPresenceProbeScript,
  buildSetTextareaValueScript,
  buildTestIdentifierSelector,
  buildTextPresenceProbeScript,
  buildTextCountProbeScript,
} from '../../../../../apps/ui/scripts/qa/tauriSessionAgentMcpQa.mjs';
import {
  resolveDesktopSessionAgentExitCode,
} from './desktopSessionAgentCurrentSourceQa';
import type { CurrentManagedStackPluginUiContext } from './currentManagedStackPluginUiQa';

type DaemonPostJson = Parameters<typeof readCurrentManagedStackSessionAgentCatalogIdentity>[0]['postJson'];

function fakeContext(): CurrentManagedStackPluginUiContext {
  return {
    runtimeJsonPath: '/stack/runtime.json',
    stackDir: '/stack',
    stackName: 'qa-stack',
    cliHome: '/stack/cli',
    uiUrl: 'http://ui.localhost:8081',
    serverUrl: 'http://127.0.0.1:53288',
    account: {
      accountId: 'account-1',
      serverId: 'server-1',
      serverIdentityId: null,
      uiServerId: 'ui-server-1',
    },
    daemon: {
      pid: 1234,
      port: 45678,
      controlToken: 'control-token',
      statePath: '/stack/cli/servers/server-1/daemon.state.json',
      runtimeId: 'runtime-1',
      machineId: 'machine-1',
      runtimeEntrypoint: '/stack/runtime/daemon.mjs',
      distClosureFingerprint: 'fp-1',
    },
    runtime: {
      updatedAt: null,
      runtimeSnapshotId: 'snapshot-1',
      selectedSnapshotId: 'snapshot-1',
      pendingManualRestart: false,
      publicationComponents: { server: 'current', daemon: 'current' },
    },
    uiProducer: {
      mode: 'snapshot',
      stackName: 'qa-stack',
      runtimeJsonPath: '/stack/runtime.json',
      projectDir: null,
      pid: null,
      processInstanceFingerprint: null,
    },
    authStorage: {
      sessionStorage: { activeServerId: 'ui-server-1' },
      localStorage: { auth_credentials: '{}' },
    },
  };
}

function sessionAgentCatalogEntry(overrides: Readonly<{
  enabled?: boolean;
  desiredGeneration?: string | null;
  appliedGeneration?: string | null;
  activationState?: 'dormant' | 'active';
  omitAgentContribution?: boolean;
}> = {}): Record<string, unknown> {
  return {
    pluginId: CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID,
    desiredGeneration: overrides.desiredGeneration ?? 'gen-2',
    appliedGeneration: overrides.appliedGeneration ?? 'gen-2',
    enabled: overrides.enabled ?? true,
    contributionIntrospection: {
      version: 1,
      generation: 3,
      diagnostics: [],
      contributions: overrides.omitAgentContribution ? [] : [{
        version: 1,
        contribution: {
          pluginId: CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID,
          family: 'agents',
          qualifiedId: `${CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID}/agents/session-agent`,
          kind: 'localId',
          localId: 'session-agent',
        },
        progression: { declared: true, normalized: true, merged: false },
        registration: { requirement: 'required', state: 'bound', generation: 'gen-2' },
        activation: { state: overrides.activationState ?? 'active', generation: 'gen-2' },
        projection: { state: 'projected' },
        consumer: 'agent-session-runtime',
        platforms: ['cli', 'web', 'ios', 'android', 'desktop'],
        diagnostics: [],
      }],
    },
  };
}

function fakePostJson(params: Readonly<{
  catalogPlugins?: readonly unknown[];
  pendingChanges?: readonly unknown[];
}> = {}): DaemonPostJson {
  return async (request) => {
    if (request.path === '/plugins/catalog/read') {
      return {
        status: 200,
        data: { kind: 'available', plugins: [...(params.catalogPlugins ?? [])] },
      };
    }
    if (request.path === '/plugins/change/list') {
      return { status: 200, data: { changes: [...(params.pendingChanges ?? [])] } };
    }
    throw new Error(`unexpected daemon control path: ${request.path}`);
  };
}

describe('current-source Session Agent harness boundaries', () => {
  it('installs through the canonical headless public development command', () => {
    expect(buildCurrentManagedStackSessionAgentInstallArgs('/tmp/external-session-agent')).toEqual([
      'plugins',
      'install',
      '/tmp/external-session-agent',
      '--dev',
      '--trust',
      '--json',
    ]);
  });

  it('derives the exact qualified identity and stable client selectors from one owner', () => {
    expect(CURRENT_SOURCE_SESSION_AGENT_QUALIFIED_TARGET_ID)
      .toBe('agent:examples.session-agent/session-agent');
    expect(CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID).toBe('examples.session-agent');
    expect(CURRENT_SOURCE_SESSION_AGENT_DISPLAY_TITLE).toBe('Deterministic Session Agent');
    expect(CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT).toBe('Deterministic check approved.');
    expect(CURRENT_SOURCE_SESSION_AGENT_REASONING_TEXT).toBe('Preparing the deterministic check.');
    expect(CURRENT_SOURCE_SESSION_AGENT_UPDATED_REASONING_TEXT).toBe('Preparing the updated deterministic check.');
    expect(CURRENT_SOURCE_SESSION_AGENT_CONFIRMATION_TITLE).toBe('Run deterministic check?');

    const selectors = buildCurrentManagedStackSessionAgentSelectors();
    expect(selectors.wizardOption).toBe('new-session-agent:agent:examples.session-agent/session-agent');
    expect(selectors.chipPickerOption)
      .toBe('agent-input-chip-picker.option:agent:examples.session-agent/session-agent');
    expect(selectors.forgetTrustAction)
      .toBe('settings.plugins.detail.examples.session-agent.action.forgetTrust');
    expect(selectors.permissionAllow).toBe('permission-footer.allow');
    expect(selectors.abort).toBe('agent-input-abort');
    expect(selectors.newSessionComposerInput).toBe('new-session-composer-input');
    expect(selectors.newSessionComposerSend).toBe('new-session-composer-send');
  });

  it('projects the exact Agent identity from the daemon catalog seam', async () => {
    const identity = await readCurrentManagedStackSessionAgentCatalogIdentity({
      context: fakeContext(),
      postJson: fakePostJson({ catalogPlugins: [sessionAgentCatalogEntry()] }),
    });
    expect(identity).toEqual({
      pluginId: 'examples.session-agent',
      enabled: true,
      desiredGeneration: 'gen-2',
      appliedGeneration: 'gen-2',
      agentContribution: {
        family: 'agents',
        localId: 'session-agent',
        activationState: 'active',
        activationGeneration: 'gen-2',
        registrationRequirement: 'required',
        registrationState: 'bound',
        registrationGeneration: 'gen-2',
      },
    });
  });

  it('rejects a present plugin whose Agent contribution identity is missing or duplicated', async () => {
    await expect(readCurrentManagedStackSessionAgentCatalogIdentity({
      context: fakeContext(),
      postJson: fakePostJson({
        catalogPlugins: [sessionAgentCatalogEntry({ omitAgentContribution: true })],
      }),
    })).rejects.toThrow('plugin_ui_current_stack_session_agent_contribution_identity_ambiguous:examples.session-agent:0');
  });

  it('returns no identity for a retired plugin and asserts absence through the canonical owner', async () => {
    await expect(readCurrentManagedStackSessionAgentCatalogIdentity({
      context: fakeContext(),
      postJson: fakePostJson({ catalogPlugins: [] }),
    })).resolves.toBeNull();

    await expect(assertCurrentManagedStackSessionAgentIdentity({
      context: fakeContext(),
      phase: 'absent',
      postJson: fakePostJson({ catalogPlugins: [], pendingChanges: [] }),
    })).resolves.toBeNull();
  });

  it('credits the active phase only for an enabled, generation-current, bound Agent', async () => {
    await expect(assertCurrentManagedStackSessionAgentIdentity({
      context: fakeContext(),
      phase: 'active',
      postJson: fakePostJson({ catalogPlugins: [sessionAgentCatalogEntry()] }),
    })).resolves.toMatchObject({ agentContribution: { activationState: 'active' } });

    await expect(assertCurrentManagedStackSessionAgentIdentity({
      context: fakeContext(),
      phase: 'active',
      postJson: fakePostJson({
        catalogPlugins: [sessionAgentCatalogEntry({ enabled: false })],
      }),
    })).rejects.toThrow('plugin_ui_current_stack_session_agent_identity_disabled');

    await expect(assertCurrentManagedStackSessionAgentIdentity({
      context: fakeContext(),
      phase: 'active',
      postJson: fakePostJson({
        catalogPlugins: [sessionAgentCatalogEntry({ appliedGeneration: 'gen-1' })],
      }),
    })).rejects.toThrow('plugin_ui_current_stack_session_agent_generation_not_current:gen-2:gen-1');

    await expect(assertCurrentManagedStackSessionAgentIdentity({
      context: fakeContext(),
      phase: 'active',
      postJson: fakePostJson({
        catalogPlugins: [sessionAgentCatalogEntry({ activationState: 'dormant' })],
      }),
    })).rejects.toThrow('plugin_ui_current_stack_session_agent_contribution_not_active:dormant');
  });

  it('fails the present phase closed when the plugin is already retired', async () => {
    await expect(assertCurrentManagedStackSessionAgentIdentity({
      context: fakeContext(),
      phase: 'present',
      postJson: fakePostJson({ catalogPlugins: [] }),
    })).rejects.toThrow('plugin_ui_current_stack_session_agent_identity_absent:present');
  });

  it('classifies desktop targets truthfully: blocked or unasserted journeys never pass', () => {
    expect(resolveDesktopSessionAgentExitCode({
      journey: { kind: 'observed', artifactRoot: '/artifacts' },
      identityAsserted: true,
    })).toBe(0);
    expect(resolveDesktopSessionAgentExitCode({
      journey: {
        kind: 'blocked',
        code: 'desktop_session_agent_driver_unavailable',
        detail: 'no Tauri app found',
      },
      identityAsserted: true,
    })).toBe(2);
    expect(resolveDesktopSessionAgentExitCode({
      journey: { kind: 'observed', artifactRoot: '/artifacts' },
      identityAsserted: false,
    })).toBe(2);
  });

  it('keeps the mobile Session Agent flows candidate-free, split at create/send, and terminal on cancellation', () => {
    const sendFlow = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-session-agent-send.yaml', import.meta.url),
      'utf8',
    );
    const transcriptFlow = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-session-agent-transcript.yaml', import.meta.url),
      'utf8',
    );
    // Create/send half: shared composer entry, exact chip-picker selection,
    // prompt, and the send's own custody proof. It never asserts any
    // downstream confirmation/recovery fact, so the owning CLI can arm exact
    // cleanup at the landed create/send custody boundary.
    expect(sendFlow).toContain('file: ../_shared/gotoNewSessionComposer.yaml');
    expect(sendFlow).toContain('id: agent-input-agent-chip');
    expect(sendFlow).toContain('id: ${HAPPIER_E2E_SESSION_AGENT_CHIP_PICKER_OPTION_ID}');
    expect(sendFlow).toContain('id: new-session-composer-input');
    expect(sendFlow).toContain('id: new-session-composer-send');
    expect(sendFlow).toContain('notVisible');
    expect(sendFlow).not.toContain('permission-footer.allow');
    expect(sendFlow).not.toContain('HAPPIER_E2E_SESSION_AGENT_CANCEL_PROMPT');
    expect(sendFlow).not.toContain('HAPPIER_E2E_SESSION_AGENT_RECOVERY_PROMPT');
    // Downstream half: host confirmation, assistant settlement, a later
    // cancelled turn, and recovery on the same Session.
    expect(transcriptFlow).toContain('id: permission-footer.allow');
    expect(transcriptFlow).toContain('id: session-composer-input');
    expect(transcriptFlow).toContain('id: session-composer-send');
    expect(transcriptFlow).toContain('id: agent-input-abort');
    expect(transcriptFlow).toContain('visible: ${HAPPIER_E2E_SESSION_AGENT_ASSISTANT_TEXT}');
    expect(transcriptFlow).not.toContain('new-session-composer-send');
    expect(transcriptFlow).not.toContain('gotoNewSessionComposer');
    // Cancellation terminality is asserted on the device with the canonical
    // bounded notVisible wait, not assumed: one abort tap plus one bounded
    // wait for the abort affordance to disappear.
    const afterCancel = transcriptFlow.split('id: agent-input-abort')[1];
    expect(afterCancel).toContain('notVisible');
    expect(afterCancel).toContain('id: permission-footer.allow');
    expect(transcriptFlow.split('id: agent-input-abort')).toHaveLength(3);
    expect(`${sendFlow}\n${transcriptFlow}`).not.toMatch(/tarball|\.tgz/u);
  });

  it('detects confirmation settlement and cancellation terminality in the desktop probe scripts', () => {
    const selectors = buildCurrentManagedStackSessionAgentSelectors();
    const allowSelector = buildTestIdentifierSelector(selectors.permissionAllow);
    const composerSelector = buildTestIdentifierSelector(selectors.sessionComposerInput);
    const stubDocument = (params: Readonly<{
      bodyText?: string;
      node?: { getAttribute: (name: string) => string | null } | null;
    }> = {}) => ({
      body: { textContent: params.bodyText ?? '' },
      querySelector: () => params.node ?? null,
    });
    const runProbe = (script: string, document: unknown): { kind: string; disabled?: boolean; count?: number; selector?: string } => {
      const evaluate = new Function('document', `return (${script});`);
      return evaluate(document) as { kind: string; disabled?: boolean; count?: number; selector?: string };
    };

    expect(allowSelector).toBe('[data-testid="permission-footer.allow"]');
    // Confirmation settlement: the pending allow affordance must become
    // detectably absent.
    expect(runProbe(buildPresenceProbeScript({ selector: allowSelector }), stubDocument()))
      .toEqual({ kind: 'absent', selector: allowSelector });
    expect(runProbe(
      buildPresenceProbeScript({ selector: allowSelector }),
      stubDocument({ node: { getAttribute: () => null } }),
    )).toEqual({ kind: 'present', selector: allowSelector });

    // Cancellation terminality: the session composer must report enabled.
    expect(runProbe(buildComposerEnabledProbeScript({ selector: composerSelector }), stubDocument()))
      .toEqual({ kind: 'absent', selector: composerSelector });
    expect(runProbe(
      buildComposerEnabledProbeScript({ selector: composerSelector }),
      stubDocument({ node: { getAttribute: () => 'true' } }),
    )).toEqual({ kind: 'present', disabled: true });
    expect(runProbe(
      buildComposerEnabledProbeScript({ selector: composerSelector }),
      stubDocument({ node: { getAttribute: () => null } }),
    )).toEqual({ kind: 'present', disabled: false });

    // Assistant settlement: the deterministic message text must be detectable.
    expect(runProbe(
      buildTextPresenceProbeScript({ text: CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT }),
      stubDocument(),
    )).toEqual({ kind: 'absent' });
    expect(runProbe(
      buildTextPresenceProbeScript({ text: CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT }),
      stubDocument({ bodyText: `prefix ${CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT} suffix` }),
    )).toEqual({ kind: 'present' });

    const countDocument = {
      querySelectorAll: () => [
        { children: [], textContent: CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT },
        { children: [], textContent: `prefix ${CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT}` },
        { children: [{}], textContent: CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT },
      ],
    };
    expect(runProbe(buildTextCountProbeScript({ text: CURRENT_SOURCE_SESSION_AGENT_ASSISTANT_TEXT }), countDocument))
      .toEqual({ kind: 'counted', count: 2 });
  });

  it('embeds the exact composer value through the native value setter in the desktop input script', () => {
    const selectors = buildCurrentManagedStackSessionAgentSelectors();
    const script = buildSetTextareaValueScript({
      selector: buildTestIdentifierSelector(selectors.newSessionComposerInput),
      value: CURRENT_SOURCE_SESSION_AGENT_CONFIRMATION_TITLE,
    });
    expect(script).toContain('HTMLTextAreaElement.prototype');
    expect(script).toContain(JSON.stringify(CURRENT_SOURCE_SESSION_AGENT_CONFIRMATION_TITLE));
    expect(script).toContain('new Event(\'input\', { bubbles: true })');
  });
});
