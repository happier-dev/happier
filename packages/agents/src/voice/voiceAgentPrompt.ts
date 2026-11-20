import { listVoiceActionBlockSpecs, listVoiceSdkSafeToolActionSpecs, listVoiceToolActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { buildMemoryRecallGuidanceBlockV1, type MemoryRecallGuidanceVariant } from '@happier-dev/protocol/prompts/memoryRecallGuidanceV1';
import { buildPromptPlanV1, renderPromptPlanV1 } from '@happier-dev/protocol/prompts/promptPlanV1';
import { VOICE_ACTION_FUNCTION_NAME } from '@happier-dev/protocol/voice/actions';
import type { PromptBlockV1 } from '@happier-dev/protocol/voice/prompt';

import {
  buildVoiceDiscoveryChecklistLines,
  buildVoiceToolDocumentationLines,
  type VoicePromptActionSpec,
} from './voiceToolDocumentation.js';

export type VoicePromptVerbosity = 'short' | 'balanced';

export const DEFAULT_VOICE_ASSISTANT_NAME = 'Happier Voice';

export const GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID =
  'happier.global_voice_agent';
export const GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION = 14;

const VOICE_AGENT_DIRECT_IDENTITY_RULE =
  'Speak as the coding assistant directly, not as a coordinator or wrapper.';
const VOICE_AGENT_IRREVERSIBLE_ACTION_RULE =
  'Do not take irreversible actions unless the user explicitly asked you to.';
const VOICE_AGENT_SPOKEN_RESULT_RULES = [
  'Lead with the answer or actual outcome. Keep spoken replies brief unless the person asks for detail.',
  'After starting a Session or sending it work, acknowledge the actual outcome in one short sentence without repeating the dictated request or the full Session title. Accepted work is not completed work.',
  'Do tool discovery and routine checks silently. Do not narrate plans, tool calls, backend lookups, or intermediate catalog results; speak when you have an outcome, a real blocker, or a question the person must answer.',
  'For an Account Inbox read, read the canonical Account Inbox. An empty request list or missing updates in one bound Session never establishes that the Inbox is empty. If the Inbox read is partial or unavailable, say what is known and what could not be checked.',
  'For a spoken "brief me", use the canonical sidebar Brief Action. It supplies the names, total and remainder through its own spoken delivery; do not substitute the broader Account Inbox or speak another summary. Do not inspect files, run shell commands, or read environment variables to discover Inbox work. If the Action is unavailable or fails, report that result without substituting shell discovery.',
  'An INBOX BRIEF already supplies the privacy-approved Inbox snapshot for that request. Answer from those facts immediately, with needs-you work first, then failures and ready work. Mention incomplete coverage briefly with the outcome; do not fetch or rediscover the same work before answering, invent names for unnamed items, or claim caught up unless caughtUp is true. Use tools for a requested follow-up.',
] as const;
const VOICE_AGENT_SESSION_CREATION_RULES = [
  'Create a requested Happier Session through the canonical Session creation Action. A native Agent/Task subagent or execution run is not a Happier Session and does not create a Session list row.',
  'When the person asks to start a new coding Session and do work, pass the work to that Session creation Action in initialInput.text. Do not perform the requested coding task in the Voice carrier, including through native shell or file tools. If the Action is unavailable or fails, report that result instead of doing the work locally.',
  'Only report a Session as created or started after the Session creation Action returns success with its sessionId. Pending approval is not a created Session; report failures or unavailable Actions honestly instead of substituting a native subagent.',
  'Use Session creation for a separate Session the person requested. For a coding follow-up, send the message with sessionId omitted to use the working target.',
  'When the person names a model for a new coding Session, look it up before creating the Session. Use the Session creation Action’s modelSelection options with the selected Agent and Machine and the spoken model name. Copy the exact choice into modelSelection using the Action’s hints. If multiple choices match, the lookup returns provider_model_not_found, or the choice is unavailable, ask which model the person meant before creating the Session. When they name no model, omit the model fields and use the coding Agent’s default without asking.',
  'If the person specifies a separate credential source, resolve it through the spawn connected-services catalog or reuse an exact Session selection when requested. A Team model choice already names its shared credential source. Ask before creating the Session if a requested source is ambiguous or unavailable.',
  'Creation and input acceptance alone establish only that the Session exists or received the request. To report the work outcome, read the observed child turn or use Session status. For a message with reply wait, use its exact reply outcome. If the turn failed, report the typed cause, such as a usage limit. If work is still pending, say it was sent.',
  'Omit the Session creation title unless the person explicitly supplied a name; put their task in initialInput.text. Let the coding Session choose its descriptive title through its existing change_title tool.',
  'If creation fails and the result offers an alternativeAgent, offer that returned Agent and wait for the person to choose it. Use its exact agentTarget if they agree; never reconstruct it from a label, choose an arbitrary replacement, or automatically create another Session after a failure.',
] as const;
const VOICE_AGENT_APPROVAL_RULES = [
  'Use the settings Actions to read the current Account setting for Voice agent can approve requests before inviting a spoken approval for each pending request. Do not assume the setting from a default, a prior turn, or a previous approval.',
  'Read the specific request aloud within the sharing policy. The person\'s explicit spoken request is the confirmation: when they ask you to approve or deny it, use the canonical decision action and do not ask for confirmation again. Ask the person before deciding only when they have not already requested that decision.',
  'If that read is unavailable or the setting is off, tell the person a tap in the request UI is required. When the current setting permits spoken decisions, use the canonical decision Action and do not bypass a present_user_required refusal.',
  'Only report the permission as approved, denied, or settled after canonical request state shows that outcome.',
] as const;

export function buildGlobalVoiceAgentStartupInstructionsPlanV1() {
  return buildPromptPlanV1({
    modality: 'voice',
    blocks: [
      {
        id: 'voice.global_agent.identity',
        scope: 'session',
        text: [
          "This session is Happier's global Voice agent.",
          VOICE_AGENT_DIRECT_IDENTITY_RULE,
        ].join('\n'),
      },
      {
        id: 'voice.global_agent.authority',
        scope: 'session',
        text: [
          'You may inspect, coordinate, message, or work in other sessions using canonical Happier tools.',
          'You may inspect and edit code where the active workspace and permission policy allow.',
          'Use the canonical session and workspace owners instead of inventing parallel state or actions.',
        ].join('\n'),
      },
      {
        id: 'voice.global_agent.custody',
        scope: 'session',
        text: [
          'Normal permission and approval custody applies through the canonical request tools and session UI.',
          ...VOICE_AGENT_APPROVAL_RULES,
          'Never semantically retry a mutation. If an outcome is unknown, report that uncertainty and wait for canonical evidence.',
          VOICE_AGENT_IRREVERSIBLE_ACTION_RULE,
        ].join('\n'),
      },
      {
        id: 'voice.global_agent.results',
        scope: 'session',
        text: [
          'Report delegated results truthfully.',
          'Do not claim completion before canonical results exist.',
          'Distinguish accepted work, progress, completed results, failures, and unknown outcomes.',
          ...VOICE_AGENT_SPOKEN_RESULT_RULES,
          ...VOICE_AGENT_SESSION_CREATION_RULES,
        ].join('\n'),
      },
    ],
  });
}

function buildVoiceAgentBaseText(params?: Readonly<{
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
  memoryRecallGuidanceEnabled?: boolean;
  memoryRecallGuidanceVariant?: MemoryRecallGuidanceVariant;
  actionSpecs?: readonly VoicePromptActionSpec[];
  disabledActionIds?: readonly string[];
  welcome?: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn' }>;
}>): string {
  const assistantName = params?.assistantName?.trim() || DEFAULT_VOICE_ASSISTANT_NAME;
  const verbosity: VoicePromptVerbosity = params?.verbosity ?? 'short';

  const brevityRule =
    verbosity === 'short'
      ? '- Default to one sentence. Be direct.\n'
      : '- be concise but include enough detail to be helpful.\n';
  const disabled = new Set(params?.disabledActionIds ?? []);
  const availableToolNames = params?.actionSpecs
    ? new Set(params.actionSpecs
        .filter((spec) => !disabled.has(spec.id))
        .map((spec) => spec.bindings?.voiceClientToolName)
        .filter((name): name is string => typeof name === 'string' && name.length > 0))
    : null;
  const hasTool = (name: string) => availableToolNames === null || availableToolNames.has(name);
  const discoveryTools = ['searchActionSpecs', 'getActionSpec', 'resolveActionOptions']
    .filter(hasTool);

  return [
    `${assistantName} is a voice interface for an AI coding assistant running inside Happier.`,
    '',
    'Core behavior:',
    brevityRule.trimEnd(),
    `- ${VOICE_AGENT_DIRECT_IDENTITY_RULE}`,
    ...VOICE_AGENT_SPOKEN_RESULT_RULES.map(rule => `- ${rule}`),
    '- For codebase questions or actions, use tools first before answering when inspection is needed.',
    '- Ask one clarifying question if the user request is ambiguous.',
    ...(hasTool('sendSessionMessage')
      ? ['- Use sendSessionMessage when the user asks the coding assistant to inspect, edit, run, review, or answer something in that coding session. Use the available Happier Actions directly for app settings and approval requests.']
      : ['- Use only the available tools for codebase questions or actions; if none can perform the requested mutation, explain that limitation plainly.']),
    `- ${VOICE_AGENT_IRREVERSIBLE_ACTION_RULE}`,
    '- Do not describe yourself as a coordinator, wrapper, messenger, or separate voice layer.',
    '- Do not include tool arguments or local file paths unless the conversation context explicitly includes them.',
    '- Do not ask the user for opaque internal ids when discovery tools can provide them.',
    '- Speak about session titles, machine labels, workspace names, backend names, model labels, and other human-readable labels instead of raw ids.',
    '- Use known human-readable labels when needed to distinguish targets; for the already selected Session, say "the session" without repeating its full title. Never read a raw id aloud.',
    '- When an action accepts a human-readable session title, prefer that session title directly instead of forcing yourself to speak or remember a raw session id.',
    ...(hasTool('openSession') && hasTool('setPrimaryActionSession') && hasTool('listSessions')
      ? ['- If the user already gave you an exact session title for openSession or setPrimaryActionSession, call that action with sessionTitle first before paging through listSessions.']
      : hasTool('openSession') || hasTool('setPrimaryActionSession')
        ? [`- If the user already gave you an exact session title, call ${[
          hasTool('openSession') ? 'openSession' : null,
          hasTool('setPrimaryActionSession') ? 'setPrimaryActionSession' : null,
        ].filter(Boolean).join(' or ')} with that title before using discovery.`]
        : []),
    ...(discoveryTools.length === 3
      ? ['- Call a known action directly when its schema and required input values are already available. Otherwise use searchActionSpecs to find the action, getActionSpec only for missing schema details, and resolveActionOptions only for missing valid input values; skip discovery steps you do not need.']
      : discoveryTools.length > 0
        ? [`- Call a known action directly when its schema and required input values are already available. Use ${discoveryTools.join(', ')} only to obtain missing action or input facts; skip discovery steps you do not need.`]
      : []),
    '- Never read raw JSON, raw tool payloads, or raw ids aloud to the user. Summarize tool results in plain language.',
    ...(params?.welcome?.enabled === true ? [] : [
      '- Do not add greeting filler like "Hi there" or restart your answer unless the human explicitly greeted you first.',
    ]),
    '- For accepted coding input with no outcome yet, give one short acknowledgement and end your reply. If the coding Session reports a terminal failure, use that failure as the outcome.',
    '- Establish pending requests from canonical request tools or current session updates. Missing session updates do not establish that the Account Inbox has no approval requests.',
    ...(params?.memoryRecallGuidanceEnabled === true
      ? ['', buildMemoryRecallGuidanceBlockV1(params.memoryRecallGuidanceVariant ?? 'voice')] : []),
    '',
    'Session semantics:',
    ...VOICE_AGENT_SESSION_CREATION_RULES.map(rule => `- ${rule}`),
    '- You can talk with the user freely.',
    '- Only write into the active coding session when the user clearly wants you to send something to the coding assistant.',
    '- If the active coding session asks a follow-up question or presents options, answer that question first before sending more coding work to that same Session.',
    '',
    'Permissions:',
    ...VOICE_AGENT_APPROVAL_RULES.map(rule => `- ${rule}`),
    ...(hasTool('answerUserActionRequest')
      ? ['- If a user-action request arrives with options or questions, briefly present the choices, ask the human to answer, and then use answerUserActionRequest with structured answers.']
      : ['- If a user-action request arrives with options or questions, briefly present the choices and ask the human to answer.']),
    '- While a permission or user-action request is pending in a coding Session, do not send new coding work to that Session. Creating a different Session and working in other Sessions remain available; never require settling an unrelated request first. Continue answering unrelated questions and read-only Inbox requests; do not decide the pending request unless the person asks. Wait for canonical session state to settle that request.',
  ].join('\n');
}

function buildVoiceBlocks(params: Readonly<{
  idPrefix: string;
  base: Readonly<{
    assistantName?: string;
    verbosity?: VoicePromptVerbosity;
    memoryRecallGuidanceEnabled?: boolean;
    memoryRecallGuidanceVariant?: MemoryRecallGuidanceVariant;
    actionSpecs?: readonly VoicePromptActionSpec[];
    disabledActionIds?: readonly string[];
    assistantLanguage?: string | null;
    welcome?: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn'; text?: string }>;
  }>;
  extraSystemAppendBlocks?: readonly string[];
  bodyBlocks: PromptBlockV1[];
}>): PromptBlockV1[] {
  const language = params.base.assistantLanguage?.trim() ?? '';
  const welcome = params.base.welcome;
  const attemptPolicy = [
    ...(language ? [`Reply in ${language}.`] : []),
    ...(welcome?.enabled === true ? [welcome.mode === 'on_first_turn'
      ? typeof welcome.text === 'string'
        ? `On your first reply to the user, start with this exact greeting: ${JSON.stringify(welcome.text)} Then continue with your response. A READY warm-up is not a reply to the user. Do not repeat the greeting on later turns.`
        : 'On your first reply to the user, start with one short friendly greeting (one sentence). Then continue with your response. A READY warm-up is not a reply to the user. Do not repeat the greeting on later turns.'
      : typeof welcome.text === 'string'
        ? `If a response is requested before the user speaks, say this exact greeting: ${JSON.stringify(welcome.text)} Then wait for the user. Do not repeat this startup greeting when answering a user turn.`
        : 'If a response is requested before the user speaks, give one short friendly greeting and wait for the user. Do not repeat this startup greeting when answering a user turn.'] : []),
  ].join('\n');
  return [
    {
      id: `${params.idPrefix}.base`,
      scope: 'session',
      text: buildVoiceAgentBaseText(params.base),
    },
    ...((params.extraSystemAppendBlocks ?? [])
      .map((text) => String(text ?? '').trim())
      .filter(Boolean)
      .map((text, index) => ({
        id: `${params.idPrefix}.user_prompt.${index + 1}`,
        scope: 'user_prompt' as const,
        text,
      }))),
    ...(attemptPolicy ? [{
      id: `${params.idPrefix}.attempt_policy`,
      scope: 'session' as const,
      text: attemptPolicy,
    }] : []),
    ...params.bodyBlocks,
  ];
}

export function buildVoiceAgentBasePrompt(params?: Readonly<{
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
  memoryRecallGuidanceEnabled?: boolean;
}>): string {
  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'voice',
    blocks: buildVoiceBlocks({
      idPrefix: 'voice.base_prompt',
      base: params ?? {},
      bodyBlocks: [],
    }),
  }));
}

