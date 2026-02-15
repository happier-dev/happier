import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { SecretString } from '@/sync/encryption/secretSettings';
import { t } from '@/text';
import { LocalVoiceSttGroup } from '@/voice/settings/panels/localStt/LocalVoiceSttGroup';
import { LocalVoiceTtsGroup } from '@/voice/settings/panels/localTts/LocalVoiceTtsGroup';

function normalizeSecretStringPromptInput(value: string | null): SecretString | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? { _isSecretValue: true, value: trimmed } : null;
}

export function LocalConversationSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<
    | null
    | 'conversationMode'
    | 'mediatorBackend'
    | 'mediatorAgentSource'
    | 'mediatorPermissionPolicy'
    | 'mediatorChatModelSource'
    | 'mediatorCommitModelSource'
    | 'mediatorVerbosity'
  >(null);

  const enabled = props.voice.providerId === 'local_conversation';
  if (!enabled) return null;

  const cfg = props.voice.adapters.local_conversation;

  const setCfg = (patch: Partial<typeof cfg>) => {
    props.setVoice({
      ...props.voice,
      adapters: {
        ...props.voice.adapters,
        local_conversation: { ...cfg, ...patch },
      },
    });
  };

  const setAgent = (patch: Partial<typeof cfg.agent>) => setCfg({ agent: { ...cfg.agent, ...patch } });
  const setStreaming = (patch: Partial<typeof cfg.streaming>) => setCfg({ streaming: { ...cfg.streaming, ...patch } });

  const sttProvider =
    typeof (cfg.stt as any)?.provider === 'string'
      ? ((cfg.stt as any).provider as any)
      : (cfg.stt as any)?.useDeviceStt === true
        ? 'device'
        : 'openai_compat';

  return (
    <>
      <ItemGroup title={t('settingsVoice.local.title')} footer={t('settingsVoice.local.footer')}>
        <DropdownMenu
          open={openMenu === 'conversationMode'}
          onOpenChange={(next) => setOpenMenu(next ? 'conversationMode' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.conversationMode}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.local.conversationMode')}
              subtitle={t('settingsVoice.local.conversationModeSubtitle')}
              detail={cfg.conversationMode === 'agent' ? 'Voice agent' : 'Direct to session'}
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'agent',
              title: 'Voice agent',
              subtitle: 'Talk to a separate voice agent and commit when ready.',
              icon: <Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'direct_session',
              title: 'Direct to session',
              subtitle: 'Send your speech directly into the session as messages.',
              icon: <Ionicons name="paper-plane-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setCfg({ conversationMode: id as any });
            setOpenMenu(null);
          }}
        />
      </ItemGroup>

      <LocalVoiceSttGroup
        cfgStt={cfg.stt}
        setStt={(next) => setCfg({ stt: next })}
        popoverBoundaryRef={props.popoverBoundaryRef}
      />

      {sttProvider === 'device' ? (
        <ItemGroup title="Hands-free">
          <Item
            title="Enable hands-free"
            rightElement={
              <Switch
                value={cfg.handsFree.enabled}
                onValueChange={(v) => setCfg({ handsFree: { ...cfg.handsFree, enabled: v } })}
              />
            }
          />
          <Item
            title="Silence (ms)"
            detail={String(cfg.handsFree.endpointing.silenceMs)}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt('Silence (ms)', undefined, {
                  inputType: 'numeric',
                  placeholder: String(cfg.handsFree.endpointing.silenceMs),
                });
                if (raw === null) return;
                const next = Number(String(raw).trim());
                if (!Number.isFinite(next)) return;
                setCfg({
                  handsFree: {
                    ...cfg.handsFree,
                    endpointing: {
                      ...cfg.handsFree.endpointing,
                      silenceMs: Math.max(0, Math.min(5000, Math.floor(next))),
                    },
                  },
                });
              })();
            }}
          />
          <Item
            title="Minimum speech (ms)"
            detail={String(cfg.handsFree.endpointing.minSpeechMs)}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt('Minimum speech (ms)', undefined, {
                  inputType: 'numeric',
                  placeholder: String(cfg.handsFree.endpointing.minSpeechMs),
                });
                if (raw === null) return;
                const next = Number(String(raw).trim());
                if (!Number.isFinite(next)) return;
                setCfg({
                  handsFree: {
                    ...cfg.handsFree,
                    endpointing: {
                      ...cfg.handsFree.endpointing,
                      minSpeechMs: Math.max(0, Math.min(5000, Math.floor(next))),
                    },
                  },
                });
              })();
            }}
          />
        </ItemGroup>
      ) : null}

      <LocalVoiceTtsGroup
        cfgTts={cfg.tts}
        setTts={(next) => setCfg({ tts: next })}
        networkTimeoutMs={cfg.networkTimeoutMs}
        popoverBoundaryRef={props.popoverBoundaryRef}
      />

      {cfg.conversationMode === 'agent' ? (
        <>
          <ItemGroup title="Voice agent">
        <DropdownMenu
          open={openMenu === 'mediatorBackend'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorBackend' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.backend}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.local.mediatorBackend')}
              subtitle={t('settingsVoice.local.mediatorBackendSubtitle')}
              detail={cfg.agent.backend === 'daemon' ? 'Daemon' : 'OpenAI-compatible HTTP'}
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'daemon',
              title: 'Daemon',
              subtitle: 'Use your local daemon as the agent backend.',
              icon: <Ionicons name="server-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'openai_compat',
              title: 'OpenAI-compatible HTTP',
              subtitle: 'Use a local OpenAI-compatible chat endpoint as the agent backend.',
              icon: <Ionicons name="cloud-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ backend: id as any });
            setOpenMenu(null);
          }}
        />
        <DropdownMenu
          open={openMenu === 'mediatorAgentSource'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorAgentSource' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.agentSource}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.local.mediatorAgentSource')}
              subtitle={t('settingsVoice.local.mediatorAgentSourceSubtitle')}
              detail={cfg.agent.agentSource === 'session' ? 'Follow session' : 'Fixed agent'}
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'session',
              title: 'Follow session',
              subtitle: 'Use the active session agent as the agent agent.',
              icon: <Ionicons name="swap-horizontal-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'agent',
              title: 'Fixed agent',
              subtitle: 'Use a specific agent id for the agent.',
              icon: <Ionicons name="person-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ agentSource: id as any });
            setOpenMenu(null);
          }}
        />
        {cfg.agent.agentSource === 'agent' ? (
          <Item
            title={t('settingsVoice.local.mediatorAgentId')}
            detail={String(cfg.agent.agentId)}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.mediatorAgentId'), t('settingsVoice.local.mediatorAgentIdSubtitle'), {
                  placeholder: String(cfg.agent.agentId),
                });
                if (raw === null) return;
                const next = String(raw).trim();
                if (!next) return;
                setAgent({ agentId: next });
              })();
            }}
          />
        ) : null}
        <DropdownMenu
          open={openMenu === 'mediatorPermissionPolicy'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorPermissionPolicy' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.permissionPolicy}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.local.mediatorPermissionPolicy')}
              subtitle={t('settingsVoice.local.mediatorPermissionPolicySubtitle')}
              detail={cfg.agent.permissionPolicy === 'read_only' ? 'Read-only' : 'No tools'}
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'read_only',
              title: 'Read-only',
              subtitle: 'Voice agent can see context, but cannot run tools.',
              icon: <Ionicons name="eye-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'no_tools',
              title: 'No tools',
              subtitle: 'Voice agent cannot run tools and should avoid tool requests.',
              icon: <Ionicons name="hand-left-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ permissionPolicy: id as any });
            setOpenMenu(null);
          }}
        />

        <DropdownMenu
          open={openMenu === 'mediatorChatModelSource'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorChatModelSource' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.chatModelSource}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.local.mediatorChatModelSource')}
              subtitle={t('settingsVoice.local.mediatorChatModelSourceSubtitle')}
              detail={cfg.agent.chatModelSource === 'session' ? 'Session' : 'Custom model'}
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'session',
              title: 'Session',
              subtitle: 'Use the session model configuration for agent chat.',
              icon: <Ionicons name="layers-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'custom',
              title: 'Custom model',
              subtitle: 'Override agent chat model id.',
              icon: <Ionicons name="options-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ chatModelSource: id as any });
            setOpenMenu(null);
          }}
        />
        {cfg.agent.chatModelSource === 'custom' ? (
          <Item
            title="Voice agent chat model id"
            detail={String(cfg.agent.chatModelId)}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt('Voice agent chat model id', 'Used when "Voice agent chat model source" is set to "Custom model".', {
                  placeholder: String(cfg.agent.chatModelId),
                });
                if (raw === null) return;
                const next = String(raw).trim();
                if (!next) return;
                setAgent({ chatModelId: next });
              })();
            }}
          />
        ) : null}
        <DropdownMenu
          open={openMenu === 'mediatorCommitModelSource'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorCommitModelSource' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.commitModelSource}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.local.mediatorCommitModelSource')}
              subtitle={t('settingsVoice.local.mediatorCommitModelSourceSubtitle')}
              detail={
                cfg.agent.commitModelSource === 'chat'
                  ? 'Same as chat'
                  : cfg.agent.commitModelSource === 'session'
                    ? 'Session'
                    : 'Custom model'
              }
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'chat',
              title: 'Same as chat',
              subtitle: 'Use the agent chat model for commits.',
              icon: <Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'session',
              title: 'Session',
              subtitle: 'Use the session model configuration for commits.',
              icon: <Ionicons name="layers-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'custom',
              title: 'Custom model',
              subtitle: 'Override agent commit model id.',
              icon: <Ionicons name="options-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ commitModelSource: id as any });
            setOpenMenu(null);
          }}
        />
        {cfg.agent.commitModelSource === 'custom' ? (
          <Item
            title="Voice agent commit model id"
            detail={String(cfg.agent.commitModelId)}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt('Voice agent commit model id', 'Used when "Voice agent commit model source" is set to "Custom model".', {
                  placeholder: String(cfg.agent.commitModelId),
                });
                if (raw === null) return;
                const next = String(raw).trim();
                if (!next) return;
                setAgent({ commitModelId: next });
              })();
            }}
          />
        ) : null}
        <Item
          title={t('settingsVoice.local.mediatorIdleTtl')}
          detail={String(cfg.agent.idleTtlSeconds)}
          onPress={() => {
            void (async () => {
              const raw = await Modal.prompt(t('settingsVoice.local.mediatorIdleTtlTitle'), t('settingsVoice.local.mediatorIdleTtlDescription'), {
                inputType: 'numeric',
                placeholder: String(cfg.agent.idleTtlSeconds),
              });
              if (raw === null) return;
              const next = Number(String(raw).trim());
              if (!Number.isFinite(next)) return;
              setAgent({ idleTtlSeconds: Math.max(60, Math.min(3600, Math.floor(next))) });
            })();
          }}
        />
        <DropdownMenu
          open={openMenu === 'mediatorVerbosity'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorVerbosity' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.verbosity}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          trigger={({ open, toggle }) => (
            <Item
              title={t('settingsVoice.local.mediatorVerbosity')}
              subtitle={t('settingsVoice.local.mediatorVerbositySubtitle')}
              detail={cfg.agent.verbosity === 'short' ? 'Short' : 'Balanced'}
              rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
              onPress={toggle}
              showChevron={false}
              selected={false}
            />
          )}
          items={[
            {
              id: 'short',
              title: 'Short',
              subtitle: 'Keep agent responses brief.',
              icon: <Ionicons name="remove-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'balanced',
              title: 'Balanced',
              subtitle: 'Allow slightly more detail when needed.',
              icon: <Ionicons name="reorder-two-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ verbosity: id as any });
            setOpenMenu(null);
          }}
        />
      </ItemGroup>

      {cfg.agent.backend === 'openai_compat' ? (
        <ItemGroup title="OpenAI-compatible HTTP">
          <Item
            title={t('settingsVoice.local.chatBaseUrl')}
            detail={cfg.agent.openaiCompat.chatBaseUrl ? String(cfg.agent.openaiCompat.chatBaseUrl) : t('settingsVoice.local.notSet')}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt(
                  t('settingsVoice.local.chatBaseUrlTitle'),
                  t('settingsVoice.local.chatBaseUrlDescription'),
                  { placeholder: cfg.agent.openaiCompat.chatBaseUrl ?? '' },
                );
                if (raw === null) return;
                setAgent({
                  openaiCompat: { ...cfg.agent.openaiCompat, chatBaseUrl: String(raw).trim() || null },
                });
              })();
            }}
          />
          <Item
            title={t('settingsVoice.local.chatApiKey')}
            detail={cfg.agent.openaiCompat.chatApiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.notSet')}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt(
                  t('settingsVoice.local.chatApiKeyTitle'),
                  t('settingsVoice.local.chatApiKeyDescription'),
                  {
                    inputType: 'secure-text',
                  },
                );
                if (raw === null) return;
                setAgent({
                  openaiCompat: { ...cfg.agent.openaiCompat, chatApiKey: normalizeSecretStringPromptInput(raw) },
                });
              })();
            }}
          />
          <Item
            title={t('settingsVoice.local.chatModel')}
            detail={String(cfg.agent.openaiCompat.chatModel)}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.chatModelTitle'), t('settingsVoice.local.chatModelDescription'), {
                  placeholder: String(cfg.agent.openaiCompat.chatModel),
                });
                if (raw === null) return;
                const next = String(raw).trim();
                if (!next) return;
                setAgent({ openaiCompat: { ...cfg.agent.openaiCompat, chatModel: next } });
              })();
            }}
          />
          <Item
            title={t('settingsVoice.local.commitModel')}
            detail={String(cfg.agent.openaiCompat.commitModel)}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.commitModelTitle'), t('settingsVoice.local.commitModelDescription'), {
                  placeholder: String(cfg.agent.openaiCompat.commitModel),
                });
                if (raw === null) return;
                const next = String(raw).trim();
                if (!next) return;
                setAgent({ openaiCompat: { ...cfg.agent.openaiCompat, commitModel: next } });
              })();
            }}
          />
          <Item
            title={t('settingsVoice.local.chatTemperature')}
            detail={String(cfg.agent.openaiCompat.temperature)}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.chatTemperatureTitle'), t('settingsVoice.local.chatTemperatureDescription'), {
                  placeholder: String(cfg.agent.openaiCompat.temperature),
                });
                if (raw === null) return;
                const next = Number(String(raw).trim());
                if (!Number.isFinite(next)) return;
                setAgent({ openaiCompat: { ...cfg.agent.openaiCompat, temperature: Math.max(0, Math.min(2, next)) } });
              })();
            }}
          />
          <Item
            title={t('settingsVoice.local.chatMaxTokens')}
            detail={
              cfg.agent.openaiCompat.maxTokens == null
                ? t('settingsVoice.local.chatMaxTokensUnlimited')
                : String(cfg.agent.openaiCompat.maxTokens)
            }
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.chatMaxTokensTitle'), t('settingsVoice.local.chatMaxTokensDescription'), {
                  placeholder: cfg.agent.openaiCompat.maxTokens == null ? '' : String(cfg.agent.openaiCompat.maxTokens),
                });
                if (raw === null) return;
                const trimmed = String(raw).trim();
                if (!trimmed) {
                  setAgent({ openaiCompat: { ...cfg.agent.openaiCompat, maxTokens: null } });
                  return;
                }
                const next = Number(trimmed);
                if (!Number.isFinite(next)) return;
                setAgent({ openaiCompat: { ...cfg.agent.openaiCompat, maxTokens: Math.max(1, Math.floor(next)) } });
              })();
            }}
          />
        </ItemGroup>
      ) : null}

          <ItemGroup title="Streaming">
        <Item
          title="Enable streaming"
          rightElement={<Switch value={cfg.streaming.enabled} onValueChange={(v) => setStreaming({ enabled: v })} />}
        />
        <Item
          title="Enable TTS streaming"
          rightElement={<Switch value={cfg.streaming.ttsEnabled} onValueChange={(v) => setStreaming({ ttsEnabled: v })} />}
        />
        <Item
          title="TTS chunk chars"
          detail={String(cfg.streaming.ttsChunkChars)}
          onPress={() => {
            void (async () => {
              const raw = await Modal.prompt(
                'TTS chunk chars',
                'How many characters to buffer before requesting the next TTS chunk (32–2000).',
                { inputType: 'numeric', placeholder: String(cfg.streaming.ttsChunkChars) },
              );
              if (raw === null) return;
              const next = Number(String(raw).trim());
              if (!Number.isFinite(next)) return;
              setStreaming({ ttsChunkChars: Math.max(32, Math.min(2000, Math.floor(next))) });
            })();
          }}
        />
      </ItemGroup>
        </>
      ) : null}

      <ItemGroup title="Network">
        <Item
          title="Network timeout (ms)"
          detail={String(cfg.networkTimeoutMs)}
          onPress={() => {
            void (async () => {
              const raw = await Modal.prompt('Network timeout (ms)', 'Timeout for requests to your endpoints (1000–60000).', {
                inputType: 'numeric',
                placeholder: String(cfg.networkTimeoutMs),
              });
              if (raw === null) return;
              const next = Number(String(raw).trim());
              if (!Number.isFinite(next)) return;
              setCfg({ networkTimeoutMs: Math.max(1000, Math.min(60000, Math.floor(next))) });
            })();
          }}
        />
      </ItemGroup>
    </>
  );
}
