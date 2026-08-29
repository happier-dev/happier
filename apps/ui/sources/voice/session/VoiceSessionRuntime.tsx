import * as React from 'react';
import { getSharedVoiceAudioSessionCoordinator } from '@happier-dev/audio-stream-native';

import { storage, useActiveServerAccountScope, useProfile, useSetting } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { createBuiltinVoiceAdapterAssembly } from '@/voice/adapters/registerBuiltinVoiceAdapters';
import { resolveVoiceProviderIdForBindingScope } from '@/voice/settings/resolveVoiceProviderId';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createConnectedServiceBindingAuthorityFingerprint } from '@/sync/domains/connectedServices/connectedServiceBindingAuthority';
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
import { setVoiceSessionSnapshot } from './voiceSessionStore';
import { createNativeAudioSessionLifecycleBridge } from '@/voice/runtime/nativeAudioSessionLifecycleBridge';
import { useVoiceDiagnosticsRuntimeSync } from '@/voice/diagnostics/useVoiceDiagnosticsRuntimeSync';
import {
  createVoiceCredentialRuntimeAuthoritySnapshot,
  hasVoiceCredentialRuntimeAuthorityChanged,
  readVoiceCredentialAuthorityRefs,
  type VoiceCredentialRuntimeAuthoritySnapshot,
} from './voiceCredentialAuthorityRefs';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useVoiceProviderRegistryRevision } from '@/voice/registry/useVoiceProviderRegistryRevision';
import { useCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { useForegroundVoiceTextTurnQaBridge } from '@/dev/testkit/harness/useForegroundVoiceTextTurnQaBridge';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

export function VoiceSessionRuntime(): React.ReactElement | null {
  const currentUiContext = useCurrentUiContextVoiceToolPort();
  useForegroundVoiceTextTurnQaBridge();
  const voice = useSetting('voice') as any;
  const canonicalVoice = useSetting('voiceSettingsV1');
  const secrets = useSetting('secrets');
  const profile = useProfile();
  const accountScope = useActiveServerAccountScope();
  const connectedServices = profile?.connectedServicesV2 ?? null;
  const connectedServiceCredentialRevisions = profile?.connectedServiceCredentialRevisionsV1 ?? null;
  const currentUiContextToolSetEnabled = storage(
    (state) => readVoicePrivacySettings(state.settings).currentUiContextMode !== 'off',
  );
  useVoiceDiagnosticsRuntimeSync(voice);
  const canonicalVoiceSettings = voiceSettingsParse(canonicalVoice);
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
  const exactSessionCredentialAuthority = providerId !== null
    && resolveVoiceAdapterSurfaceCapabilities(providerId, voice)?.agentRuntime !== undefined;
  const voiceCredentialAuthority = readVoiceCredentialAuthorityRefs(
    canonicalVoice,
    providerId,
    credentialSlotId,
  );
  const controllerRef = React.useRef<ReturnType<typeof createVoiceSessionLifecycleController> | null>(null);
  const accountLifetimeRetirementRef = React.useRef<Readonly<{ dispose(): void }> | null>(null);
  const accountScopeAtLastLayoutCommitRef = React.useRef<typeof accountScope | undefined>(undefined);
  const credentialAuthorityRef = React.useRef<VoiceCredentialRuntimeAuthoritySnapshot | null>(null);
  const currentUiContextToolSetEnabledRef = React.useRef(currentUiContextToolSetEnabled);
  const currentUiContextToolSetSyncRef = React.useRef<Readonly<{
    controller: ReturnType<typeof createVoiceSessionLifecycleController>;
    enabled: boolean;
  }> | null>(null);
  currentUiContextToolSetEnabledRef.current = currentUiContextToolSetEnabled;

  // Ensure adapters are registered before the user can interact with voice controls.
  React.useLayoutEffect(() => {
    const assembly = createBuiltinVoiceAdapterAssembly({
      ...(currentUiContext ? { currentUiContext } : {}),
    });
    registerVoiceAdapters(assembly.adapters);
    const controller = createVoiceSessionLifecycleController();
    const audioSessionCoordinator = getSharedVoiceAudioSessionCoordinator();
    const nativeAudioLifecycleBridge = audioSessionCoordinator
      ? createNativeAudioSessionLifecycleBridge({ coordinator: audioSessionCoordinator, controller })
      : null;
    controllerRef.current = controller;
    const syncPublishedSnapshot = () => {
      setVoiceSessionSnapshot(controller.getSnapshot());
    };
    const unsubscribe = controller.subscribe(syncPublishedSnapshot);
    setVoiceSessionLifecycleController(controller);
    controller.setCurrentUiContextToolSetEnabled(currentUiContextToolSetEnabledRef.current);
    currentUiContextToolSetSyncRef.current = {
      controller,
      enabled: currentUiContextToolSetEnabledRef.current,
    };
    controller.setConfiguredProviderId(providerId);
    return () => {
      if (currentUiContextToolSetSyncRef.current?.controller === controller) {
        currentUiContextToolSetSyncRef.current = null;
      }
      unsubscribe();
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
    const nextAuthority = createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope,
      agentConnectedServiceBindingAuthority:
        createConnectedServiceBindingAuthorityFingerprint({
          bindings: agentConnectedServicesBinding,
          connectedServices: connectedServices ?? [],
        }),
      connectedServiceCredentialRevisions,
      connectedServices,
      credentialBinding: voiceCredentialAuthority.credentialBinding,
      providerEnvelope: voiceCredentialAuthority.providerEnvelope,
      secrets,
    });
    const previousAuthority = credentialAuthorityRef.current;
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
    secrets,
  ]);

  return null;
}
