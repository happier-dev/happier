import { z } from 'zod';
import { SecretStringSchema } from '../../encryption/secretSettings';
import { DEFAULT_ELEVENLABS_VOICE_ID } from '@/realtime/elevenlabs/defaults';
import { VoiceLocalSttSchema } from './voiceLocalSttSettings';
import { VoiceLocalTtsSchema } from './voiceLocalTtsSettings';

export const VoiceProviderIdSchema = z.enum([
  'off',
  'realtime_elevenlabs',
  'local_direct',
  'local_conversation',
]);

export type VoiceProviderId = z.infer<typeof VoiceProviderIdSchema>;

const VoicePrivacySchema = z.object({
  shareSessionSummary: z.boolean().default(true),
  shareRecentMessages: z.boolean().default(true),
  recentMessagesCount: z.number().int().min(0).max(50).default(3),
  shareToolNames: z.boolean().default(true),
  sharePermissionRequests: z.boolean().default(true),
  // Allow voice tools to list non-sensitive device inventory (recent workspaces, machines, servers).
  // When disabled, inventory/discovery voice tools should fail closed.
  shareDeviceInventory: z.boolean().default(true),
  // Privacy hardening: do not share file paths or tool arguments with voice providers by default.
  shareFilePaths: z.boolean().default(false),
  shareToolArgs: z.boolean().default(false),
});

const VoiceUiUpdatesSchema = z.object({
  activeSession: z.enum(['none', 'activity', 'summaries', 'snippets']).default('summaries'),
  otherSessions: z.enum(['none', 'activity', 'summaries', 'snippets']).default('activity'),
  snippetsMaxMessages: z.number().int().min(1).max(10).default(3),
  includeUserMessagesInSnippets: z.boolean().default(false),
  otherSessionsSnippetsMode: z.enum(['never', 'on_demand_only', 'auto']).default('on_demand_only'),
});

const VoiceUiSchema = z.object({
  scopeDefault: z.enum(['session', 'global']).default('global'),
  surfaceLocation: z.enum(['sidebar', 'session', 'auto']).default('auto'),
  activityFeedEnabled: z.boolean().default(false),
  activityFeedAutoExpandOnStart: z.boolean().default(false),
  updates: VoiceUiUpdatesSchema.default({}),
});

const VoiceRealtimeElevenLabsSchema = z.object({
  assistantLanguage: z.string().nullable().default(null),
  billingMode: z.enum(['happier', 'byo']).default('happier'),
  welcome: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['immediate', 'on_first_turn']).default('immediate'),
      templateId: z.string().nullable().default(null),
    })
    .default({ enabled: false, mode: 'immediate', templateId: null }),
  tts: z
    .object({
      voiceId: z.string().default(DEFAULT_ELEVENLABS_VOICE_ID),
      modelId: z.string().nullable().default(null),
      voiceSettings: z
        .object({
          stability: z.number().min(0).max(1).nullable().default(null),
          similarityBoost: z.number().min(0).max(1).nullable().default(null),
          style: z.number().min(0).max(1).nullable().default(null),
          useSpeakerBoost: z.boolean().nullable().default(null),
          speed: z.number().min(0.5).max(2).nullable().default(null),
        })
        .default({}),
    })
    .default({}),
  byo: z
    .object({
      agentId: z.string().nullable().default(null),
      apiKey: SecretStringSchema.nullable().default(null),
    })
    .default({ agentId: null, apiKey: null }),
});