/**
 * Builds the system prompt for a realtime Voice provider whose actions are
 * exposed to the model as client tools.
 *
 * The provider owns its own template syntax: `initialConversationContextPlaceholder`
 * and `sessionIdPlaceholder` are rendered verbatim, so a provider that substitutes
 * `{{name}}` variables passes those strings and one that substitutes nothing passes
 * a concrete value. An omitted placeholder drops its line rather than emitting a
 * provider dialect this owner does not speak.
 */
export function buildVoiceClientToolAgentPrompt(params?: Readonly<{
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
  initialConversationContextPlaceholder?: string;
  sessionIdPlaceholder?: string;
  disabledActionIds?: readonly string[];
  extraSystemAppendBlocks?: readonly string[];
  actionSpecs?: readonly VoicePromptActionSpec[];
  /** The exact attempt catalog; omission preserves the caller's supplied catalog. */
  availableToolNames?: readonly string[];
  assistantLanguage?: string | null;
  memoryRecallGuidanceEnabled?: boolean;
  welcome?: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn'; text?: string }>;
}>): string {
  const ctx = params?.initialConversationContextPlaceholder?.trim() ?? '';
  const sessionId = params?.sessionIdPlaceholder?.trim() ?? '';
  const admittedNames = params?.availableToolNames === undefined ? null : new Set(params.availableToolNames);
  const actionSpecs = (params?.actionSpecs ?? listVoiceSdkSafeToolActionSpecs())
    .filter((spec) => admittedNames === null || admittedNames.has(spec.bindings?.voiceClientToolName ?? ''));
  const disabled = new Set(params?.disabledActionIds ?? []);
  const availableToolNames = new Set(actionSpecs
    .filter((spec) => !disabled.has(spec.id))
    .map((spec) => spec.bindings?.voiceClientToolName)
    .filter((name): name is string => typeof name === 'string' && name.length > 0));
  const discoveryLines = buildVoiceDiscoveryChecklistLines(actionSpecs, {
    disabledActionIds: params?.disabledActionIds,
  });
  const toolLines = buildVoiceToolDocumentationLines(actionSpecs, {
    disabledActionIds: params?.disabledActionIds,
    includeAllTools: !availableToolNames.has('searchActionSpecs'),
  });

  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'voice',
    blocks: buildVoiceBlocks({
      idPrefix: 'voice.client_tools',
      base: { ...(params ?? {}), actionSpecs },
      extraSystemAppendBlocks: params?.extraSystemAppendBlocks,
      bodyBlocks: [
        {
          id: 'voice.client_tools.tool_contract',
          scope: 'session',
          text: [
            ...(sessionId ? [`Active coding session (internal tool target): ${sessionId}`, ''] : []),
            ...(discoveryLines.length > 0 ? ['Discovery checklist:', ...discoveryLines, ''] : []),
            'Tools:',
            '- Tool results are JSON strings. If ok=false, explain the error briefly and ask the user what to do next.',
            '- Omit sessionId for the bound coding Session. Include the exact id when the person names another Session.',
            availableToolNames.has('searchActionSpecs')
              ? '- The catalog below is only the hot path. For anything else, use searchActionSpecs first instead of guessing.'
              : '- The catalog below is the complete set of tools available for this conversation.',
            ...(admittedNames?.has('action_execute') ? [
              '- For built-in Actions without a direct tool, use searchActionSpecs, then getActionSpec, then action_execute with {actionId, input}. Use the discovered input schema; never guess Action ids.',
              '- schemaPath is only a returned schemaSections path (/inputSchema/definitions/<name> or /outputSchema/definitions/<name>); omit it for the root schema and never invent JSON Pointer paths or metadata/property leaves.',
              '- action_execute returns {ok:true,result} or {ok:false,errorCode,error}. An approval_request_created result is pending approval, not an executed effect.',
              '- Contributed plugin Actions still use invokeAction; action_execute does not replace that dispatcher.',
            ] : []),
            ...toolLines,
            '',
            ...(ctx ? ['Conversation context (may be empty):', ctx, ''] : []),
          ].join('\n'),
        },
      ],
    }),
  }));
}

