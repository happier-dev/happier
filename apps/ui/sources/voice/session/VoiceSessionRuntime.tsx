import * as React from 'react';
import { getSharedVoiceAudioSessionCoordinator } from '@happier-dev/audio-stream-native';
import {
  ConnectedServiceBindingsV1Schema,
  isConnectedServiceCredentialHealthStatusUsable,
  normalizeConnectedServiceCredentialHealthStatus,
} from '@happier-dev/protocol';

import { useActiveServerAccountScope, useProfile, useSetting } from '@/sync/domains/state/storage';
import { createBuiltinVoiceAdapterAssembly } from '@/voice/adapters/registerBuiltinVoiceAdapters';
import { resolveVoiceProviderIdFromSettings } from '@/voice/settings/resolveVoiceProviderId';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

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

function readVoiceCredentialAuthorityRefs(
  rawVoice: unknown,
  providerId: string | 'off' | null,
): Readonly<{
  credentialBinding: unknown;
  providerEnvelope: unknown;
}> {
  if (!rawVoice || typeof rawVoice !== 'object' || Array.isArray(rawVoice)) {
    return { credentialBinding: null, providerEnvelope: null };
  }
  const voiceRecord = rawVoice as Readonly<{
    credentialBindings?: unknown;
    providers?: unknown;
  }>;
  const credentialBinding = providerId && providerId !== 'off'
    && Array.isArray(voiceRecord.credentialBindings)
      ? voiceRecord.credentialBindings.find((candidate) => (
          candidate
          && typeof candidate === 'object'
          && !Array.isArray(candidate)
          && (candidate as Readonly<{ providerId?: unknown }>).providerId === providerId
        )) ?? null
      : null;
  const providers = voiceRecord.providers;
  const providerEnvelope = providerId && providerId !== 'off'
    && providers && typeof providers === 'object' && !Array.isArray(providers)
      ? (providers as Readonly<Record<string, unknown>>)[providerId] ?? null
      : null;
  return {
    credentialBinding,
    providerEnvelope,
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readAgentConnectedServiceBindingAuthority(
  providerEnvelope: unknown,
  connectedServices: unknown,
): string {
  const envelope = readRecord(providerEnvelope);
  const config = readRecord(envelope?.config);
  const bindings = config
    ? Object.values(config)
        .map((value) => ConnectedServiceBindingsV1Schema.safeParse(value))
        .find((result) => result.success)?.data ?? null
    : null;
  if (!bindings) return 'unbound';

  const services = Array.isArray(connectedServices) ? connectedServices : [];
  const authority = Object.entries(bindings.bindingsByServiceId)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([serviceId, binding]) => {
      if (binding.source === 'native') {
        return { serviceId, source: 'native' as const };
      }

      const service = services
        .map(readRecord)
        .find((candidate) => candidate?.serviceId === serviceId) ?? null;
      const profiles = Array.isArray(service?.profiles) ? service.profiles : [];
      const readProfileAuthority = (profileId: string | null) => {
        const profile = profileId
          ? profiles.map(readRecord).find((candidate) => candidate?.profileId === profileId) ?? null
          : null;
        return {
          profileId,
          usable: profile !== null
            && isConnectedServiceCredentialHealthStatusUsable(
              normalizeConnectedServiceCredentialHealthStatus(profile.status),
            ),
        };
      };

      if (binding.selection !== 'group') {
        return {
          serviceId,
          source: 'connected' as const,
          selection: 'profile' as const,
          ...readProfileAuthority(binding.profileId),
        };
      }

      const groups = Array.isArray(service?.groups) ? service.groups : [];
      const group = groups
        .map(readRecord)
        .find((candidate) => candidate?.groupId === binding.groupId) ?? null;
      const activeProfileId = typeof group?.activeProfileId === 'string'
        ? group.activeProfileId
        : null;
      return {
        serviceId,
        source: 'connected' as const,
        selection: 'group' as const,
        groupId: binding.groupId,
        boundProfileId: binding.profileId ?? null,
        generation: typeof group?.generation === 'number' && Number.isInteger(group.generation)
          ? group.generation
          : null,
        ...readProfileAuthority(activeProfileId),
      };
    });

  return stableJsonStringify(authority);
}

function readAccountScopeIdentity(
  accountScope: Readonly<{ serverId: string; accountId: string }> | null,
): string | null {
  return accountScope
    ? `${accountScope.serverId}\u0000${accountScope.accountId}`
    : null;
}

export function VoiceSessionRuntime(): React.ReactElement | null {
  const voice = useSetting('voice') as any;
  const secrets = useSetting('secrets');
  const profile = useProfile();
  const accountScope = useActiveServerAccountScope();
  const connectedServices = profile?.connectedServicesV2 ?? null;
  const connectedServiceCredentialRevisions = profile?.connectedServiceCredentialRevisionsV1 ?? null;
  useVoiceDiagnosticsRuntimeSync(voice);
  const providerId = resolveVoiceProviderIdFromSettings(voiceSettingsParse(voice));
  const exactSessionCredentialAuthority = providerId !== null
    && resolveVoiceAdapterSurfaceCapabilities(providerId, voice)?.agentRuntime !== undefined;
  const voiceCredentialAuthority = readVoiceCredentialAuthorityRefs(voice, providerId);
  const controllerRef = React.useRef<ReturnType<typeof createVoiceSessionLifecycleController> | null>(null);
  const credentialAuthorityRef = React.useRef<Readonly<{
    accountScope: typeof accountScope;
    accountScopeIdentity: string | null;
    agentConnectedServiceBindingAuthority: string;
    connectedServiceCredentialRevisions: typeof connectedServiceCredentialRevisions;
    connectedServices: typeof connectedServices;
    credentialBinding: typeof voiceCredentialAuthority.credentialBinding;
    providerEnvelope: typeof voiceCredentialAuthority.providerEnvelope;
    secrets: typeof secrets;
  }> | null>(null);

  // Ensure adapters are registered before the user can interact with voice controls.
  React.useLayoutEffect(() => {
    const assembly = createBuiltinVoiceAdapterAssembly();
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
    controller.setConfiguredProviderId(providerId);
    return () => {
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
  }, []);

  React.useEffect(() => {
    controllerRef.current?.setConfiguredProviderId(providerId);
  }, [providerId]);

  React.useEffect(() => {
    const nextAuthority = {
      accountScope,
      accountScopeIdentity: readAccountScopeIdentity(accountScope),
      agentConnectedServiceBindingAuthority:
        readAgentConnectedServiceBindingAuthority(
          voiceCredentialAuthority.providerEnvelope,
          connectedServices,
        ),
      connectedServiceCredentialRevisions,
      connectedServices,
      credentialBinding: voiceCredentialAuthority.credentialBinding,
      providerEnvelope: voiceCredentialAuthority.providerEnvelope,
      secrets,
    };
    const previousAuthority = credentialAuthorityRef.current;
    credentialAuthorityRef.current = nextAuthority;
    if (!previousAuthority) {
      return;
    }
    if (
      previousAuthority.accountScope !== nextAuthority.accountScope
      || previousAuthority.connectedServiceCredentialRevisions !== nextAuthority.connectedServiceCredentialRevisions
      || previousAuthority.connectedServices !== nextAuthority.connectedServices
      || previousAuthority.credentialBinding !== nextAuthority.credentialBinding
      || previousAuthority.providerEnvelope !== nextAuthority.providerEnvelope
      || previousAuthority.secrets !== nextAuthority.secrets
    ) {
      const accountScopeChanged =
        previousAuthority.accountScopeIdentity !== nextAuthority.accountScopeIdentity;
      const globalBindingAuthorityChanged = (
        controllerRef.current?.getSnapshot().sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
        && previousAuthority.agentConnectedServiceBindingAuthority
          !== nextAuthority.agentConnectedServiceBindingAuthority
      );
      const fenceActive = exactSessionCredentialAuthority
        && (accountScopeChanged || globalBindingAuthorityChanged);
      controllerRef.current?.rearmAfterCredentialAuthorityChange({
        fenceActive,
      });
    }
  }, [
    accountScope,
    connectedServiceCredentialRevisions,
    connectedServices,
    exactSessionCredentialAuthority,
    voiceCredentialAuthority.credentialBinding,
    voiceCredentialAuthority.providerEnvelope,
    secrets,
  ]);

  return null;
}
