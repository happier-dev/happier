import { createHash } from 'node:crypto';
import { buildMemoryRecallGuidanceBlockV1 } from '@happier-dev/protocol/prompts/memoryRecallGuidanceV1';
import { describeActionForVoiceTool } from '@happier-dev/protocol/actions/actionVoiceToolSummary';
import { getActionDefinitionForCatalogSurface, resolveActionCatalogSurfaceProjection } from '@happier-dev/protocol/actions/actionCatalog';
import { describe, expect, it } from 'vitest';

import {
  listVoiceActionBlockSpecs,
  getActionSpec,
  isVoicePromptHotPathSpec,
  listVoiceSdkSafeToolActionSpecs,
  listVoiceToolActionSpecs,
  VOICE_TOOL_RESULTS_JSON_PREFIX,
  renderPromptPlanV1,
} from '@happier-dev/protocol';

import {
  GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
  GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
  buildVoiceClientToolAgentPrompt,
  buildVoiceRealtimeAttemptPolicy,
  buildGlobalVoiceAgentStartupInstructionsPlanV1,
  buildLocalVoiceAgentSystemPrompt,
} from './voiceAgentPrompt.js';

describe('voiceAgentPrompt', () => {
  it('documents only the shared hot path while the full catalog stays discoverable', () => {
    const catalog = listVoiceActionBlockSpecs();
    const prompt = buildLocalVoiceAgentSystemPrompt();
    const documented = prompt.slice(prompt.indexOf('Available actions:')).split('\n')
      .filter(line => /^- \w+: /.test(line));
    const hotPath = catalog.filter(isVoicePromptHotPathSpec);
    console.info(JSON.stringify({ catalogDescriptors: catalog.length, documentedDescriptors: documented.length,
      promptBytes: new TextEncoder().encode(prompt).byteLength }));
    expect(documented).toHaveLength(hotPath.length);
    expect(documented.length).toBeLessThan(catalog.length);
  });
  it('charges the native action index only for tool identifiers and one-line purposes', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt();
    const index = prompt.slice(prompt.indexOf('Available actions:\n') + 'Available actions:\n'.length,
      prompt.indexOf('\n\nRules:'));
    const expected = listVoiceActionBlockSpecs().filter(isVoicePromptHotPathSpec)
      .map(spec => `- ${spec.bindings?.voiceClientToolName}: ${describeActionForVoiceTool(spec).trim().replace(/\s+/g, ' ')}`)
      .join('\n');
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
    console.info(JSON.stringify({ nativePromptBytes: bytes(prompt), actionIndexBytes: bytes(index),
      purposeIndexBytes: bytes(expected) }));
    expect(bytes(index)).toBe(bytes(expected));
    expect(index).toBe(expected);
    expect(prompt).toContain('Read getActionSpec for the input schema when needed');
    const creation = getActionSpec('session.spawn_new');
    const input = JSON.parse(creation.examples!.voice!.argsExample!);
    expect(resolveActionCatalogSurfaceProjection(creation, 'voice').inputSchema.safeParse(input).success).toBe(true);
    expect(getActionDefinitionForCatalogSurface({ id: creation.id, surface: 'voice' })?.inputHints?.fields.length)
      .toBeGreaterThan(0);
    expect(input).toMatchObject({ initialInput: { text: expect.any(String) } });
    expect(input).not.toHaveProperty('agentTarget');
  });

  it('adds no prompt bytes when action field documentation or argument examples grow', () => {
    const spec = getActionSpec('session.spawn_new');
    const hints = spec.surfaceBindings?.voice?.inputHints ?? spec.inputHints;
    const expandedHints = { ...hints, fields: [
      ...hints.fields,
      ...hints.fields.map(field => ({ ...field, path: `additional.${field.path}` })),
    ] };
    const expanded = { ...spec, inputHints: { ...spec.inputHints, fields: expandedHints.fields },
      surfaceBindings: { ...spec.surfaceBindings, voice: { ...spec.surfaceBindings?.voice, inputHints: expandedHints } },
      examples: { ...spec.examples, voice: { argsExample: JSON.stringify({ additional: spec.examples?.voice?.argsExample }) } },
    };
    const before = buildVoiceClientToolAgentPrompt({ actionSpecs: [spec] });
    const after = buildVoiceClientToolAgentPrompt({ actionSpecs: [expanded] });
    expect(expandedHints.fields.length).toBeGreaterThan(hints.fields.length);
    expect(new TextEncoder().encode(after).byteLength).toBe(new TextEncoder().encode(before).byteLength);
  });

  it('distinguishes native subagents from created Happier Sessions in every Voice mode', () => {
    for (const prompt of [
      renderPromptPlanV1(buildGlobalVoiceAgentStartupInstructionsPlanV1()),
      buildLocalVoiceAgentSystemPrompt(),
      buildVoiceClientToolAgentPrompt(),
    ]) {
      expect(prompt).toContain('A native Agent/Task subagent or execution run is not a Happier Session');
      expect(prompt).toContain('Only report a Session as created after the Session creation Action returns success with its sessionId');
      expect(prompt).toContain('Omit the Session creation title unless the person explicitly supplied a name');
      expect(prompt).toContain('Let the coding Session choose its descriptive title through its existing change_title tool');
      expect(prompt).toContain('acknowledge the actual outcome in one short sentence');
      expect(prompt).toContain('Do not perform the requested coding task in the Voice carrier');
      expect(prompt).toContain('Do not inspect files, run shell commands, or read environment variables to discover Inbox work');
      expect(prompt).toContain('For a spoken "brief me", use the canonical sidebar Brief Action');
    }
    expect(buildLocalVoiceAgentSystemPrompt()).toContain('Do not look them up with native ToolSearch.');
  });

  it.each([
    ['native', () => buildLocalVoiceAgentSystemPrompt()],
    ['MCP', () => buildLocalVoiceAgentSystemPrompt({ actionTransport: 'mcp' })],
    ['realtime', () => buildVoiceClientToolAgentPrompt()],
    ['global', () => renderPromptPlanV1(buildGlobalVoiceAgentStartupInstructionsPlanV1())],
  ] as const)('requires spoken-label model recovery and observed child progress in %s', (_carrier, render) => {
    const prompt = render();
    expect(prompt).toContain('pass the name you heard in spokenModelName');
    expect(prompt).not.toContain('look it up before creating the Session');
    expect(prompt).not.toContain('When the person names a model, resolve it with listAgentModels');
    expect(prompt).not.toContain('When the person names a model, call resolveActionOptions');
    expect(prompt).toMatch(/provider_model_ambiguous.*provider_model_not_found.*details\.candidates.*submit the chosen label in spokenModelName.*needsModelPicker.*model picker on the device/);
    expect(prompt).toContain('Omit the model fields only when the person names no model');
    expect(prompt).toMatch(/session\.status\.get.*before claiming work is running, will run, or is done/);
  });

  it('documents Account settings and request discovery through the real admitted Voice catalog', () => {
    const specs = listVoiceToolActionSpecs();
    const tools = [
      'settings_list', 'settings_get', 'settings_set', 'settings_invoke',
      'approval_request_list', 'approval_request_get', 'approval_request_decide',
      'session_permission_respond',
    ];
    const prompt = buildVoiceClientToolAgentPrompt({ actionSpecs: specs,
      availableToolNames: [...specs.map(spec => spec.bindings!.voiceClientToolName!), 'action_execute'] });
    const documented = [...prompt.matchAll(/^- ([A-Za-z0-9_]+):/gm)].map(match => match[1]);
    expect(documented).toEqual(expect.arrayContaining(tools.filter(name => name !== 'settings_invoke')));
    const local = buildLocalVoiceAgentSystemPrompt({ sessionId: 's1' });
    // VOICE-TOOL-SIZE-1113: non-hot-path inputs are read through spec discovery.
    const hotPathNames = new Set(listVoiceActionBlockSpecs().filter(isVoicePromptHotPathSpec)
      .map(spec => spec.bindings?.voiceClientToolName));
    expect([...local.matchAll(/^- ([A-Za-z0-9_]+):/gm)].map(match => match[1]))
      .toEqual(expect.arrayContaining(tools.filter(name => hotPathNames.has(name))));
    for (const name of tools) expect(prompt).toContain(name);
    expect(prompt).toContain('action_execute');
    const disabled = buildVoiceClientToolAgentPrompt({ actionSpecs: specs,
      availableToolNames: specs.map(spec => spec.bindings!.voiceClientToolName!),
      disabledActionIds: ['approval.request.list', 'approval.request.get', 'approval.request.decide', 'settings.invoke'] });
    for (const name of ['approval_request_list', 'approval_request_get', 'approval_request_decide', 'settings_invoke']) {
      expect(disabled).not.toContain(`- ${name}:`);
    }
  });
  it('documents generic execution only when admitted alongside the realtime discovery catalog', () => {
    const input = { actionSpecs: listVoiceToolActionSpecs(), availableToolNames: ['searchActionSpecs', 'getActionSpec', 'action_execute'] };
    const prompt = buildVoiceClientToolAgentPrompt(input);
    expect(prompt).toContain('action_execute');
    expect(prompt).toContain('actionId');
    expect(prompt).toContain('schemaPath is only a returned schemaSections path');
    expect(prompt).toContain('never invent JSON Pointer paths or metadata/property leaves');
    expect(getActionSpec('action.spec.get').description).toContain('returned schemaPath of /inputSchema/definitions/<name>');
    expect(prompt).not.toContain('Call with sendSessionMessage');
    expect(buildVoiceClientToolAgentPrompt({ ...input, availableToolNames: ['readCurrentUiContext'] }))
      .not.toContain('action_execute');
  });
  it('uses the admitted memory decision for the existing recall guidance in both realtime builders', () => {
    const guidance = buildMemoryRecallGuidanceBlockV1('voice');
    for (const memoryRecallGuidanceEnabled of [true, false]) {
      const input = { memoryRecallGuidanceEnabled, welcome: { enabled: false, mode: 'immediate' as const } };
      const prompts = [buildVoiceClientToolAgentPrompt(input), buildVoiceRealtimeAttemptPolicy(input).instructions];
      for (const prompt of prompts) expect(prompt.includes(guidance)).toBe(memoryRecallGuidanceEnabled);
    }
  });
  it.each(['  Hello exactly as typed.\n\n', ' \n ', ''])('preserves the admitted literal in either welcome mode: %j', text => {
    for (const mode of ['immediate', 'on_first_turn'] as const) {
      const policy = buildVoiceRealtimeAttemptPolicy({ welcome: { enabled: true, mode }, welcomeText: text });
      expect(policy.welcome.text).toBe(text);
      expect(policy.instructions).toContain(JSON.stringify(text));
    }
  });

  it('admits a localized literal only when welcome is enabled in both policy and model instructions', () => {
    const input = {
      availableToolNames: ['readCurrentUiContext'],
      assistantLanguage: 'fr-FR',
      welcome: { enabled: true, mode: 'immediate' as const },
    };
    const text = 'Bonjour, je vous écoute — que souhaitez-vous faire ?';
    const policy = buildVoiceRealtimeAttemptPolicy({ ...input, welcomeText: text });
    expect(policy.welcome).toEqual({ ...input.welcome, text });
    expect(policy.assistantLanguage).toBe('fr-FR');
    expect(policy.instructions).toContain(JSON.stringify(text));
    expect(policy.instructions).toContain('wait for the user');
    expect(buildVoiceRealtimeAttemptPolicy(input).welcome).toEqual(input.welcome);
    expect(buildVoiceRealtimeAttemptPolicy(input).instructions).toBe(buildVoiceClientToolAgentPrompt(input));
    const welcome = { enabled: false, mode: 'immediate' as const };
    expect(buildVoiceRealtimeAttemptPolicy({ ...input, welcome, welcomeText: text }).welcome).toEqual(welcome);
    expect(buildVoiceRealtimeAttemptPolicy({ ...input, welcome, welcomeText: text }).instructions)
      .toBe(buildVoiceClientToolAgentPrompt({ ...input, welcome }));
  });

  it('composes attempt policy with only admitted tools, language, greeting and user prompt blocks', () => {
    const prompt = buildVoiceClientToolAgentPrompt({
      actionSpecs: listVoiceToolActionSpecs(),
      availableToolNames: ['readCurrentUiContext'],
      assistantLanguage: 'fr-FR',
      welcome: { enabled: true, mode: 'on_first_turn' },
      extraSystemAppendBlocks: ['Use the project terminology.'],
    });
    expect(prompt).toContain('readCurrentUiContext');
    expect(prompt).not.toContain('sendSessionMessage');
    expect(prompt).not.toContain('searchActionSpecs');
    expect(prompt).toContain('fr-FR');
    expect(prompt).toContain('On your first reply');
    expect(prompt).toContain('Use the project terminology.');
    expect(prompt).not.toContain('Do not add greeting filler');
    const noTools = buildVoiceClientToolAgentPrompt({
      availableToolNames: [], welcome: { enabled: false, mode: 'immediate' },
    });
    expect(noTools).not.toContain('readCurrentUiContext');
    expect(noTools).not.toContain('sendSessionMessage');
    expect(noTools).toContain('Do not add greeting filler');
  });

  it('pins the global Voice Agent startup-instruction identity, block order, and rendered digest', () => {
    const plan = buildGlobalVoiceAgentStartupInstructionsPlanV1();
    const rendered = renderPromptPlanV1(plan).normalize('NFC').replace(/\r\n/g, '\n');

    expect({
      id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
      revision: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
      blockIds: plan.blocks.map((block) => block.id),
      digest: createHash('sha256').update(rendered, 'utf8').digest('hex'),
    }).toEqual({
      id: 'happier.global_voice_agent',
      revision: 16,
      blockIds: [
        'voice.global_agent.identity',
        'voice.global_agent.authority',
        'voice.global_agent.custody',
        'voice.global_agent.results',
      ],
      digest: 'dede678fdc89c344693450fd6122612a064d002d7e200642afb73f2eda812ad3',
    });

    expect(rendered).toContain("Happier's global Voice agent");
    expect(rendered).toContain('canonical Happier tools');
    expect(rendered).toContain('read the current Account setting');
    expect(rendered).toContain('Never semantically retry a mutation');
    expect(rendered).toContain('Do not claim completion before canonical results exist');
    expect(rendered).not.toContain('sendSessionMessage');
    expect(rendered).not.toContain('{{');
  });

  it('requires current approval preference before each invitation to answer by voice', () => {
    const prompts = [
      renderPromptPlanV1(buildGlobalVoiceAgentStartupInstructionsPlanV1()),
      buildLocalVoiceAgentSystemPrompt({ sessionId: 's1' }),
      buildVoiceClientToolAgentPrompt({
        initialConversationContextPlaceholder: '{{initialConversationContext}}',
        sessionIdPlaceholder: '{{sessionId}}',
      }),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain('before inviting a spoken approval for each pending request');
      expect(prompt).toContain('read the current Account setting');
      expect(prompt).toContain('If that read is unavailable');
      expect(prompt).not.toContain('Voice agent can approve requests is enabled by default');
      expect(prompt).toContain('Read the specific request aloud within the sharing policy');
      expect(prompt).toContain("The person's explicit spoken request is the confirmation");
      expect(prompt).toContain('do not ask for confirmation again');
      expect(prompt).not.toContain('ask the person, and follow their answer before deciding');
      expect(prompt).toContain('a tap in the request UI is required');
      expect(prompt).toContain('do not bypass a present_user_required refusal');
      expect(prompt).toContain('Only report the permission as approved, denied, or settled after canonical request state shows that outcome');
    }
  });

  it('prioritizes discovery and hot-path tools in the client-tool prompt instead of inlining the full catalog', () => {
    const prompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(prompt).toContain('searchActionSpecs');
    expect(prompt).toContain('getActionSpec');
    expect(prompt).toContain('resolveActionOptions');
    expect(prompt).toContain('listMachines');
    const sdkSafeToolNames = new Set(listVoiceSdkSafeToolActionSpecs().map(
      (spec) => spec.bindings?.voiceClientToolName,
    ));
    for (const spec of listVoiceSdkSafeToolActionSpecs()) {
      expect(['none', 'read']).toContain(spec.sideEffectClass);
    }
    for (const spec of listVoiceToolActionSpecs()) {
      const toolName = spec.bindings?.voiceClientToolName;
      if (toolName && !sdkSafeToolNames.has(toolName)) expect(prompt).not.toContain(toolName);
    }
    expect(prompt).not.toContain('- memoryGetWindow:');
  });

  it('renders provider placeholders verbatim and speaks no provider template dialect of its own', () => {
    const neutral = buildVoiceClientToolAgentPrompt();

    // Action-spec examples legitimately carry their own `{{name}}` fill-ins, so the
    // discriminating check is that this owner emits neither placeholder-driven line
    // when the caller supplied no placeholder.
    expect(neutral).not.toContain('Conversation context');
    expect(neutral).not.toContain('Active coding session (internal tool target)');

    const templated = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '<<ctx>>',
      sessionIdPlaceholder: '<<sid>>',
    });

    expect(templated).toContain('Active coding session (internal tool target): <<sid>>');
    expect(templated).toContain('Conversation context (may be empty):\n<<ctx>>');
  });

  it('accepts a validator-neutral action projection for provider prompt rendering', () => {
    const prompt = buildVoiceClientToolAgentPrompt({
      actionSpecs: [{
        id: 'session.mode.set',
        title: 'Set session mode',
        bindings: { voiceClientToolName: 'setSessionMode' },
        inputHints: { fields: [] },
        prompting: { voiceHotPath: true },
      }],
    });

    expect(prompt).toContain('- setSessionMode:');
  });

  it('prioritizes discovery and hot-path actions in the local voice system prompt instead of inlining the full catalog', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });

    expect(prompt).not.toContain(VOICE_TOOL_RESULTS_JSON_PREFIX);
    expect(prompt).toContain('Report the settled result in this turn');
    expect(prompt).not.toContain('End the turn after queuing Actions');
    expect(prompt).toContain('happier_voice_action');
    expect(prompt).toContain('searchActionSpecs');
    expect(prompt).toContain('getActionSpec');
    expect(prompt).toContain('resolveActionOptions');
    expect(prompt).toContain('setSessionMode');
    expect(prompt).toContain('startPlan');
    expect(prompt).not.toContain('- memoryGetWindow:');
  });

  it('omits disabled voice action-block specs in the local voice system prompt', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
      disabledActionIds: ['review.start', 'settings.list'],
    });

    expect(prompt).not.toContain('- settings_list:');
    expect(prompt).toContain('- settings_get:');

    const review = listVoiceActionBlockSpecs().find((s) => s.id === 'review.start');
    const toolName = review?.bindings?.voiceClientToolName;
    if (typeof toolName === 'string' && toolName.trim().length > 0) {
      expect(prompt).not.toContain(toolName);
    }
  });

  it('keeps discovery workflows for complex voice tools with schemas available on demand', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });

    expect(prompt).toContain('startReview');
    expect(prompt).toContain('searchActionSpecs');
    expect(prompt).toContain('getActionSpec');
    expect(prompt).toContain('resolveActionOptions');
    expect([...prompt.matchAll(/^- spawnSession:/gm)]).toHaveLength(1);
    expect(prompt).toContain('listRecentPaths');
    expect(prompt).toContain('listAgentBackends');
    expect(prompt).not.toContain('- listAgentModels:');
    expect(prompt).toContain('Use listExecutionRuns before choosing runId internally');
    expect(prompt).toContain('Use getExecutionRun after choosing runId to inspect available actions before choosing actionId internally');
    expect(prompt).toContain('Use listSessions before choosing sessionId internally');
    expect(prompt).toContain('Use listMachines before choosing machineId internally');
  });

  it('includes the same discovery guidance in the client-tool voice prompt', () => {
    const prompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(prompt).toContain('listMachines');
    expect(prompt).not.toContain('listReviewEngines');
    expect(prompt).not.toContain('spawnSession');
    expect(prompt).not.toContain('spawnSessionPicker');
    expect(prompt).not.toContain('- listAgentModels:');
    expect(prompt).toContain('Use listExecutionRuns before choosing runId internally');
    expect(prompt).toContain('Use listSessions before choosing sessionId internally');
  });

  it('keeps memory workflows discoverable without inlining every long-tail tool schema', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });

    expect(prompt).not.toContain('- memoryGetWindow:');
    expect(prompt).toContain('Use memorySearch before calling memoryGetWindow');
    expect(prompt).toContain('Use listMachines before choosing machineId internally');
  });

  it('adds explicit recall guidance only when memory recall is enabled', () => {
    const withMemory = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
      memoryRecallGuidanceEnabled: true,
    });
    const withoutMemory = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
      memoryRecallGuidanceEnabled: false,
    });

    expect(withMemory).toContain('If the user asks what you remember from earlier conversations or decisions');
    expect(withMemory).toContain('use memorySearch first');
    expect(withMemory).toContain('use memoryGetWindow to verify the exact details');
    expect(withoutMemory).not.toContain('If the user asks what you remember from earlier conversations or decisions');
  });

  it('appends extra user prompt blocks to local and client-tool voice prompts', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
      extraSystemAppendBlocks: ['Voice stack block'],
    });
    const clientToolPrompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
      extraSystemAppendBlocks: ['Voice stack block'],
    });

    expect(localPrompt).toContain('Voice stack block');
    expect(localPrompt.indexOf('Voice stack block')).toBeGreaterThan(localPrompt.indexOf('Core behavior:'));
    expect(clientToolPrompt).toContain('Voice stack block');
    expect(clientToolPrompt.indexOf('Voice stack block')).toBeGreaterThan(clientToolPrompt.indexOf('Core behavior:'));
  });

  it('tells voice agents to use discovery tools instead of asking the user for opaque ids', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });
    const clientToolPrompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('Do not ask the user for opaque internal ids when discovery tools can provide them');
    expect(localPrompt).toContain('When an action accepts a human-readable session title, prefer that session title directly instead of forcing yourself to speak or remember a raw session id');
    expect(localPrompt).toContain('If the user already gave you an exact session title for openSession or setPrimaryActionSession, call that action with sessionTitle first before paging through listSessions');
    expect(localPrompt).toContain('Omit sessionId when following up with the bound coding Session');
    expect(localPrompt).toContain('Only include arguments you know from the active session');
    expect(localPrompt).toContain('Speak about session titles, machine labels, workspace names, backend names, model labels, and other human-readable labels instead of raw ids');
    expect(localPrompt).toContain('for the already selected Session, say "the session" without repeating its full title');

    expect(clientToolPrompt).toContain('Do not ask the user for opaque internal ids when discovery tools can provide them');
    expect(clientToolPrompt).toContain('When an action accepts a human-readable session title, prefer that session title directly instead of forcing yourself to speak or remember a raw session id');
    expect(clientToolPrompt).not.toContain('openSession');
    expect(clientToolPrompt).not.toContain('setPrimaryActionSession');
    expect(clientToolPrompt).toContain('Speak about session titles, machine labels, workspace names, backend names, model labels, and other human-readable labels instead of raw ids');
    expect(clientToolPrompt).toContain('for the already selected Session, say "the session" without repeating its full title');
  });

  it('tells voice agents to acknowledge accepted coding work once and report terminal failures', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });
    const clientToolPrompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('Use sendSessionMessage when the user asks the coding assistant');
    expect(localPrompt).toContain('give one short acknowledgement and end your reply');
    expect(localPrompt).toContain('If the coding Session reports a terminal failure, use that failure as the outcome');
    expect(localPrompt).toContain('Do not add greeting filler like "Hi there"');
    expect(localPrompt).toContain('Establish pending requests from canonical request tools or current session updates');
    expect(localPrompt).toContain('answerUserActionRequest');
    expect(clientToolPrompt).not.toContain('sendSessionMessage');
    expect(clientToolPrompt).toContain('give one short acknowledgement and end your reply');
    expect(clientToolPrompt).toContain('If the coding Session reports a terminal failure, use that failure as the outcome');
    expect(clientToolPrompt).toContain('Do not add greeting filler like "Hi there"');
    expect(clientToolPrompt).toContain('Establish pending requests from canonical request tools or current session updates');
    expect(clientToolPrompt).not.toContain('answerUserActionRequest');
  });

  it('keeps unrelated questions and Inbox reads available while a coding Session waits for a request decision', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });
    const clientToolPrompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    for (const prompt of [localPrompt, clientToolPrompt]) {
      expect(prompt).toContain('do not send new coding work to that Session');
      expect(prompt).toContain('Continue answering unrelated questions and read-only Inbox requests');
    }
  });

  it('tells voice agents to answer active coding-session questions or option prompts before sending more work', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });
    const clientToolPrompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('If the active coding session asks a follow-up question or presents options');
    expect(localPrompt).toContain('answer that question first');
    expect(localPrompt).toContain('before sending more coding work');
    expect(clientToolPrompt).toContain('If the active coding session asks a follow-up question or presents options');
    expect(clientToolPrompt).toContain('answer that question first');
  });

  it('tells voice agents to summarize tool results in plain language instead of reading raw JSON', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });
    const clientToolPrompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('Never read raw JSON, raw tool payloads, or raw ids aloud to the user');
    expect(localPrompt).toContain('Summarize tool results in plain language');
    expect(clientToolPrompt).toContain('Never read raw JSON, raw tool payloads, or raw ids aloud to the user');
    expect(clientToolPrompt).toContain('Summarize tool results in plain language');
  });

  it('tells voice agents to speak as the assistant directly and inspect with tools before answering codebase questions', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });
    const clientToolPrompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('Speak as the coding assistant directly');
    expect(localPrompt).toContain('For codebase questions or actions, use tools first before answering');
    expect(localPrompt).toContain('Do not describe yourself as a coordinator, wrapper, messenger, or separate voice layer');
    expect(clientToolPrompt).toContain('Speak as the coding assistant directly');
    expect(clientToolPrompt).toContain('For codebase questions or actions, use tools first before answering');
  });

  it('retains discovery guidance in the discovery checklist', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });
    const clientToolPrompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).toContain('Discovery checklist:');
    expect(localPrompt).toMatch(/Use listAgentBackends before choosing .*backendTargetKeys internally/);
    expect(localPrompt).toContain('Use listSessions before choosing sessionId internally');
    expect(localPrompt).toContain('If the exact session title is not in the first listSessions page, continue with its next cursor');
    expect(localPrompt).toContain('Use listRecentPaths instead of guessing raw paths');
    expect(localPrompt).toContain('Use the admitted Voice execution target when one is supplied');
    expect(localPrompt).toContain('When the person does not name a coding Agent, omit agentTarget so the host selects the canonical ready default');

    expect(clientToolPrompt).toContain('Discovery checklist:');
    expect(clientToolPrompt).toContain('Use listExecutionRuns before choosing runId internally');
    expect(clientToolPrompt).not.toContain('spawnSession');
    expect(clientToolPrompt).not.toContain('spawnSessionPicker');
  });

  it('keeps internal ids out of the headline prompt wording', () => {
    const localPrompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
    });
    const clientToolPrompt = buildVoiceClientToolAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    expect(localPrompt).not.toContain('Active sessionId:');
    expect(localPrompt).toContain('Active coding session (internal tool target)');

    expect(clientToolPrompt).not.toContain('Active sessionId (always use this for tool calls):');
    expect(clientToolPrompt).toContain('Active coding session (internal tool target)');
  });

  it('omits discovery steps that depend on unavailable tools', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      sessionId: 's1',
      disabledActionIds: ['session.spawn_new', 'workspaces.list_recent', 'paths.list_recent'],
    });

    expect(prompt).not.toContain('spawnSessionPicker');
    expect(prompt).not.toContain('- spawnSession:');
    expect(prompt).not.toContain('Use listRecentWorkspaces instead of guessing workspace ids');
    expect(prompt).not.toContain('Use listRecentPaths instead of guessing raw paths');
    expect(prompt).toContain('Call listAgentBackends first if you do not already know the backend name');
  });
});