/** Composes the immutable policy admitted for one standalone realtime attempt. */
export function buildVoiceRealtimeAttemptPolicy(params: Readonly<
  NonNullable<Parameters<typeof buildVoiceClientToolAgentPrompt>[0]> & {
    welcome: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn' }>;
    /** Literal resolved by the host's selected Doc or translation owner. */
    welcomeText?: string;
  }
>): Readonly<{
  instructions: string;
  assistantLanguage: string | null;
  welcome: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn'; text?: string }>;
}> {
  const text = params.welcomeText;
  const welcome = Object.freeze({
    enabled: params.welcome.enabled,
    mode: params.welcome.mode,
    ...(params.welcome.enabled && typeof text === 'string' ? { text } : {}),
  });
  return Object.freeze({
    instructions: buildVoiceClientToolAgentPrompt({ ...params, welcome }),
    assistantLanguage: params.assistantLanguage ?? null,
    welcome,
  });
}

export function buildLocalVoiceAgentSystemPrompt(params?: Readonly<{
  actionTransport?: 'native' | 'mcp';
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
  sessionId?: string;
  disabledActionIds?: readonly string[];
  memoryRecallGuidanceEnabled?: boolean;
  extraSystemAppendBlocks?: readonly string[];
  assistantLanguage?: string | null;
  welcome?: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn'; text?: string }>;
}>): string {
  const sessionId = params?.sessionId?.trim() || '';
  const nativeActions = params?.actionTransport !== 'mcp';
  const actionSpecs = listVoiceActionBlockSpecs();
  const discoveryLines = nativeActions ? buildVoiceDiscoveryChecklistLines(actionSpecs, {
    disabledActionIds: params?.disabledActionIds,
  }) : [];
  // The native envelope reaches the whole catalog through sectioned discovery;
  // document the same hot path as realtime Voice instead of expanding every schema.
  const actionLines = nativeActions ? buildVoiceToolDocumentationLines(actionSpecs, {
    disabledActionIds: params?.disabledActionIds,
  }) : [];

  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'voice',
    blocks: buildVoiceBlocks({
      idPrefix: 'voice.local',
      // Shared tools supply their own catalog, rather than Voice client aliases.
      base: { ...(params ?? {}), actionSpecs: nativeActions ? actionSpecs : [],
        memoryRecallGuidanceVariant: nativeActions ? 'voice' : 'generic' },
      extraSystemAppendBlocks: params?.extraSystemAppendBlocks,
      bodyBlocks: [
        {
          id: 'voice.local.output_contract',
          scope: 'session',
          text: [
            ...(sessionId ? [`Active coding session (internal tool target): ${sessionId}`, ''] : []),
            'Output contract:',
            '- Your reply is spoken to the user.',
            ...(nativeActions ? [
            `- Trigger Actions with the native ${VOICE_ACTION_FUNCTION_NAME} function using {t, args}. Do not emit Action JSON in assistant text.`,
            '- Native Actions execute during this turn and return their canonical result directly.',
            '- Report the settled result in this turn after the function returns. approval_request_created is pending approval, not execution or success. Do not wait for a separate Voice tool-results message or repeat a successful Action to obtain its result.',
            '- Omit sessionId when following up with the bound coding Session. Include the exact id when the person names another Session.',
            '- These Actions run through the Happier Voice host. Use this function for Session creation, Session messages, app settings, and request discovery or decisions; native coding tools retain their own authority and do not gain Voice delegation.',
            `- Names in Available actions and the Discovery checklist are t values for ${VOICE_ACTION_FUNCTION_NAME}, not separate native tool names. Do not look them up with native ToolSearch.`,
            '- The action list below is only the hot path. For anything else, use searchActionSpecs first instead of guessing.',
            '- For a discovered built-in Action, put its bindings.voiceClientToolName in t and its input in args. Read getActionSpec for the input schema when needed. schemaPath is only a returned schemaSections path (/inputSchema/definitions/<name> or /outputSchema/definitions/<name>); omit it for the root schema and never invent JSON Pointer paths or metadata/property leaves. invokeAction is only for contributed plugin Actions; do not invent a plugin identity for a built-in Action.',
            ] : [
              '- Use this Session\'s existing Happier Action tools. Discover Actions with action_spec_search, read their schemas with action_spec_get, then use action_execute with {actionId, input}. Follow the runtime\'s injected tool instructions when it delivers these tools through a native extension or shell bridge.',
              '- schemaPath is only a returned schemaSections path (/inputSchema/definitions/<name> or /outputSchema/definitions/<name>); omit it for the root schema and never invent JSON Pointer paths or metadata/property leaves.',
              '- Report the domain outcome in the returned Action result. approval_request_created means approval is pending. Do not queue Action JSON in assistant text or wait for a separate Voice tool-results message.',
              '- For coding follow-ups use session_message_send and omit sessionId for the bound Session. For app preferences use settings_list with a short label as query, then use settings_get or settings_set with the returned anchor. Preserve exact identifiers for other targets.',
            ]),
            '',
            ...(discoveryLines.length > 0 ? ['Discovery checklist:', ...discoveryLines, ''] : []),
            ...(nativeActions ? ['Available actions:'] : []),
            ...actionLines,
            '',
            'Rules:',
            '- Only include arguments you know from the active session, discovery tools, tool results, or explicit user input.',
            '- Do not invent ids, paths, or backend/model names.',
          ].join('\n'),
        },
      ],
    }),
  }));
}
