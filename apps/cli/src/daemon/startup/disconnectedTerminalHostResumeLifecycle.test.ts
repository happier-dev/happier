import { describe, expect, it } from 'vitest';

import { createTerminalAttachmentId } from '@/terminal/attachment/terminalAttachmentInfo';
import { isFeatureId, PluginSettingsContributionV2Schema } from '@happier-dev/protocol';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { createStablePluginSettingsHost } from '@/plugins/runtime/invocation/services/settings';
import { createStablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import { createClaudeAgentRuntime } from '../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/claude/src/manifest';
import { resolveDisconnectedTerminalHostResumeGate } from '../sessions/disconnectedTerminalHostSupervision';
import { resolveDaemonSessionTerminalPresentation } from '../sessions/resolveTrackedSessionTerminalPresentation';

import { createDisconnectedTerminalHostResumeLifecycle } from './disconnectedTerminalHostResumeLifecycle';

describe('disconnected terminal-host resume lifecycle', () => {
  it.each(['herdr', 'tmux', 'zellij'] as const)(
    'keeps an admitted retained %s host out of replacement controller placement without changing fresh placement',
    async (hostKind) => {
      const runtime = await createClaudeAgentRuntime({
        plugin: { id: 'happier.agent.claude', version: '0.0.0' },
        agent: { id: 'claude' },
        signal: new AbortController().signal,
      });
      const resolvePresentation = runtime.sessions?.resolveTerminalPresentation;
      if (!resolvePresentation) throw new Error('The real Claude factory has no placement owner');
      const pluginId = 'happier.agent.claude';
      const signal = new AbortController().signal;
      const settings = createStablePluginSettingsHost({
        declarations: (PLUGIN_MANIFEST.contributes.settings ?? []).map(contribution => ({
          pluginId, contribution: PluginSettingsContributionV2Schema.parse(contribution),
        })),
        broker: createStablePluginEventsBroker(),
        recordStore: {
          supports: () => true,
          async read() { throw new Error('Captured runtime selection read Account settings'); },
          async update() { throw new Error('Placement selection wrote Account settings'); },
        },
      }).bind({
        plugin: { id: pluginId, version: '0.0.0' },
        contribution: { id: 'claude', qualifiedId: `${pluginId}/agents/claude` },
        occurrenceId: 'retained-placement', correlationId: 'retained-placement',
        surface: 'agent', signal, isOccurrenceCurrent: () => !signal.aborted,
      });
      if (!settings) throw new Error('The actual Claude settings declaration did not bind');
      const selection = {
        cwd: '/tmp/retained-continuation', requestedHost: hostKind,
        runtimeDescriptorV1: {
          v: 1 as const, agentId: 'claude',
          agent: { backendMode: 'unifiedTerminal', terminalHostKind: hostKind },
        },
        launchEnvironment: { values: {}, unset: [] },
      };
      const surfaces = {
        resolveTerminalPresentation: async (input: Parameters<typeof resolveDaemonSessionTerminalPresentation>[1]) => await resolvePresentation(input, {
          // Keep feature policy and factory selection real; the admitted descriptor
          // must not read today's Account setting during this continuation.
          features: { isEnabled: id => isFeatureId(id) && resolveCliFeatureDecision({
            featureId: id, env: { HAPPIER_FEATURE_AGENTS_CLAUDE_UNIFIED_TERMINAL__ENABLED: '1' },
          }).state === 'enabled' },
          settings,
        }),
      };
      const selected = await resolveDaemonSessionTerminalPresentation(surfaces, selection, 'retained-session');
      expect(selected.retainedTerminalRecovery).toBe('adopt');
      const attachmentId = createTerminalAttachmentId();
      const lifecycle = createDisconnectedTerminalHostResumeLifecycle({
        unresolvedTerminalHostSessionIds: new Set(),
        clearUnresolvedTerminalHostSession: () => {},
        findDisconnectedCandidate: sessionId => ({
          sessionId, pid: 7_010, happyHomeDir: '/tmp/happy', attachmentId,
          handle: { kind: hostKind, attachmentId, sessionName: 'retained', paneId: 'pane-1',
            ...(hostKind === 'herdr' ? { socketPath: '/tmp/retained.sock', terminalId: 'terminal-1' } : {}),
            attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', liveProbe: 'required' } },
          controlDescriptorAvailable: true,
        }),
        resolveResumeGateForCandidate: async candidate => resolveDisconnectedTerminalHostResumeGate({
          state: 'recoverable_unservable', reason: 'runner_absent',
        }, { controlDescriptorAvailable: candidate.controlDescriptorAvailable,
          retainedTerminalRecovery: selected.retainedTerminalRecovery }),
        retireCandidate: () => {},
      });
      const continuation = await lifecycle.resolveResumePreGate('retained-session');
      expect(continuation).toEqual({ type: 'resume', retainedTerminalRecovery: 'adopt' });
      const placement = await resolveDaemonSessionTerminalPresentation(surfaces, selection, 'retained-session',
        continuation?.type === 'resume' ? continuation.retainedTerminalRecovery : undefined);
      expect(placement).toMatchObject({ kind: 'managed_terminal', startingMode: 'remote' });
      expect(placement.runtimeDescriptorV1).toEqual(selected.runtimeDescriptorV1);
      const fresh = await resolveDaemonSessionTerminalPresentation(surfaces, selection);
      const committedFresh = await resolveDaemonSessionTerminalPresentation(surfaces, selection, 'committed-fresh-session');
      expect(fresh).toMatchObject({ kind: hostKind === 'herdr' ? 'runner' : 'managed_terminal', startingMode: 'terminal' });
      expect(committedFresh).toEqual(fresh);
      const sdkSelection = { ...selection, runtimeDescriptorV1: {
        ...selection.runtimeDescriptorV1, agent: { backendMode: 'agentSdk', terminalHostKind: hostKind },
      } };
      expect(await resolveDaemonSessionTerminalPresentation(surfaces, sdkSelection, 'sdk-session', 'adopt'))
        .toMatchObject({ kind: 'runner', startingMode: 'remote' });
    },
  );

  it('repairs unresolved legacy topology through the supplied canonical stop owner before Resume', async () => {
    const unresolved = new Set(['sess-unresolved']);
    const repairUnresolvedTopology = async () => ({ status: 'not_found' as const });
    const lifecycle = createDisconnectedTerminalHostResumeLifecycle({
      unresolvedTerminalHostSessionIds: unresolved,
      clearUnresolvedTerminalHostSession: (sessionId) => unresolved.delete(sessionId),
      findDisconnectedCandidate: () => null,
      resolveResumeGateForCandidate: async () => ({ action: 'resume' }),
      retireCandidate: () => {},
    });

    await expect(lifecycle.resolveResumePreGate(
      'sess-unresolved',
      repairUnresolvedTopology,
    )).resolves.toBeNull();
    expect(unresolved.has('sess-unresolved')).toBe(false);
  });

  it('keeps unresolved legacy topology fenced when the canonical stop owner cannot prove retirement', async () => {
    const unresolved = new Set(['sess-unresolved']);
    const lifecycle = createDisconnectedTerminalHostResumeLifecycle({
      unresolvedTerminalHostSessionIds: unresolved,
      clearUnresolvedTerminalHostSession: (sessionId) => unresolved.delete(sessionId),
      findDisconnectedCandidate: () => null,
      resolveResumeGateForCandidate: async () => ({ action: 'resume' }),
      retireCandidate: () => {},
    });

    await expect(lifecycle.resolveResumePreGate(
      'sess-unresolved',
      async () => ({ status: 'incomplete', reason: 'legacy_attachment' }),
    )).resolves.toMatchObject({
      type: 'error',
      errorMessage: expect.any(String),
    });
    expect(unresolved.has('sess-unresolved')).toBe(true);
  });

  it('waits for stop retirement before allowing a concurrent resume', async () => {
    const attachmentId = createTerminalAttachmentId();
    const candidates = [{
      sessionId: 'sess-stop-resume',
      pid: 7_001,
      happyHomeDir: '/tmp/happy',
      attachmentId,
      handle: {
        attachmentId,
        kind: 'tmux' as const,
        sessionName: 'happier-stop-resume',
        paneId: 'pane-1',
        attachMetadata: {
          attachStrategy: 'terminal_host' as const,
          topology: 'shared' as const,
          locality: 'same_machine' as const,
          liveProbe: 'required' as const,
        },
      },
      controlDescriptorAvailable: false,
    }];
    const retired = new Set<string>();
    let releaseStop!: () => void;
    const stopPending = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    const lifecycle = createDisconnectedTerminalHostResumeLifecycle({
      unresolvedTerminalHostSessionIds: new Set(),
      clearUnresolvedTerminalHostSession: () => {},
      findDisconnectedCandidate: (sessionId) =>
        candidates.find((candidate) =>
          candidate.sessionId === sessionId && !retired.has(candidate.attachmentId),
        ) ?? null,
      resolveResumeGateForCandidate: async () => ({ action: 'fence', reason: 'control_descriptor_missing' }),
      retireCandidate: ({ sessionId, attachmentId: retiredAttachmentId }) => {
        for (const candidate of candidates) {
          if (candidate.sessionId !== sessionId) continue;
          if (retiredAttachmentId && candidate.attachmentId !== retiredAttachmentId) continue;
          retired.add(candidate.attachmentId);
        }
      },
    });

    let resumeSettled = false;
    const stopPromise = lifecycle.runStop('sess-stop-resume', async () => {
      await stopPending;
      return {
        stopResult: { status: 'stopped' as const },
        retireCandidate: { sessionId: 'sess-stop-resume', attachmentId },
      };
    });
    const resumePromise = lifecycle.resolveResumePreGate('sess-stop-resume').finally(() => {
      resumeSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resumeSettled).toBe(false);

    releaseStop();
    await expect(stopPromise).resolves.toEqual({ status: 'stopped' });
    await expect(resumePromise).resolves.toBeNull();
  });

  it('retires the exact cached candidate after physical destruction even when serviceability retirement is incomplete', async () => {
    const attachmentId = createTerminalAttachmentId();
    let retired = false;
    const lifecycle = createDisconnectedTerminalHostResumeLifecycle({
      unresolvedTerminalHostSessionIds: new Set(),
      clearUnresolvedTerminalHostSession: () => {},
      findDisconnectedCandidate: () => retired ? null : {
        sessionId: 'sess-retirement-incomplete',
        pid: 7_002,
        happyHomeDir: '/tmp/happy',
        attachmentId,
        handle: {
          attachmentId,
          kind: 'tmux',
          sessionName: 'happier-retirement-incomplete',
          paneId: 'pane-2',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
      },
      resolveResumeGateForCandidate: async () => ({ action: 'fence', reason: 'control_descriptor_missing' }),
      retireCandidate: () => {
        retired = true;
      },
    });

    await expect(lifecycle.runStop('sess-retirement-incomplete', async () => ({
      stopResult: {
        status: 'incomplete',
        reason: 'terminal_control_serviceability_retirement_failed',
      },
      retireCandidate: { sessionId: 'sess-retirement-incomplete', attachmentId },
    }))).resolves.toEqual({
      status: 'incomplete',
      reason: 'terminal_control_serviceability_retirement_failed',
    });
    expect(retired).toBe(true);
    await expect(lifecycle.resolveResumePreGate('sess-retirement-incomplete')).resolves.toBeNull();
  });

  it('keeps stop and resume serialized until asynchronous candidate evidence cleanup finishes', async () => {
    const attachmentId = createTerminalAttachmentId();
    let releaseRetirement!: () => void;
    const retirementPending = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    let retirementFinished = false;
    const lifecycle = createDisconnectedTerminalHostResumeLifecycle({
      unresolvedTerminalHostSessionIds: new Set(),
      clearUnresolvedTerminalHostSession: () => {},
      findDisconnectedCandidate: () => null,
      resolveResumeGateForCandidate: async () => ({ action: 'resume' }),
      retireCandidate: async () => {
        await retirementPending;
        retirementFinished = true;
      },
    });

    let stopSettled = false;
    const stop = lifecycle.runStop('sess-async-retirement', async () => ({
      stopResult: { status: 'stopped' as const },
      retireCandidate: {
        sessionId: 'sess-async-retirement',
        attachmentId,
      },
    })).finally(() => {
      stopSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopSettled).toBe(false);
    expect(retirementFinished).toBe(false);
    releaseRetirement();
    await expect(stop).resolves.toEqual({ status: 'stopped' });
    expect(retirementFinished).toBe(true);
  });
});
