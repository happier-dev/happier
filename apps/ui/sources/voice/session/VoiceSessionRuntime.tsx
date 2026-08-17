import * as React from 'react';
import { getSharedVoiceAudioSessionCoordinator } from '@happier-dev/audio-stream-native';
import {
  ConnectedServiceBindingsV1Schema,
  isConnectedServiceCredentialHealthStatusUsable,
  normalizeConnectedServiceCredentialHealthStatus,
} from '@happier-dev/protocol';

import { useActiveServerAccountScope, useProfile, useSetting } from '@/sync/domains/state/storage';
import { createBuiltinVoiceAdapterAssembly } from '@/voice/adapters/registerBuiltinVoiceAdapters';
import { resolveVoiceProviderIdForBindingScope } from '@/voice/settings/resolveVoiceProviderId';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

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

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

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

export function VoiceSessionRuntime(): React.ReactElement | null {
  const voice = useSetting('voice') as any;
  const canonicalVoice = useSetting('voiceSettingsV1');
  const secrets = useSetting('secrets');
  const profile = useProfile();
  const accountScope = useActiveServerAccountScope();
  const connectedServices = profile?.connectedServicesV2 ?? null;
  const connectedServiceCredentialRevisions = profile?.connectedServiceCredentialRevisionsV1 ?? null;
  useVoiceDiagnosticsRuntimeSync(voice);
  const canonicalVoiceSettings = voiceSettingsParse(canonicalVoice);
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
  const credentialAuthorityRef = React.useRef<VoiceCredentialRuntimeAuthoritySnapshot | null>(null);

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
    const nextAuthority = createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope,
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
    });
    const previousAuthority = credentialAuthorityRef.current;
    credentialAuthorityRef.current = nextAuthority;
    if (!previousAuthority) {
      return;
    }
    if (hasVoiceCredentialRuntimeAuthorityChanged(previousAuthority, nextAuthority)) {
      const accountScopeChanged =
        previousAuthority.accountScopeAuthority !== nextAuthority.accountScopeAuthority;
      const exactSessionAccountScopeChanged = exactSessionCredentialAuthority && accountScopeChanged;
      const globalBindingAuthorityChanged = exactSessionCredentialAuthority
        && previousAuthority.agentConnectedServiceBindingAuthority
          !== nextAuthority.agentConnectedServiceBindingAuthority;
      // This aggregate snapshot decides only whether a terminal auth failure
      // can be rearmed for a new Start. It is not ordinary-provider attempt
      // currentness: the account operation service owns that exact pre-mint
      // lease, and a minted OpenAI authority remains attempt-local. The
      // lifecycle owner maps a global binding change to its live session id.
      controllerRef.current?.rearmAfterCredentialAuthorityChange({
        exactSessionAccountScopeChanged,
        globalBindingAuthorityChanged,
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