const VoiceLocalConversationSchema = z.object({
  conversationMode: z.enum(['direct_session', 'agent']).default('direct_session'),
  stt: VoiceLocalSttSchema.default({}),
  tts: VoiceLocalTtsSchema.default({}),
  networkTimeoutMs: z.number().int().min(1000).max(60000).default(15000),
  handsFree: z
    .object({
      enabled: z.boolean().default(false),
      endpointing: z
        .object({
          silenceMs: z.number().int().min(0).max(5000).default(450),
          minSpeechMs: z.number().int().min(0).max(5000).default(120),
        })
        .default({}),
    })
    .default({ enabled: false, endpointing: { silenceMs: 450, minSpeechMs: 120 } }),
	  agent: z
	    .object({
	      backend: z.enum(['daemon', 'openai_compat']).default('daemon'),
	      agentSource: z.enum(['session', 'agent']).default('session'),
	      agentId: z.string().default('claude'),
	      permissionPolicy: z.enum(['no_tools', 'read_only']).default('read_only'),
	      idleTtlSeconds: z.number().int().min(60).max(21600).default(1800),
	      prewarmOnConnect: z.boolean().default(false),
	      resumabilityMode: z.enum(['replay', 'provider_resume']).default('replay'),
	      providerResume: z
	        .object({
	          fallbackToReplay: z.boolean().default(true),
	        })
	        .default({ fallbackToReplay: true }),
	      replay: z
	        .object({
	          strategy: z.enum(['recent_messages', 'summary_plus_recent']).default('recent_messages'),
	          recentMessagesCount: z.number().int().min(1).max(100).default(16),
	        })
	        .default({ strategy: 'recent_messages', recentMessagesCount: 16 }),
	      welcome: z
	        .object({
	          enabled: z.boolean().default(false),
	          mode: z.enum(['immediate', 'on_first_turn']).default('immediate'),
	          templateId: z.string().nullable().default(null),
	        })
	        .default({ enabled: false, mode: 'immediate', templateId: null }),
	      commitIsolation: z.boolean().default(false),
	      // Persist global voice agent conversation state for resumability across app reloads and daemon restarts.
	      transcript: z
	        .object({
	          persistenceMode: z.enum(['ephemeral', 'persistent']).default('ephemeral'),
	          epoch: z.number().int().min(0).default(0),
	        })
	        .default({}),
	      chatModelSource: z.enum(['session', 'custom']).default('custom'),
	      chatModelId: z.string().default('default'),
	      commitModelSource: z.enum(['chat', 'session', 'custom']).default('chat'),
	      commitModelId: z.string().default('default'),
	      openaiCompat: z
        .object({
          chatBaseUrl: z.string().nullable().default(null),
          chatApiKey: SecretStringSchema.nullable().default(null),
          chatModel: z.string().default('default'),
          commitModel: z.string().default('default'),
          temperature: z.number().min(0).max(2).default(0.4),
          maxTokens: z.number().int().nullable().default(null),
        })
        .default({}),
      verbosity: z.enum(['short', 'balanced']).default('short'),
    })
    .default({}),
	  streaming: z
	    .object({
      enabled: z.boolean().default(false),
      ttsEnabled: z.boolean().default(false),
      ttsChunkChars: z.number().int().min(32).max(2000).default(200),
	      // Turn streaming (daemon voice agent) read loop tuning. Defaults preserve current behavior.
	      turnReadPollIntervalMs: z.number().int().min(10).max(500).default(25),
      turnReadMaxEvents: z.number().int().min(1).max(256).default(64),
      // Total budget for a single streamed turn. When null, fallback to adapter networkTimeoutMs.
      turnStreamTimeoutMs: z.number().int().min(1000).max(60000).nullable().default(null),
    })
    .default({
      enabled: false,
      ttsEnabled: false,
      ttsChunkChars: 200,
      turnReadPollIntervalMs: 25,
      turnReadMaxEvents: 64,
      turnStreamTimeoutMs: null,
    }),
});

const VoiceLocalDirectSchema = z.object({
  stt: VoiceLocalSttSchema.default({}),
  tts: VoiceLocalTtsSchema.default({}),
  networkTimeoutMs: z.number().int().min(1000).max(60000).default(15000),
  handsFree: z
    .object({
      enabled: z.boolean().default(false),
      endpointing: z
        .object({
          silenceMs: z.number().int().min(0).max(5000).default(450),
          minSpeechMs: z.number().int().min(0).max(5000).default(120),
        })
        .default({}),
    })
    .default({ enabled: false, endpointing: { silenceMs: 450, minSpeechMs: 120 } }),
});

export const VoiceSettingsSchema = z.object({
  providerId: VoiceProviderIdSchema.default('realtime_elevenlabs'),
  assistantLanguage: z.string().nullable().default(null),
  ui: VoiceUiSchema.default({}),
  privacy: VoicePrivacySchema.default({}),
  adapters: z
    .object({
      realtime_elevenlabs: VoiceRealtimeElevenLabsSchema.default({}),
      local_direct: VoiceLocalDirectSchema.default({}),
      local_conversation: VoiceLocalConversationSchema.default({}),
    })
    .default({}),
});

export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

export const voiceSettingsDefaults: VoiceSettings = VoiceSettingsSchema.parse({});

