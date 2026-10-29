import type { PreNormalizedActionSpec } from './definition.js';
import { AutomationConversationActionInputSchemasV1, AutomationConversationActionOutputSchemasV1, type AutomationConversationActionIdV1, AutomationEventActionInputSchemasV1, AutomationEventActionOutputSchemasV1, type AutomationEventActionIdV1 } from '../../automations/automationActionSpecsV1.js';


export const AUTOMATION_EVENT_ACTION_TITLES: Readonly<Record<AutomationEventActionIdV1, string>> = Object.freeze({
  'automation.event.sources.list': 'List Automation Event sources',
  'automation.event.admit': 'Admit Automation Event occurrence',
  'automation.event.source.status.report': 'Report Automation Event source status',
});

export function createAutomationEventActionSpec(actionId: AutomationEventActionIdV1): PreNormalizedActionSpec {
  const readOnly = actionId === 'automation.event.sources.list';
  return {
    id: actionId, executionPlacement: 'account', approval: { result: 'none' },
    title: AUTOMATION_EVENT_ACTION_TITLES[actionId],
    description: 'Read or update Event Automation state through the canonical Automation owner.',
    // Source telemetry records the admitted runtime's health, not a user
    // effect. Event admission retains its ordinary configurable confirmation.
    safety: readOnly || actionId === 'automation.event.source.status.report' ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: AutomationEventActionOutputSchemasV1[actionId],
    inputSchema: AutomationEventActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

export const AUTOMATION_CONVERSATION_ACTION_TITLES: Readonly<
  Record<AutomationConversationActionIdV1, string>
> = Object.freeze({
  'automation.conversation.targets.list': 'List Automation conversation targets',
  'automation.conversation.target.verify': 'Verify Automation conversation target',
  'automation.conversation.admit': 'Admit Automation conversation occurrence',
});

export function createAutomationConversationActionSpec(
  actionId: AutomationConversationActionIdV1,
): PreNormalizedActionSpec {
  const readOnly = actionId === 'automation.conversation.targets.list'
    || actionId === 'automation.conversation.target.verify';
  const description = actionId === 'automation.conversation.targets.list'
    ? 'List current selectable Automation conversation targets through the canonical Automation owner.'
    : readOnly
      ? 'Verify an Automation conversation target through the canonical Automation owner.'
      : 'Admit a conversation occurrence through the canonical Automation owner.';
  return {
    id: actionId, executionPlacement: 'account', approval: { result: 'none' },
    title: AUTOMATION_CONVERSATION_ACTION_TITLES[actionId],
    description,
    safety: readOnly ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: AutomationConversationActionOutputSchemasV1[actionId],
    inputSchema: AutomationConversationActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}
