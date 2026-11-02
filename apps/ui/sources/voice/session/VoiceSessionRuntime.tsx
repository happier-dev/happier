import * as React from 'react';
import { getSharedVoiceAudioSessionCoordinator } from '@happier-dev/audio-stream-native';

import { storage, useActiveServerAccountScope, useProfile, useSetting } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { createBuiltinVoiceAdapterAssembly } from '@/voice/adapters/registerBuiltinVoiceAdapters';
import { resolveVoiceProviderIdForBindingScope } from '@/voice/settings/resolveVoiceProviderId';
import {
  createConnectedAccountTargetAuthorityFingerprint,
  createConnectedServiceBindingAuthorityFingerprint,
} from '@/sync/domains/connectedServices/connectedServiceBindingAuthority';
import { readVoiceProviderConnectedServicesBinding } from '@/voice/settings/passiveSetup';

import { createVoiceSessionLifecycleController } from './voiceSessionLifecycleController';
import {
  getVoiceSessionLifecycleController,
  setVoiceSessionLifecycleController,
} from './voiceSessionLifecycleControllerStore';
import {
  registerVoiceAdapters,
  resolveVoiceAdapterSurfaceCapabilities,
} from './voiceAdapterRegistry';
import { recordVoiceSessionArrival, setVoiceSessionSnapshot, useVoiceSessionStore } from './voiceSessionStore';
import { resolveAgentConnectedServicesDefaultBindings } from '@/sync/domains/connectedServices/resolveAgentConnectedServicesDefaultBindings';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/resolveBundledAgentIdFromContributionIdentity';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { useDaemonMergedProjectionSummary } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { createNativeAudioSessionLifecycleBridge } from '@/voice/runtime/nativeAudioSessionLifecycleBridge';
import { useVoiceDiagnosticsRuntimeSync } from '@/voice/diagnostics/useVoiceDiagnosticsRuntimeSync';
import {
  createVoiceCredentialRuntimeAuthoritySnapshot,
  createVoiceSelectedCredentialAuthorityFingerprint,
  hasVoiceCredentialRuntimeAuthorityChanged,
  readVoiceCredentialAuthorityRefs,
  type VoiceCredentialRuntimeAuthoritySnapshot,
} from './voiceCredentialAuthorityRefs';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useVoiceProviderRegistryRevision } from '@/voice/registry/useVoiceProviderRegistryRevision';
import { useCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { useForegroundVoiceTextTurnQaBridge } from '@/dev/testkit/harness/useForegroundVoiceTextTurnQaBridge';
import { resolveAccountVoiceCredentialSourceSelection } from '@/voice/credentials/accountVoiceCredential';
import { useVoiceExecutionMachineId } from '@/voice/credentials/useExecutionMachinePresentation';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { createVoiceContinuationProjection, readVoiceContinuationArrival } from '@/voice/transcript/voiceContinuationProjection';
import { appendVoiceConversationNoteText } from '@/voice/transcript/voiceConversationTranscript';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { getDeviceAnalyticsId } from '@/track/settingsAnalytics/deviceAnalyticsIdentity';
import { fireAndForget } from '@/utils/system/fireAndForget';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { resolveLocalDeviceLabel } from '@/utils/platform/resolveLocalDeviceLabel';
import { readVoiceConversationScopeMetadata } from '@/voice/persistence/voiceConversationScopeMetadata';
import { VoiceSetupFirstSuccessRuntime } from '@/voice/settings/setup/VoiceSetupFirstSuccessRuntime';
import { useVoiceProviderRuntimeDemand } from './useVoiceProviderRuntimeDemand';
import { useAppShellPluginUiDeclarationSources } from '@/components/appShell/plugins/AppShellPluginUiProjection';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

export function VoiceSessionRuntime(): React.ReactElement | null {
  const currentUiContext = useCurrentUiContextVoiceToolPort();
  useForegroundVoiceTextTurnQaBridge();
  const voice = useSetting('voice') as any;
  const canonicalVoiceSettings = useSetting('voiceSettingsV1');
  const providerRuntimeDemand = useVoiceProviderRuntimeDemand();
  const declarationSources = useAppShellPluginUiDeclarationSources();
  const savedSecretCatalog = useSavedSecretCatalog();
  const secrets = [...savedSecretCatalog.usableSecrets];
  const profile = useProfile(profile => ({
    connectedServicesV2: profile.connectedServicesV2,
    connectedServiceCredentialRevisionsV1: profile.connectedServiceCredentialRevisionsV1,
    connectedAccountsV4: profile.connectedAccountsV4,
    connectedAccountGroupsV4: profile.connectedAccountGroupsV4,
  }));
  const executionMachineId = useVoiceExecutionMachineId();
  const accountScope = useActiveServerAccountScope();
  const settingsScope = useAccountSettingsScope();
  const purposes = useConnectedAccountCatalog('purposes', settingsScope);
  const connectedPurposes = areAccountSettingsScopesEqual(settingsScope, accountScope)
    && purposes.status === 'ready' && !purposes.stale ? purposes.value : null;
  const connectedServices = profile?.connectedServicesV2 ?? null;
  const connectedServiceCredentialRevisions = profile?.connectedServiceCredentialRevisionsV1 ?? null;
  const currentUiContextToolSetEnabled = React.useMemo(
    () => readVoicePrivacySettings({ voice }).currentUiContextMode !== 'off',
    [voice],
  );
  useVoiceDiagnosticsRuntimeSync(voice);
  /*
   * Plugin activation registers external providers after this runtime's first render, so a
   * persisted external selection resolves to `null` on a cold boot. Without observing the
   * registry's own revision that first answer would stand forever and the selected provider
   * would never become runnable — Start would stay a no-op with nothing to explain it.
   */
  useVoiceProviderRegistryRevision(voiceProviderRegistry);
  const providerId = resolveVoiceProviderIdForBindingScope(
    canonicalVoiceSettings,
    'session',
  );
  const selectedProviderEntry = providerId ? voiceProviderRegistry.get(providerId) : null;
  const credentialSlotId = selectedProviderEntry?.kind === 'voice.conversation-provider.v1'
    ? selectedProviderEntry.declaration?.credentials?.slot.id ?? null
    : null;
  const selectedCapabilities = providerId === null ? null : resolveVoiceAdapterSurfaceCapabilities(providerId, voice);
  const exactSessionCredentialAuthority = selectedCapabilities?.agentRuntime !== undefined;
  const voiceCredentialAuthority = readVoiceCredentialAuthorityRefs(
    canonicalVoiceSettings,
    providerId,
    credentialSlotId,
  );
  const admittedRecoveryTarget = useVoiceSessionStore(state => state.recoveryTarget);
  // Built-in standalone Agent Voice consumes Account Agent defaults, rather
  // than a provider credential slot. Keep the failed attempt's Agent selected.
  const fixedAgentRuntime = selectedProviderEntry?.source.kind === 'built_in'
    ? admittedRecoveryTarget?.agentRuntime ?? null
    : null;
  const agentDefaultKey = fixedAgentRuntime ? buildQualifiedPluginContributionKey(fixedAgentRuntime) : null;
  const agentProjection = useDaemonMergedProjectionSummary({
    machineId: fixedAgentRuntime ? admittedRecoveryTarget?.machineId : null,
    serverId: admittedRecoveryTarget?.serverId ?? accountScope?.serverId,
  });
  const agentDefaultAuthority = React.useMemo(() => {
    if (!fixedAgentRuntime || !connectedPurposes) return null;
    const agentId = resolveBundledAgentIdFromContributionIdentity(fixedAgentRuntime)
      ?? buildQualifiedPluginContributionKey(fixedAgentRuntime);
    const agent = resolveAgentCatalogProjection(agentId, { enabledAgentIds: [],
      mergedProviderProjectionById: agentProjection.inputs?.mergedProviderProjectionById,
      mergedBackendProjectionById: agentProjection.inputs?.mergedBackendProjectionById });
    if (agent.identity?.pluginId !== fixedAgentRuntime.pluginId || agent.identity.localId !== fixedAgentRuntime.localId) return null;
    return stableJsonStringify({ agent: fixedAgentRuntime,
      bindings: resolveAgentConnectedServicesDefaultBindings({
        // The admitted purpose row is authoritative; no legacy preference fallback.
        settings: {}, purposeBindings: connectedPurposes, agentId,
        consumer: agent.identity, declarations: agent.connectedAccounts,
      }),
    });
  }, [fixedAgentRuntime?.pluginId, fixedAgentRuntime?.localId, connectedPurposes, agentProjection.inputs]);
  const selectedCredentialAuthority = (() => {
    if (selectedProviderEntry?.kind !== 'voice.conversation-provider.v1') return 'unbound';
    const declaration = selectedProviderEntry.declaration;
    const credentials = declaration?.credentials;
    if (!selectedProviderEntry || !declaration || !credentials) return 'unbound';
    const contribution = {
      pluginId: selectedProviderEntry.pluginId,
      localId: declaration.id,
    };
    try {
      const sourceResolution = resolveAccountVoiceCredentialSourceSelection({
        settings: {
          voiceSettingsV1: canonicalVoiceSettings,
          secrets,
        },
        connectedPurposes,
        contribution,
        credentialSlotId: credentials.slot.id,
        purpose: {
          consumer: contribution,
          purpose: credentials.slot.purpose,
        },
        machineId: executionMachineId,
      });
      const selectedSavedSecret = sourceResolution.savedSecret === null
        ? null
        : secrets.find((candidate) => candidate.id === sourceResolution.savedSecret?.secretId)
          ?? null;
      return createVoiceSelectedCredentialAuthorityFingerprint({
        sourceResolution,
        selectedSavedSecret: selectedSavedSecret === null
          ? null
          : {
              id: selectedSavedSecret.id,
              kind: selectedSavedSecret.kind,
              updatedAt: selectedSavedSecret.updatedAt,
            },
        selectedConnectedAccountAuthority:
          createConnectedAccountTargetAuthorityFingerprint({
            target: sourceResolution.binding?.target ?? null,
            accounts: profile?.connectedAccountsV4 ?? [],
            groups: profile?.connectedAccountGroupsV4 ?? [],
          }),
      });
    } catch {
      return 'indeterminate';
    }
  })();
  const controllerRef = React.useRef<ReturnType<typeof createVoiceSessionLifecycleController> | null>(null);
  const assemblyRef = React.useRef<ReturnType<typeof createBuiltinVoiceAdapterAssembly> | null>(null);
  const accountLifetimeRetirementRef = React.useRef<Readonly<{ dispose(): void }> | null>(null);
  const accountScopeAtLastLayoutCommitRef = React.useRef<typeof accountScope | undefined>(undefined);
  const credentialAuthorityRef = React.useRef<(VoiceCredentialRuntimeAuthoritySnapshot & Readonly<{ agentDefaultKey: string | null }>) | null>(null);
  const currentUiContextToolSetEnabledRef = React.useRef(currentUiContextToolSetEnabled);
  const currentUiContextToolSetSyncRef = React.useRef<Readonly<{
    controller: ReturnType<typeof createVoiceSessionLifecycleController>;
    enabled: boolean;
  }> | null>(null);
  currentUiContextToolSetEnabledRef.current = currentUiContextToolSetEnabled;

  // Ensure adapters are registered before the user can interact with voice controls.
  React.useLayoutEffect(() => {
    const retiringController = getVoiceSessionLifecycleController();
    const retirement = new AbortController();
    const retiringAttempt = retiringController?.dispose(retirement.signal);
    const assembly = createBuiltinVoiceAdapterAssembly({
      ...(currentUiContext ? { currentUiContext } : {}),
    });
    assemblyRef.current = assembly;
    registerVoiceAdapters(assembly.adapters);
    const continuation = createVoiceContinuationProjection();
    const controller = createVoiceSessionLifecycleController({
      retiringAttempt,
      cancelRetiringAttempt: () => retirement.abort(),
      acquireConnectivityLease: () => sync.acquireUserRequestLease(),
      onSyncedConversationMessages: (address, messages) => {
        const observed = continuation.observe(address, messages);
        if (observed && controller.getSnapshot().sessionId === observed.controlSessionId && controller.getSnapshot().canStop) {
          fireAndForget(controller.stop(observed.controlSessionId, { kind: 'continued_elsewhere', continuation: observed.continuation }), { tag: 'VoiceSessionRuntime.continuedElsewhere' });
        }
      },
    });
    const audioSessionCoordinator = getSharedVoiceAudioSessionCoordinator();
    const nativeAudioLifecycleBridge = audioSessionCoordinator
      ? createNativeAudioSessionLifecycleBridge({ coordinator: audioSessionCoordinator, controller })
      : null;
    controllerRef.current = controller;
    let boundCarrierSessionId: string | null = null;
    const syncPublishedSnapshot = () => {
      const snapshot = controller.getSnapshot();
      // Persisted bindings describe other clients' control slots. Only a binding
      // admitted locally may label this attempt or produce its continuation note.
      const binding = snapshot.sessionId ? voiceConversationBindingResolver.resolveByControlSessionId({
        controlSessionId: snapshot.sessionId, adapterId: snapshot.adapterId,
      }) : null;
      boundCarrierSessionId = binding?.conversationSessionId ?? null;
      const session = binding ? storage.getState().sessions[binding.conversationSessionId] : null;
      const lifetime = captureActiveServerAccountScopeLifetime();
      const exactHome = binding && session?.serverId === binding.conversationSessionAddress.serverId
        && lifetime?.isCurrent() && lifetime.scope.serverId === binding.conversationSessionAddress.serverId;
      const targetSessionAddress = controller.getAttemptTargetSessionAddress();
      const exactTargetHome = targetSessionAddress && lifetime?.isCurrent()
        && lifetime.scope.serverId === targetSessionAddress.serverId;
      setVoiceSessionSnapshot(snapshot, binding, (exactHome || exactTargetHome) && lifetime ? {
        accountScope: lifetime.scope, targetSessionAddress,
        conversationScope: exactHome ? readVoiceConversationScopeMetadata(session?.metadata) : null,
      } : null);
      const note = continuation.update({ snapshot, binding, deviceId: snapshot.canStop && exactHome ? getDeviceAnalyticsId() : null,
        deviceDisplayName: resolveLocalDeviceLabel({ deviceName: Constants.deviceName, platform: Platform.OS }),
        sessionSeq: exactHome && typeof session?.seq === 'number' ? session.seq : null });
      if (note) {
        // Read before this device's own note lands: the conversation was last voiced elsewhere.
        if (snapshot.adapterId && snapshot.sessionId && readVoiceContinuationArrival(
          readStoredSessionMessagesForAddress(storage.getState(), note.continuation.conversation), note.continuation.conversation, note.continuation.deviceId,
        )) recordVoiceSessionArrival(snapshot.adapterId, snapshot.sessionId);
        void Promise.resolve(appendVoiceConversationNoteText({ conversationSessionId: note.continuation.conversation.sessionId,
          text: 'Voice continued.', ...note })).then(
          () => continuation.settle(note, true),
          () => continuation.settle(note, false),
        );
      }
    };
    const unsubscribe = controller.subscribe(syncPublishedSnapshot);
    const unsubscribeBinding = voiceSessionBindingStore.subscribe(syncPublishedSnapshot);
    // Equivalent binding refreshes are silent; scope and sequence are carrier
    // facts. Select only the fields this publication reads from that Session.
    const unsubscribeCarrier = storage.subscribe((state, previous) => {
      if (!boundCarrierSessionId) return;
      const session = state.sessions[boundCarrierSessionId];
      const previousSession = previous.sessions[boundCarrierSessionId];
      if (session?.metadata === previousSession?.metadata
        && session?.seq === previousSession?.seq
        && session?.serverId === previousSession?.serverId) return;
      syncPublishedSnapshot();
    });
    setVoiceSessionLifecycleController(controller);
    controller.setCurrentUiContextToolSetEnabled(currentUiContextToolSetEnabledRef.current);
    currentUiContextToolSetSyncRef.current = {
      controller,
      enabled: currentUiContextToolSetEnabledRef.current,
    };
    controller.setConfiguredProviderId(providerId);
    return () => {
      if (assemblyRef.current === assembly) assemblyRef.current = null;
      if (currentUiContextToolSetSyncRef.current?.controller === controller) {
        currentUiContextToolSetSyncRef.current = null;
      }
      unsubscribe();
      unsubscribeBinding();
      unsubscribeCarrier();
      nativeAudioLifecycleBridge?.dispose();
      const controllerDisposal = controller.dispose();
      void (async () => {
        await controllerDisposal;
        await assembly.dispose();
        if (getVoiceSessionLifecycleController() !== controller) {
          return;
        }
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
        setVoiceSessionLifecycleController(null);
        registerVoiceAdapters([]);
        setVoiceSessionSnapshot({
          adapterId: null,
          sessionId: null,
          status: 'disconnected',
          mode: 'idle',
          canStop: false,
        });
      })();
    };
  }, [currentUiContext]);

  React.useEffect(() => {
    // Account-scoped activation belongs to AppShell's executable owner. The
    // standalone source bridge waits for its existing declaration admission.
    if (!declarationSources.ready || declarationSources.accountLifetime) return;
    const assembly = assemblyRef.current;
    if (!assembly) return;
    for (const demandedProviderId of providerRuntimeDemand) {
      fireAndForget(assembly.activateProvider(demandedProviderId), { tag: 'VoiceSessionRuntime.activateProvider' });
    }
  }, [providerRuntimeDemand, currentUiContext, declarationSources.ready, declarationSources.accountLifetime]);

  React.useLayoutEffect(() => {
    const previousAccountScope = accountScopeAtLastLayoutCommitRef.current;
    accountScopeAtLastLayoutCommitRef.current = accountScope;
    // Capture before releasing Account A's listener: a direct Account A → B
    // capture retires A synchronously, and that exact live attempt must stop
    // before B can publish through the shared AppShell port.
    const lifetime = captureActiveServerAccountScopeLifetime();
    const previous = accountLifetimeRetirementRef.current;
    accountLifetimeRetirementRef.current = null;
    previous?.dispose();
    // A no-Account attempt has no lifetime callback to retire. Crossing into
    // an Account is still an exact session-scope boundary, so retire it during
    // this layout commit before the shared AppShell port exposes the new scope.
    if (previousAccountScope === null && accountScope !== null) {
      controllerRef.current?.rearmAfterCredentialAuthorityChange({
        exactSessionAccountScopeChanged: true,
      });
    }
    if (!lifetime) return;

    accountLifetimeRetirementRef.current = lifetime.onRetire(() => {
      controllerRef.current?.rearmAfterCredentialAuthorityChange({
        exactSessionAccountScopeChanged: true,
      });
    });
  }, [accountScope]);

  React.useLayoutEffect(() => () => {
    const registration = accountLifetimeRetirementRef.current;
    accountLifetimeRetirementRef.current = null;
    registration?.dispose();
  }, []);

  React.useEffect(() => {
    controllerRef.current?.setConfiguredProviderId(providerId);
  }, [providerId]);

  React.useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    const synced = currentUiContextToolSetSyncRef.current;
    if (synced?.controller === controller && synced.enabled === currentUiContextToolSetEnabled) return;
    controller.setCurrentUiContextToolSetEnabled(currentUiContextToolSetEnabled);
    currentUiContextToolSetSyncRef.current = {
      controller,
      enabled: currentUiContextToolSetEnabled,
    };
  }, [currentUiContextToolSetEnabled]);

  React.useEffect(() => {
    const previousAuthority = credentialAuthorityRef.current;
    const providerSettings = selectedProviderEntry?.providerSettings ?? null;
    const providerEnvelope = voiceCredentialAuthority.providerEnvelope;
    const agentConnectedServicesBinding = providerSettings
      && providerEnvelope
      && providerSettings.schemaVersion === providerEnvelope.schemaVersion
      ? readVoiceProviderConnectedServicesBinding({
          providerSettings,
          providerConfig: providerEnvelope.config,
        })
      : null;
    const nextAuthority = { ...createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope,
      agentConnectedServiceBindingAuthority:
        createConnectedServiceBindingAuthorityFingerprint({
          bindings: agentConnectedServicesBinding,
          connectedServices: connectedServices ?? [],
          credentialRevisions: connectedServiceCredentialRevisions ?? [],
        }),
      credentialBinding: voiceCredentialAuthority.credentialBinding,
      providerEnvelope: voiceCredentialAuthority.providerEnvelope,
      selectedCredentialAuthority,
      agentDefaultAuthority,
    }), agentDefaultKey };
    // A temporarily unavailable catalog is not a changed default. Retain only
    // the last proven authority for this exact Account and Agent.
    if (nextAuthority.agentDefaultAuthority === null && previousAuthority
      && previousAuthority.accountScopeAuthority === nextAuthority.accountScopeAuthority
      && previousAuthority.agentDefaultKey === agentDefaultKey) {
      nextAuthority.agentDefaultAuthority = previousAuthority.agentDefaultAuthority;
    }
    credentialAuthorityRef.current = nextAuthority;
    if (!previousAuthority) {
      return;
    }
    const credentialAuthorityChanged =
      previousAuthority.accountScopeAuthority === nextAuthority.accountScopeAuthority
      && hasVoiceCredentialRuntimeAuthorityChanged(previousAuthority, nextAuthority);
    if (credentialAuthorityChanged) {
      const globalBindingAuthorityChanged = exactSessionCredentialAuthority
        && previousAuthority.agentConnectedServiceBindingAuthority
          !== nextAuthority.agentConnectedServiceBindingAuthority;
      // Account scope transitions retire at the layout/lifetime boundary. This
      // passive credential path only rearms terminal auth for a later Start;
      // global binding changes remain specific to the global Agent attachment.
      controllerRef.current?.rearmAfterCredentialAuthorityChange({
        exactSessionAccountScopeChanged: false,
        globalBindingAuthorityChanged,
        providerCredentialAuthorityChanged: hasVoiceCredentialRuntimeAuthorityChanged(previousAuthority, {
          ...nextAuthority, agentDefaultAuthority: previousAuthority.agentDefaultAuthority,
        }),
        agentDefaultAuthorityChanged: previousAuthority.agentDefaultAuthority !== null
          && nextAuthority.agentDefaultAuthority !== null
          && previousAuthority.agentDefaultAuthority !== nextAuthority.agentDefaultAuthority,
      });
    }
  }, [
    accountScope,
    connectedServiceCredentialRevisions,
    connectedServices,
    exactSessionCredentialAuthority,
    selectedProviderEntry,
    voiceCredentialAuthority.credentialBinding,
    voiceCredentialAuthority.providerEnvelope,
    selectedCredentialAuthority,
    agentDefaultAuthority,
    agentDefaultKey,
  ]);

  return <VoiceSetupFirstSuccessRuntime />;
}