// Tolerant parsing: keep valid sub-fields, drop invalid ones to defaults.
export function voiceSettingsParse(input: unknown): VoiceSettings {
  // Important: `voiceSettingsDefaults` contains nested objects. We must not shallow-clone and then
  // mutate nested fields, otherwise parsing can accidentally mutate global defaults.
  const base = VoiceSettingsSchema.parse({});
  if (!input || typeof input !== 'object') return base;

  const raw = input as Record<string, unknown>;

  const providerId = VoiceProviderIdSchema.safeParse(raw.providerId);
  if (providerId.success) base.providerId = providerId.data;

  const assistantLanguage = z.string().nullable().safeParse(raw.assistantLanguage);
  if (assistantLanguage.success) base.assistantLanguage = assistantLanguage.data;

  if (raw.ui && typeof raw.ui === 'object') {
    const u = raw.ui as Record<string, unknown>;

    const scopeDefault = z.enum(['session', 'global']).safeParse(u.scopeDefault);
    if (scopeDefault.success) base.ui.scopeDefault = scopeDefault.data;

    const surfaceLocation = z.enum(['sidebar', 'session', 'auto']).safeParse(u.surfaceLocation);
    if (surfaceLocation.success) base.ui.surfaceLocation = surfaceLocation.data;

    const activityFeedEnabled = z.boolean().safeParse(u.activityFeedEnabled);
    if (activityFeedEnabled.success) base.ui.activityFeedEnabled = activityFeedEnabled.data;

    const activityFeedAutoExpandOnStart = z.boolean().safeParse(u.activityFeedAutoExpandOnStart);
    if (activityFeedAutoExpandOnStart.success) base.ui.activityFeedAutoExpandOnStart = activityFeedAutoExpandOnStart.data;

    if (u.updates && typeof u.updates === 'object') {
      const upd = u.updates as Record<string, unknown>;
      const activeSession = z.enum(['none', 'activity', 'summaries', 'snippets']).safeParse(upd.activeSession);
      if (activeSession.success) base.ui.updates.activeSession = activeSession.data;

      const otherSessions = z.enum(['none', 'activity', 'summaries', 'snippets']).safeParse(upd.otherSessions);
      if (otherSessions.success) base.ui.updates.otherSessions = otherSessions.data;

      const snippetsMaxMessages = z.number().int().safeParse(upd.snippetsMaxMessages);
      if (snippetsMaxMessages.success) {
        base.ui.updates.snippetsMaxMessages = Math.max(1, Math.min(10, snippetsMaxMessages.data));
      }

      const includeUserMessagesInSnippets = z.boolean().safeParse(upd.includeUserMessagesInSnippets);
      if (includeUserMessagesInSnippets.success) {
        base.ui.updates.includeUserMessagesInSnippets = includeUserMessagesInSnippets.data;
      }

      const otherSessionsSnippetsMode = z.enum(['never', 'on_demand_only', 'auto']).safeParse(upd.otherSessionsSnippetsMode);
      if (otherSessionsSnippetsMode.success) {
        base.ui.updates.otherSessionsSnippetsMode = otherSessionsSnippetsMode.data;
      }
    }
  }

  // privacy
  if (raw.privacy && typeof raw.privacy === 'object') {
    const p = raw.privacy as Record<string, unknown>;
    const parseBool = (k: keyof VoiceSettings['privacy']) => z.boolean().safeParse(p[k as string]);
    const parseInt = (k: keyof VoiceSettings['privacy']) => z.number().int().safeParse(p[k as string]);

    const s1 = parseBool('shareSessionSummary');
    if (s1.success) base.privacy.shareSessionSummary = s1.data;
    const s2 = parseBool('shareRecentMessages');
    if (s2.success) base.privacy.shareRecentMessages = s2.data;
    const s3 = parseInt('recentMessagesCount');
    if (s3.success) {
      const clamped = Math.max(0, Math.min(50, s3.data));
      base.privacy.recentMessagesCount = clamped;
    }
    const s4 = parseBool('shareToolNames');
    if (s4.success) base.privacy.shareToolNames = s4.data;
    const s5 = parseBool('sharePermissionRequests');
    if (s5.success) base.privacy.sharePermissionRequests = s5.data;
    const s6 = parseBool('shareDeviceInventory');
    if (s6.success) base.privacy.shareDeviceInventory = s6.data;
    const s7 = parseBool('shareFilePaths');
    if (s7.success) base.privacy.shareFilePaths = s7.data;
    const s8 = parseBool('shareToolArgs');
    if (s8.success) base.privacy.shareToolArgs = s8.data;
  }

  // Privacy hardening: never allow sharing file paths or tool args over voice transport.
  // This is intentionally enforced even if a persisted config attempts to enable it.
  base.privacy.shareFilePaths = false;
  base.privacy.shareToolArgs = false;

  // Adapters: parse with zod so per-adapter invalid fields don't blow away everything.
  if (raw.adapters && typeof raw.adapters === 'object') {
    const a = raw.adapters as Record<string, unknown>;
    const rt = VoiceRealtimeElevenLabsSchema.safeParse(a.realtime_elevenlabs);
    if (rt.success) base.adapters.realtime_elevenlabs = rt.data;
    const ld = VoiceLocalDirectSchema.safeParse(a.local_direct);
    if (ld.success) base.adapters.local_direct = ld.data;
    const lc = VoiceLocalConversationSchema.safeParse(a.local_conversation);
    if (lc.success) base.adapters.local_conversation = lc.data;
  }

  return base;
}
